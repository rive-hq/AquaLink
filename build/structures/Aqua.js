'use strict'

const fs = require('node:fs')
const readline = require('node:readline')
const { EventEmitter } = require('tseep')

const Node = require('./Node')
const Player = require('./Player')
const Track = require('./Track')
const { version: pkgVersion } = require('../../package.json')

const SEARCH_PREFIX = ':'

const EMPTY_ARRAY = Object.freeze([])
const EMPTY_TRACKS_RESPONSE = Object.freeze({
  loadType: 'empty',
  exception: null,
  playlistInfo: null,
  pluginInfo: {},
  tracks: EMPTY_ARRAY
})

const DEFAULT_OPTIONS = Object.freeze({
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: true,
  restVersion: 'v4',
  plugins: [],
  autoResume: false,
  infiniteReconnects: false,
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  })
})

const CLEANUP_INTERVAL = 60000
const MAX_CONCURRENT_OPS = 4
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000
const NODE_BATCH_SIZE = 3
const PLAYER_BATCH_SIZE = 8
const SEEK_DELAY = 150
const RECONNECT_DELAY = 800
const CACHE_VALID_TIME = 5000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const isProbablyUrl = s => typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://'))

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super()
    if (!client) throw new Error('Client is required')
    if (!Array.isArray(nodes) || !nodes.length) throw new TypeError('Nodes must be non-empty Array')

    this.client = client
    this.nodes = nodes
    this.nodeMap = new Map()
    this.players = new Map()
    this.clientId = null
    this.initiated = false
    this.version = pkgVersion

    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.failoverOptions = { ...DEFAULT_OPTIONS.failoverOptions, ...options.failoverOptions }

    this._defaultSend = packet => {
      const guildId = packet?.d?.guild_id
      const guild = this.client.cache?.guilds?.get?.(guildId) ?? this.client.guilds?.cache?.get?.(guildId)
      if (!guildId || !guild) return

      const gateway = this.client.gateway
      if (gateway?.send) {
        gateway.send(gateway.calculateShardId(guildId), packet)
      } else if (guild.shard?.send) {
        guild.shard.send(packet)
      }
    }

    Object.assign(this, {
      shouldDeleteMessage: this.options.shouldDeleteMessage,
      defaultSearchPlatform: this.options.defaultSearchPlatform,
      leaveOnEnd: this.options.leaveOnEnd,
      restVersion: this.options.restVersion,
      plugins: this.options.plugins,
      autoResume: this.options.autoResume,
      infiniteReconnects: this.options.infiniteReconnects,
      send: this.options.send || this._defaultSend
    })

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()

    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0

    this._bindEventHandlers()
    this._startCleanupTimer()
  }

  _bindEventHandlers() {
    this.on('nodeConnect', node => this.autoResume && queueMicrotask(() => this._rebuildBrokenPlayers(node)))
    this.on('nodeDisconnect', node => this.autoResume && queueMicrotask(() => this._storeBrokenPlayers(node)))
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => this._performCleanup(), CLEANUP_INTERVAL)
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref()
  }

  get leastUsedNodes() {
    const now = Date.now()
    if (this._leastUsedNodesCache && (now - this._leastUsedNodesCacheTime) < CACHE_VALID_TIME) {
      return this._leastUsedNodesCache
    }

    const connectedNodes = Array.from(this.nodeMap.values()).filter(n => n.connected)
    connectedNodes.sort((a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0))

    this._leastUsedNodesCache = connectedNodes
    this._leastUsedNodesCacheTime = now
    return connectedNodes
  }

  async init(clientId) {
    if (this.initiated) return this
    this.clientId = clientId
    let successCount = 0

    for (let i = 0; i < this.nodes.length; i += NODE_BATCH_SIZE) {
      const batch = this.nodes.slice(i, i + NODE_BATCH_SIZE)
      successCount += await this._processNodeBatch(batch)
    }

    if (!successCount) throw new Error('No nodes connected')

    await this._loadPlugins()
    this.initiated = true
    return this
  }

  async _processNodeBatch(batch) {
    const results = await Promise.allSettled(batch.map(n => this._createNode(n)))
    return results.filter(r => r.status === 'fulfilled').length
  }

  async _loadPlugins() {
    await Promise.all(
      this.plugins.map(plugin =>
        plugin.load(this).catch(err =>
          this.emit('error', null, new Error(`Plugin error: ${err?.message || String(err)}`))
        )
      )
    )
  }

  async _createNode(options) {
    const nodeId = options.name || options.host
    this._destroyNode(nodeId)

    const node = new Node(this, options, this.options)
    node.players = new Set()

    this.nodeMap.set(nodeId, node)
    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })

    try {
      node.connect()
      this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false })
      this.emit('nodeCreate', node)
      return node
    } catch (error) {
      this._cleanupNode(nodeId)
      throw error
    }
  }

  _storeBrokenPlayers(node) {
    const nodeId = node.name || node.host
    const now = Date.now()

    for (const player of this.players.values()) {
      if (player.nodes !== node) continue
      const state = this._capturePlayerState(player)
      if (state) {
        state.originalNodeId = nodeId
        state.brokenAt = now
        this._brokenPlayers.set(player.guildId, state)
      }
    }
  }

  async _rebuildBrokenPlayers(node) {
    const nodeId = node.name || node.host
    let rebuiltCount = 0
    const toDelete = []

    const promises = []
    for (const [guildId, brokenState] of this._brokenPlayers) {
      if (brokenState.originalNodeId !== nodeId) continue

      promises.push(
        this._rebuildPlayer(brokenState, node)
          .then(() => {
            toDelete.push(guildId)
            rebuiltCount++
          })
          .catch(() => {
            if (Date.now() - brokenState.brokenAt > BROKEN_PLAYER_TTL) {
              toDelete.push(guildId)
            }
          })
      )
    }

    await Promise.all(promises)

    for (const guildId of toDelete) {
      this._brokenPlayers.delete(guildId)
    }

    if (rebuiltCount) this.emit('playersRebuilt', node, rebuiltCount)
  }

  async _rebuildPlayer(brokenState, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState
    const existingPlayer = this.players.get(guildId)
    if (existingPlayer?.destroy) await existingPlayer.destroy()

    await delay(RECONNECT_DELAY)

    try {
      const player = await this.createConnection({
        guildId,
        textChannel,
        voiceChannel,
        defaultVolume: volume,
        deaf
      })

      if (current) {
        await player.queue.add(current)
        await player.play()
        if (brokenState.position > 0) {
          setTimeout(() => player.seek(brokenState.position), SEEK_DELAY)
        }
        if (brokenState.paused && typeof player.pause === 'function') {
          await player.pause(true)
        }
        this.emit('trackStart', player, current)
      }
    } catch {
      this._brokenPlayers.delete(guildId)
    }
  }

  _destroyNode(identifier) {
    const node = this.nodeMap.get(identifier)
    if (node) {
      this._cleanupNode(identifier)
      this.emit('nodeDestroy', node)
    }
  }

  _cleanupNode(nodeId) {
    const node = this.nodeMap.get(nodeId)
    if (node) {
      node.removeAllListeners?.()
      this.nodeMap.delete(nodeId)
    }
    this._nodeStates.delete(nodeId)
    this._failoverQueue.delete(nodeId)
    this._lastFailoverAttempt.delete(nodeId)
    this._invalidateCache()
  }

  _invalidateCache() {
    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
  }

  async handleNodeFailover(failedNode) {
    if (!this.failoverOptions.enabled) return

    const nodeId = failedNode.name || failedNode.host
    const now = Date.now()
    const nodeState = this._nodeStates.get(nodeId)
    if (nodeState?.failoverInProgress) return

    const lastAttempt = this._lastFailoverAttempt.get(nodeId)
    if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return

    const attempts = this._failoverQueue.get(nodeId) || 0
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return

    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: true })
    this._lastFailoverAttempt.set(nodeId, now)
    this._failoverQueue.set(nodeId, attempts + 1)

    try {
      this.emit('nodeFailover', failedNode)
      const affectedPlayers = [...failedNode.players]

      if (!affectedPlayers.length) {
        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
        return
      }

      const availableNodes = this._getAvailableNodes(failedNode)
      if (!availableNodes.length) {
        this.emit('error', null, new Error('No failover nodes available'))
        return
      }

      const results = await this._migratePlayersOptimized(affectedPlayers, availableNodes)
      const successful = results.filter(r => r.success).length

      if (successful) {
        this.emit('nodeFailoverComplete', failedNode, successful, results.length - successful)
      }
    } catch (error) {
      this.emit('error', null, new Error(`Failover failed: ${error?.message || String(error)}`))
    } finally {
      this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
    }
  }

  async _migratePlayersOptimized(players, availableNodes) {
    const results = []
    for (let i = 0; i < players.length; i += MAX_CONCURRENT_OPS) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPS)
      const batchResults = await Promise.allSettled(
        batch.map(p => this._migratePlayer(p, availableNodes))
      )
      results.push(...batchResults.map(r => ({
        success: r.status === 'fulfilled',
        error: r.status === 'rejected' ? r.reason : null
      })))
    }
    return results
  }

  async _migratePlayer(player, availableNodes) {
    let retryCount = 0
    while (retryCount < this.failoverOptions.maxRetries) {
      try {
        const rotated = availableNodes[retryCount % availableNodes.length]
        const targetNode = this._chooseLeastBusyNode([rotated, ...availableNodes])

        const playerState = this._capturePlayerState(player)
        if (!playerState) throw new Error('Failed to capture state')

        const newPlayer = await this._createPlayerOnNode(targetNode, playerState)
        await this._restorePlayerState(newPlayer, playerState)
        this.emit('playerMigrated', player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        retryCount++
        if (retryCount >= this.failoverOptions.maxRetries) throw error
        await delay(this.failoverOptions.retryDelay)
      }
    }
  }

  _capturePlayerState(player) {
    try {
      return {
        guildId: player.guildId,
        textChannel: player.textChannel,
        voiceChannel: player.voiceChannel,
        volume: typeof player.volume === 'number' ? player.volume : 100,
        paused: !!player.paused,
        position: player.position || 0,
        current: player.current || null,
        queue: player.queue?.tracks?.slice(0, 10) || EMPTY_ARRAY,
        repeat: player.loop,
        shuffle: player.shuffle,
        deaf: !!player.deaf,
        connected: !!player.connected
      }
    } catch {
      return null
    }
  }

  async _createPlayerOnNode(targetNode, playerState) {
    return this.createPlayer(targetNode, {
      guildId: playerState.guildId,
      textChannel: playerState.textChannel,
      voiceChannel: playerState.voiceChannel,
      defaultVolume: playerState.volume || 100,
      deaf: playerState.deaf || false
    })
  }

  async _restorePlayerState(newPlayer, playerState) {
    if (typeof playerState.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function') newPlayer.setVolume(playerState.volume)
      else newPlayer.volume = playerState.volume
    }

    if (playerState.queue?.length) {
      if (typeof newPlayer.queue?.add === 'function') {
        newPlayer.queue.add(...playerState.queue)
      } else if (Array.isArray(newPlayer.queue?.tracks)) {
        newPlayer.queue.tracks.push(...playerState.queue)
      }
    }

    if (playerState.current && this.failoverOptions.preservePosition) {
      if (typeof newPlayer.queue?.add === 'function') {
        try {
          newPlayer.queue.add(playerState.current, { index: 0 })
        } catch {
          newPlayer.queue.unshift?.(playerState.current)
          newPlayer.queue.tracks?.unshift?.(playerState.current)
        }
      } else if (Array.isArray(newPlayer.queue?.tracks)) {
        newPlayer.queue.tracks.unshift(playerState.current)
      }

      if (this.failoverOptions.resumePlayback) {
        if (typeof newPlayer.play === 'function') await newPlayer.play()
        if (playerState.position > 0 && typeof newPlayer.seek === 'function') {
          setTimeout(() => newPlayer.seek(playerState.position), SEEK_DELAY)
        }
        if (playerState.paused && typeof newPlayer.pause === 'function') {
          await newPlayer.pause(true)
        }
      }
    }

    newPlayer.repeat = playerState.repeat
    newPlayer.shuffle = playerState.shuffle
  }

  _cleanupPlayer(player) {
    if (!player) return
    try {
      player.destroy?.()
    } catch {}
  }

  updateVoiceState({ d, t }) {
    if (!d?.guild_id || (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')) return

    const player = this.players.get(d.guild_id)
    if (!player) return

    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return
      if (!d.channel_id) return this._cleanupPlayer(player)

      if (player.connection && !player.connection.sessionId && d.session_id) {
        player.connection.sessionId = d.session_id
        return
      }

      if (player.connection && d.session_id && player.connection.sessionId !== d.session_id) {
        player.connection.sessionId = d.session_id
        this.emit('debug', `[Player ${player.guildId}] Session updated to ${d.session_id}`)
      }

      player.connection?.setStateUpdate(d)
    } else {
      player.connection?.setServerUpdate(d)
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes

    const lowerRegion = String(region).toLowerCase()
    const filtered = Array.from(this.nodeMap.values())
      .filter(node => node.connected && node.regions?.includes(lowerRegion))
      .sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b))

    return filtered
  }

  _getNodeLoad(node) {
    const stats = node?.stats?.cpu
    return stats ? (stats.systemLoad / Math.max(1, stats.cores)) * 100 : 0
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized')

    const existingPlayer = this.players.get(options.guildId)
    if (existingPlayer?.voiceChannel) return existingPlayer

    const candidateNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes
    if (!candidateNodes.length) throw new Error('No nodes available')

    const node = this._chooseLeastBusyNode(candidateNodes)
    return this.createPlayer(node, options)
  }

  createPlayer(node, options) {
    this.destroyPlayer(options.guildId)

    const player = new Player(this, node, options)
    this.players.set(options.guildId, player)
    player.once('destroy', this._handlePlayerDestroy.bind(this))
    player.connect(options)
    this.emit('playerCreate', player)
    return player
  }

  _handlePlayerDestroy(player) {
    const node = player.nodes
    node?.players?.delete(player)
    if (this.players.get(player.guildId) === player) {
      this.players.delete(player.guildId)
    }
    this.emit('playerDestroy', player)
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId)
    if (!player) return

    try {
      if (typeof player.destroy === 'function') {
        await player.destroy()
        return
      }
      await player.clearData?.()
    } catch {
    } finally {
      player.removeAllListeners?.()
      if (this.players.get(guildId) === player) {
        this.players.delete(guildId)
        this.emit('playerDestroy', player)
      }
    }
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')

    const requestNode = this._getRequestNode(nodes)
    const formattedQuery = isProbablyUrl(query) ? query : `${source}${SEARCH_PREFIX}${query}`

    try {
      const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`
      const response = await requestNode.rest.makeRequest('GET', endpoint)

      if (response.loadType === 'empty' || response.loadType === 'NO_MATCHES') {
        return EMPTY_TRACKS_RESPONSE
      }

      return this._constructResponse(response, requester, requestNode)
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? 'Request timeout' : `Resolve failed: ${error?.message || String(error)}`)
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this._chooseLeastBusyNode(this.leastUsedNodes)

    if (nodes instanceof Node) return nodes

    if (Array.isArray(nodes)) {
      const candidates = nodes.filter(n => n && n.connected)
      return this._chooseLeastBusyNode(candidates.length ? candidates : this.leastUsedNodes)
    }

    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      return (node && node.connected) ? node : this._chooseLeastBusyNode(this.leastUsedNodes)
    }

    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes || !nodes.length) return null
    let best = nodes[0]
    let bestScore = Number.POSITIVE_INFINITY
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const cpu = n?.stats?.cpu
      const cpuLoad = cpu ? (cpu.systemLoad / Math.max(1, cpu.cores)) : 0
      const playing = n?.stats?.playingPlayers || 0
      const calls = n?.rest?.calls || 0
      const score = cpuLoad + (playing * 0.5) + (calls * 0.001)
      if (score < bestScore) {
        bestScore = score
        best = n
      }
    }
    return best
  }

  _constructResponse(response, requester, requestNode) {
    const baseResponse = {
      loadType: response.loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: response.pluginInfo || {},
      tracks: []
    }

    if (response.loadType === 'error' || response.loadType === 'LOAD_FAILED') {
      baseResponse.exception = response.data || response.exception
      return baseResponse
    }

    switch (response.loadType) {
      case 'track':
        if (response.data) {
          baseResponse.tracks.push(new Track(response.data, requester, requestNode))
        }
        break

      case 'playlist': {
        const info = response.data?.info
        if (info) {
          baseResponse.playlistInfo = {
            name: info.name || info.title,
            thumbnail: response.data.pluginInfo?.artworkUrl ||
              response.data.tracks?.[0]?.info?.artworkUrl ||
              null,
            ...info
          }
        }

        const tracks = response.data?.tracks
        if (tracks?.length) {
          baseResponse.tracks = tracks.map(t => new Track(t, requester, requestNode))
        }
        break
      }

      case 'search': {
        const searchData = response.data || EMPTY_ARRAY
        if (searchData.length) {
          baseResponse.tracks = searchData.map(t => new Track(t, requester, requestNode))
        }
        break
      }
    }

    return baseResponse
  }

  get(guildId) {
    const player = this.players.get(guildId)
    if (!player) throw new Error(`Player not found: ${guildId}`)
    return player
  }

  async search(query, requester, source = this.defaultSearchPlatform) {
    if (!query || !requester) return null
    try {
      const { tracks } = await this.resolve({ query, source, requester })
      return tracks || null
    } catch {
      return null
    }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    try {
      await fs.promises.access(filePath)
      await this._waitForFirstNode()

      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      })

      let batch = []
      for await (const line of rl) {
        if (!line) continue
        batch.push(JSON.parse(line))
        if (batch.length >= PLAYER_BATCH_SIZE) {
          await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
          batch = []
        }
      }
      if (batch.length) {
        await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
      }

      await fs.promises.writeFile(filePath, '', { encoding: 'utf8' })
    } catch {
    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const ws = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' })
    let count = 0
    ws.cork()
    try {
      for (const player of this.players.values()) {
        const requester = player.requester || player.current?.requester
        ws.write(JSON.stringify({
          g: player.guildId,
          t: player.textChannel,
          v: player.voiceChannel,
          u: player.current?.uri || null,
          p: player.position || 0,
          ts: player.timestamp || 0,
          q: player.queue?.tracks?.slice(0, 5).map(tr => tr.uri) || [],
          r: requester ? `${requester.id}:${requester.username}` : null,
          vol: player.volume,
          pa: player.paused,
          pl: player.playing,
          nw: player.nowPlayingMessage?.id || null
        }) + '\n')
        count++
      }
    } finally {
      ws.uncork()
      await new Promise(resolve => ws.end(resolve))
    }
    this.emit('debug', 'Aqua', `Saved ${count} players to ${filePath}`)
  }

  async _restorePlayer(p) {
    try {
      let player = this.players.get(p.g)
      if (!player) {
        const targetNode = this._chooseLeastBusyNode(this.leastUsedNodes)
        if (!targetNode) return

        player = await this.createConnection({
          guildId: p.g,
          textChannel: p.t,
          voiceChannel: p.v,
          defaultVolume: p.vol || 65,
          deaf: true
        })
      }

      const requester = this._parseRequester(p.r)

      if (p.u && player) {
        const resolved = await this.resolve({ query: p.u, requester })
        if (resolved.tracks?.[0]) {
          player.queue.add(resolved.tracks[0])
          player.position = p.p || 0
        }
      }

      if (p.nw && player) {
        let message = this.client.cache?.messages?.get?.(p.nw)
        if (!message) {
          const channel = this.client.cache?.channels?.get?.(p.t)
          if (channel) {
            try {
              message = channel.client?.messages
                ? await channel.client.messages.fetch(p.nw, channel.id).catch(() => null)
                : await this.client.messages?.fetch(channel.id, p.nw).catch(() => null)
            } catch (error) {
              this.emit('debug', 'Aqua', `Failed to fetch nowPlayingMessage ${p.nw} for guild ${p.g}: ${error?.message || String(error)}`)
            }
          }
        }
        player.nowPlayingMessage = message || null
      }

      if (p.q?.length && player) {
        const results = await Promise.allSettled(
          p.q.filter(uri => uri && uri !== p.u).map(uri => this.resolve({ query: uri, requester }))
        )
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value?.tracks?.length) {
            for (const tr of r.value.tracks) {
              player.queue.add(tr)
            }
          }
        }
      }

      if (player) {
        if (typeof p.vol === 'number') player.volume = p.vol
        if (p.pa && typeof player.pause === 'function') await player.pause(true)
        if (p.u && (player.queue?.size > 0 || player.queue?.tracks?.length > 0)) {
          if (typeof player.play === 'function') await player.play()
          if (p.p) setTimeout(() => player.seek?.(p.p || 0), SEEK_DELAY)
        }
      }
    } catch (error) {
      this.emit('debug', 'Aqua', `Error restoring player for guild ${p.g}: ${error?.message || String(error)}`)
    }
  }

  _parseRequester(requesterString) {
    if (!requesterString || typeof requesterString !== 'string') return null
    const idx = requesterString.indexOf(':')
    if (idx <= 0) return null
    return { id: requesterString.slice(0, idx), username: requesterString.slice(idx + 1) }
  }

  async _waitForFirstNode() {
    if (this.leastUsedNodes.length) return
    return new Promise(resolve => {
      const onAny = () => {
        if (this.leastUsedNodes.length) {
          this.off('nodeConnect', onAny)
          this.off('nodeCreate', onAny)
          resolve()
        }
      }
      this.on('nodeConnect', onAny)
      this.on('nodeCreate', onAny)
      if (this.leastUsedNodes.length) {
        this.off('nodeConnect', onAny)
        this.off('nodeCreate', onAny)
        resolve()
      }
    })
  }

  _performCleanup() {
    const now = Date.now()

    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) {
        this._brokenPlayers.delete(guildId)
      }
    }

    for (const [nodeId, timestamp] of this._lastFailoverAttempt) {
      if (now - timestamp > FAILOVER_CLEANUP_TTL) {
        this._lastFailoverAttempt.delete(nodeId)
        this._failoverQueue.delete(nodeId)
      }
    }

    this._invalidateCache()
  }

  _getAvailableNodes(excludeNode) {
    return Array.from(this.nodeMap.values())
      .filter(node => node !== excludeNode && node.connected)
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }

    for (const player of this.players.values()) {
      try { player.destroy?.() } catch {}
    }

    for (const node of this.nodeMap.values()) {
      node.removeAllListeners?.()
    }

    this.removeAllListeners()
    this.players.clear()
    this.nodeMap.clear()
    this._nodeStates.clear()
    this._failoverQueue.clear()
    this._lastFailoverAttempt.clear()
    this._brokenPlayers.clear()
  }
}

module.exports = Aqua
