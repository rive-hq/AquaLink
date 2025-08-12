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

const CLEANUP_INTERVAL = 120000
const MAX_CONCURRENT_OPS = 8
const BROKEN_PLAYER_TTL = 300000
const FAILOVER_CLEANUP_TTL = 600000
const PLAYER_BATCH_SIZE = 16
const SEEK_DELAY = 100
const RECONNECT_DELAY = 500
const CACHE_VALID_TIME = 10000

const URL_PATTERN = /^https?:\/\//i
const isProbablyUrl = s => typeof s === 'string' && URL_PATTERN.test(s)

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

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

    this.options = Object.assign({}, DEFAULT_OPTIONS, options)
    this.failoverOptions = Object.assign({}, DEFAULT_OPTIONS.failoverOptions, options.failoverOptions)

    Object.assign(this, {
      shouldDeleteMessage: this.options.shouldDeleteMessage,
      defaultSearchPlatform: this.options.defaultSearchPlatform,
      leaveOnEnd: this.options.leaveOnEnd,
      restVersion: this.options.restVersion,
      plugins: this.options.plugins,
      autoResume: this.options.autoResume,
      infiniteReconnects: this.options.infiniteReconnects,
      send: this.options.send || this._createDefaultSend()
    })

    this._nodeStates = new Map()
    this._failoverQueue = new Map()
    this._lastFailoverAttempt = new Map()
    this._brokenPlayers = new Map()

    this._leastUsedNodesCache = null
    this._leastUsedNodesCacheTime = 0
    this._nodeLoadCache = new Map()
    this._nodeLoadCacheTime = new Map()

    this._bindEventHandlers()
    this._startCleanupTimer()
  }

  _createDefaultSend() {
    return packet => {
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
  }

  _bindEventHandlers() {
    if (!this.autoResume) return

    this._onNodeConnect = node => queueMicrotask(() => this._rebuildBrokenPlayers(node))
    this._onNodeDisconnect = node => queueMicrotask(() => this._storeBrokenPlayers(node))

    this.on('nodeConnect', this._onNodeConnect)
    this.on('nodeDisconnect', this._onNodeDisconnect)
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => this._performCleanup(), CLEANUP_INTERVAL)
    this._cleanupTimer.unref?.()
  }

  get leastUsedNodes() {
    const now = Date.now()
    if (this._leastUsedNodesCache && (now - this._leastUsedNodesCacheTime) < CACHE_VALID_TIME) {
      return this._leastUsedNodesCache
    }

    const connectedNodes = []
    for (const node of this.nodeMap.values()) {
      if (node.connected) connectedNodes.push(node)
    }

    connectedNodes.sort((a, b) => {
      const loadA = this._getCachedNodeLoad(a)
      const loadB = this._getCachedNodeLoad(b)
      return loadA - loadB
    })

    this._leastUsedNodesCache = connectedNodes
    this._leastUsedNodesCacheTime = now
    return connectedNodes
  }

  _getCachedNodeLoad(node) {
    const nodeId = node.name || node.host
    const now = Date.now()
    const cacheTime = this._nodeLoadCacheTime.get(nodeId)

    if (cacheTime && (now - cacheTime) < 5000) {
      return this._nodeLoadCache.get(nodeId) || 0
    }

    const load = this._calculateNodeLoad(node)
    this._nodeLoadCache.set(nodeId, load)
    this._nodeLoadCacheTime.set(nodeId, now)
    return load
  }

  _calculateNodeLoad(node) {
    const cpu = node?.stats?.cpu
    const cpuLoad = cpu ? (cpu.systemLoad / Math.max(1, cpu.cores)) : 0
    const playing = node?.stats?.playingPlayers || 0
    const calls = node?.rest?.calls || 0
    return cpuLoad * 100 + (playing * 0.5) + (calls * 0.001)
  }

  async init(clientId) {
    if (this.initiated) return this
    this.clientId = clientId

    const results = await Promise.allSettled(
      this.nodes.map(n => this._createNode(n))
    )

    if (!this.clientId) return this;

    const successCount = results.filter(r => r.status === 'fulfilled').length
    if (!successCount) throw new Error('No nodes connected')

    await this._loadPlugins()
    this.initiated = true
    return this
  }

  async _loadPlugins() {
    if (!this.plugins?.length) return

    await Promise.allSettled(
      this.plugins.map(async plugin => {
        try {
          await plugin.load(this)
        } catch (err) {
          this.emit('error', null, new Error(`Plugin error: ${err?.message || String(err)}`))
        }
      })
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
      await node.connect()
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
    const brokenStates = []

    for (const player of this.players.values()) {
      if (player.nodes !== node) continue
      const state = this._capturePlayerState(player)
      if (state) {
        state.originalNodeId = nodeId
        state.brokenAt = now
        brokenStates.push([player.guildId, state])
      }
    }

    for (const [guildId, state] of brokenStates) {
      this._brokenPlayers.set(guildId, state)
    }
  }

  async _rebuildBrokenPlayers(node) {
    const nodeId = node.name || node.host
    const rebuilds = []
    const toDelete = []

    for (const [guildId, brokenState] of this._brokenPlayers) {
      if (brokenState.originalNodeId !== nodeId) continue

      rebuilds.push({
        guildId,
        brokenState,
        promise: this._rebuildPlayer(brokenState, node)
      })
    }

    if (!rebuilds.length) return

    const results = await Promise.allSettled(rebuilds.map(r => r.promise))

    results.forEach((result, index) => {
      const { guildId, brokenState } = rebuilds[index]
      if (result.status === 'fulfilled') {
        toDelete.push(guildId)
      } else if (Date.now() - brokenState.brokenAt > BROKEN_PLAYER_TTL) {
        toDelete.push(guildId)
      }
    })

    for (const guildId of toDelete) {
      this._brokenPlayers.delete(guildId)
    }

    const rebuiltCount = results.filter(r => r.status === 'fulfilled').length
    if (rebuiltCount) this.emit('playersRebuilt', node, rebuiltCount)
  }

  async _rebuildPlayer(brokenState, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState

    const existingPlayer = this.players.get(guildId)
    if (existingPlayer) {
      await this.destroyPlayer(guildId)
      await delay(RECONNECT_DELAY)
    }

    const player = await this.createConnection({
      guildId,
      textChannel,
      voiceChannel,
      defaultVolume: volume,
      deaf
    })

    if (current) {
      player.queue.add(current)
      await player.play()

      if (brokenState.position > 0) {
        setTimeout(() => player.seek(brokenState.position), SEEK_DELAY)
      }

      if (brokenState.paused) {
        await player.pause(true)
      }

      this.emit('trackStart', player, current)
    }

    return player
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
    this._nodeLoadCache.delete(nodeId)
    this._nodeLoadCacheTime.delete(nodeId)

    if (this._leastUsedNodesCache?.some(n => (n.name || n.host) === nodeId)) {
      this._invalidateCache()
    }
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

      const affectedPlayers = Array.from(failedNode.players)
      if (!affectedPlayers.length) {
        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false })
        return
      }

      const availableNodes = this._getAvailableNodes(failedNode)
      if (!availableNodes.length) {
        throw new Error('No failover nodes available')
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

    const batchSize = Math.min(MAX_CONCURRENT_OPS, players.length)
    const results = []

    for (let i = 0; i < players.length; i += batchSize) {
      const batch = players.slice(i, i + batchSize)
      const batchResults = await Promise.allSettled(
        batch.map(p => this._migratePlayer(p, availableNodes))
      )

      results.push(...batchResults.map(r => ({
        success: r.status === 'fulfilled',
        error: r.reason
      })))
    }

    return results
  }

  async _migratePlayer(player, availableNodes) {
    const playerState = this._capturePlayerState(player)
    if (!playerState) throw new Error('Failed to capture state')

    for (let retry = 0; retry < this.failoverOptions.maxRetries; retry++) {
      try {
        const targetNode = this._chooseLeastBusyNode(availableNodes)
        const newPlayer = await this._createPlayerOnNode(targetNode, playerState)
        await this._restorePlayerState(newPlayer, playerState)
        this.emit('playerMigrated', player, newPlayer, targetNode)
        return newPlayer
      } catch (error) {
        if (retry === this.failoverOptions.maxRetries - 1) throw error
        await delay(this.failoverOptions.retryDelay * Math.pow(1.5, retry))
      }
    }
  }

  _capturePlayerState(player) {
    if (!player) return null

    return {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position: player.position || 0,
      current: player.current || null,
      queue: player.queue?.tracks?.slice(0, 10) || EMPTY_ARRAY,
      repeat: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
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

    const operations = []

    if (typeof playerState.volume === 'number') {
      newPlayer.volume = playerState.volume
    }

    if (playerState.queue?.length && newPlayer.queue) {
      newPlayer.queue.tracks = [...playerState.queue]
    }

    if (playerState.current && this.failoverOptions.preservePosition) {
      if (newPlayer.queue) {
        newPlayer.queue.tracks.unshift(playerState.current)
      }

      if (this.failoverOptions.resumePlayback) {
        operations.push(newPlayer.play())

        if (playerState.position > 0) {
          setTimeout(() => newPlayer.seek?.(playerState.position), SEEK_DELAY)
        }

        if (playerState.paused) {
          operations.push(newPlayer.pause(true))
        }
      }
    }

    Object.assign(newPlayer, {
      repeat: playerState.repeat,
      shuffle: playerState.shuffle
    })

    await Promise.allSettled(operations)
  }

  updateVoiceState({ d, t }) {
    if (!d?.guild_id) return
    if (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE') return

    const player = this.players.get(d.guild_id)
    if (!player) return

    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return

      if (!d.channel_id) {
        this.destroyPlayer(d.guild_id)
        return
      }

      if (player.connection) {
        player.connection.sessionId = d.session_id
        player.connection.setStateUpdate(d)
      }
    } else {
      player.connection?.setServerUpdate(d)
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes

    const lowerRegion = region.toLowerCase()
    const filtered = []

    for (const node of this.nodeMap.values()) {
      if (node.connected && node.regions?.includes(lowerRegion)) {
        filtered.push(node)
      }
    }

    filtered.sort((a, b) => this._getCachedNodeLoad(a) - this._getCachedNodeLoad(b))
    return filtered
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
    player.once('destroy', () => this._handlePlayerDestroy(player))
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
      await player.destroy?.()
    } finally {
      player.removeAllListeners?.()
      this.players.delete(guildId)
      this.emit('playerDestroy', player)
    }
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized')

    const requestNode = this._getRequestNode(nodes)
    const formattedQuery = isProbablyUrl(query) ? query : `${source}${SEARCH_PREFIX}${query}`

    try {
      const endpoint = `/${this.restVersion}/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`
      const response = await requestNode.rest.makeRequest('GET', endpoint)

      if (!response || response.loadType === 'empty' || response.loadType === 'NO_MATCHES') {
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
      const candidates = nodes.filter(n => n?.connected)
      return this._chooseLeastBusyNode(candidates.length ? candidates : this.leastUsedNodes)
    }

    if (typeof nodes === 'string') {
      const node = this.nodeMap.get(nodes)
      return node?.connected ? node : this._chooseLeastBusyNode(this.leastUsedNodes)
    }

    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`)
  }

  _chooseLeastBusyNode(nodes) {
    if (!nodes?.length) return null

    let best = nodes[0]
    let bestScore = this._getCachedNodeLoad(best)

    for (let i = 1; i < nodes.length; i++) {
      const score = this._getCachedNodeLoad(nodes[i])
      if (score < bestScore) {
        bestScore = score
        best = nodes[i]
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

        if (response.data?.tracks?.length) {
          baseResponse.tracks = response.data.tracks.map(t => new Track(t, requester, requestNode))
        }
        break
      }

      case 'search':
        if (response.data?.length) {
          baseResponse.tracks = response.data.map(t => new Track(t, requester, requestNode))
        }
        break
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

      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      const batch = []
      for await (const line of rl) {
        if (!line.trim()) continue

        try {
          batch.push(JSON.parse(line))
        } catch {
          continue
        }

        if (batch.length >= PLAYER_BATCH_SIZE) {
          await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
          batch.length = 0
        }
      }

      if (batch.length) {
        await Promise.allSettled(batch.map(p => this._restorePlayer(p)))
      }

      await fs.promises.writeFile(filePath, '')
    } catch {

    }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const ws = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' })
    const buffer = []
    let count = 0

    for (const player of this.players.values()) {
      const requester = player.requester || player.current?.requester
      const data = {
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
      }

      buffer.push(JSON.stringify(data))
      count++

      if (buffer.length >= 100) {
        ws.write(buffer.join('\n') + '\n')
        buffer.length = 0
      }
    }

    if (buffer.length) {
      ws.write(buffer.join('\n') + '\n')
    }

    await new Promise(resolve => ws.end(resolve))
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

      const tracksToResolve = [p.u, ...(p.q || [])].filter(Boolean)
      const resolvePromises = tracksToResolve.map(uri =>
        this.resolve({ query: uri, requester }).catch(() => null)
      )

      const resolved = await Promise.all(resolvePromises)
      const validTracks = resolved.filter(r => r?.tracks?.length).flatMap(r => r.tracks)

      if (validTracks.length && player.queue) {
        player.queue.add(...validTracks)
      }

      if (p.u && validTracks[0]) {
        player.position = p.p || 0

        if (p.vol != null) player.volume = p.vol

        if (validTracks.length) {
          await player.play()
          if (p.p) setTimeout(() => player.seek?.(p.p), SEEK_DELAY)
          if (p.pa) await player.pause(true)
        }
      }

      if (p.nw && p.t) {
        const channel = this.client.channels?.cache?.get(p.t)
        if (channel?.messages) {
          try {
            player.nowPlayingMessage = await channel.messages.fetch(p.nw).catch(() => null)
          } catch {

          }
        }
      }
    } catch (error) {
      this.emit('debug', 'Aqua', `Error restoring player for guild ${p.g}: ${error?.message || String(error)}`)
    }
  }

  _parseRequester(requesterString) {
    if (!requesterString || typeof requesterString !== 'string') return null

    const colonIndex = requesterString.indexOf(':')
    if (colonIndex <= 0) return null

    return {
      id: requesterString.substring(0, colonIndex),
      username: requesterString.substring(colonIndex + 1)
    }
  }

  async _waitForFirstNode() {
    if (this.leastUsedNodes.length) return

    return new Promise(resolve => {
      const checkNodes = () => {
        if (this.leastUsedNodes.length) {
          this.off('nodeConnect', checkNodes)
          this.off('nodeCreate', checkNodes)
          resolve()
        }
      }

      this.on('nodeConnect', checkNodes)
      this.on('nodeCreate', checkNodes)

      if (this.leastUsedNodes.length) {
        checkNodes()
      }
    })
  }

  _performCleanup() {
    const now = Date.now()
    const toDelete = []

    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) {
        toDelete.push(guildId)
      }
    }

    for (const guildId of toDelete) {
      this._brokenPlayers.delete(guildId)
    }

    toDelete.length = 0
    for (const [nodeId, timestamp] of this._lastFailoverAttempt) {
      if (now - timestamp > FAILOVER_CLEANUP_TTL) {
        toDelete.push(nodeId)
      }
    }

    for (const nodeId of toDelete) {
      this._lastFailoverAttempt.delete(nodeId)
      this._failoverQueue.delete(nodeId)
    }

    this._nodeLoadCache.clear()
    this._nodeLoadCacheTime.clear()
  }

  _getAvailableNodes(excludeNode) {
    const available = []
    for (const node of this.nodeMap.values()) {
      if (node !== excludeNode && node.connected) {
        available.push(node)
      }
    }
    return available
  }

  destroy() {

    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }

    if (this._onNodeConnect) {
      this.off('nodeConnect', this._onNodeConnect)
      this.off('nodeDisconnect', this._onNodeDisconnect)
    }

    const cleanupPromises = []

    for (const player of this.players.values()) {
      cleanupPromises.push(
        Promise.resolve(player.destroy?.()).catch(() => {})
      )
    }

    this.players.clear()
    this.nodeMap.clear()
    this._nodeStates.clear()
    this._failoverQueue.clear()
    this._lastFailoverAttempt.clear()
    this._brokenPlayers.clear()
    this._nodeLoadCache.clear()
    this._nodeLoadCacheTime.clear()

    this.removeAllListeners()

    return Promise.all(cleanupPromises)
  }
}

module.exports = Aqua
