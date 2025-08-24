'use strict'

const { EventEmitter } = require('tseep')
const Connection = require('./Connection')
const Queue = require('./Queue')
const Filters = require('./Filters')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')

const LOOP_MODES = Object.freeze({ NONE: 0, TRACK: 1, QUEUE: 2 })
const LOOP_MODE_NAMES = Object.freeze(['none', 'track', 'queue'])
const EVENT_HANDLERS = Object.freeze({
  TrackStartEvent: 'trackStart', TrackEndEvent: 'trackEnd', TrackExceptionEvent: 'trackError',
  TrackStuckEvent: 'trackStuck', TrackChangeEvent: 'trackChange', WebSocketClosedEvent: 'socketClosed',
  LyricsLineEvent: 'lyricsLine', LyricsFoundEvent: 'lyricsFound', LyricsNotFoundEvent: 'lyricsNotFound'
})

const _clamp = v => { const n = +v; return n >= 0 && n <= 200 ? n : n !== n ? 100 : n < 0 ? 0 : 200 }
const _validVol = v => typeof v === 'number' && v >= 0 && v <= 200 && v === v
const _validPos = p => typeof p === 'number' && p >= 0 && p === p
const _randIdx = len => (Math.random() * len) | 0
const _toId = v => v ? (typeof v === 'string' ? v : v.id || null) : null
const _safeDel = async msg => { if (msg) try { await msg.delete() } catch {} }

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.isScheduled = false
    this.boundFlush = this._flush.bind(this)
  }

  batch(data, immediate = false) {
    if (!this.player) return Promise.reject(new Error('Player is destroyed'))
    if (!this.updates) this.updates = Object.create(null)
    Object.assign(this.updates, data)

    if (immediate || data.track || data.paused !== undefined || data.position !== undefined) {
      this.isScheduled = false
      return this._flush()
    }

    if (!this.isScheduled) {
      this.isScheduled = true
      queueMicrotask(this.boundFlush)
    }
    return Promise.resolve()
  }

  _flush() {
    if (!this.updates || !this.player) {
      this.updates = null
      this.isScheduled = false
      return Promise.resolve()
    }

    const updates = this.updates
    this.updates = null
    this.isScheduled = false

    return this.player.updatePlayer(updates).catch(err => {
      try { this.player?.aqua?.emit?.('error', new Error(`Update player error: ${err.message}`)) } catch {}
      throw err
    })
  }

  destroy() {
    this.updates = null
    this.isScheduled = false
    this.player = null
    this.boundFlush = null
  }
}

class CircularBuffer {
  constructor(size = 50) {
    this.buffer = new Array(size)
    this.size = size
    this.index = 0
    this.count = 0
  }

  push(item) {
    if (!item) return
    this.buffer[this.index] = item
    this.index = (this.index + 1) % this.size
    if (this.count < this.size) this.count++
  }

  getLast() {
    return this.count ? this.buffer[(this.index - 1 + this.size) % this.size] : null
  }

  clear() {
    if (this.count === 0) return
    for (let i = 0; i < Math.min(this.count, this.size); i++) this.buffer[i] = null
    this.count = 0
    this.index = 0
  }

  toArray() {
    if (!this.count) return []
    const result = []
    const start = this.count === this.size ? this.index : 0
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(start + i) % this.size]
      if (item) result.push(item)
    }
    return result
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS

  constructor(aqua, nodes, options = {}) {
    super()

    if (!aqua || !nodes || !options.guildId) throw new TypeError('Missing required parameters')

    Object.assign(this, {
      aqua, nodes, guildId: options.guildId, textChannel: options.textChannel,
      voiceChannel: options.voiceChannel, playing: false, paused: false, connected: false,
      destroyed: false, isAutoplayEnabled: false, isAutoplay: false, autoplaySeed: null,
      current: null, position: 0, timestamp: 0, ping: 0, nowPlayingMessage: null,
      deaf: options.deaf !== false, mute: !!options.mute, autoplayRetries: 0,
      reconnectionRetries: 0, _voiceDownSince: 0, _voiceRecovering: false
    })

    const vol = +options.defaultVolume || 100
    this.volume = _validVol(vol) ? vol : _clamp(vol)

    this.loop = this._parseLoop(options.loop)

    const aquaOpts = aqua.options || {}
    this.shouldDeleteMessage = !!aquaOpts.shouldDeleteMessage
    this.leaveOnEnd = !!aquaOpts.leaveOnEnd

    this.connection = new Connection(this)
    this.filters = new Filters(this)
    this.queue = new Queue()
    this.previousIdentifiers = new Set()
    this.previousTracks = new CircularBuffer(50)
    this._updateBatcher = new MicrotaskUpdateBatcher(this)
    this._dataStore = null

    this._bindEvents()
    this._startWatchdog()
  }

  _parseLoop(loop) {
    if (typeof loop === 'string') {
      const idx = LOOP_MODE_NAMES.indexOf(loop)
      return idx >= 0 && idx <= 2 ? idx : LOOP_MODES.NONE
    }
    return typeof loop === 'number' && loop >= 0 && loop <= 2 ? loop : LOOP_MODES.NONE
  }

  _bindEvents() {
    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)
    this._boundAquaPlayerMove = this._handleAquaPlayerMove.bind(this)

    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
    this.aqua.on('playerMove', this._boundAquaPlayerMove)
  }

  _startWatchdog() {
    this._voiceWatchdogTimer = setInterval(() => this._voiceWatchdog(), 15000)
    this._voiceWatchdogTimer.unref?.()
  }

  _handlePlayerUpdate(packet) {
    if (this.destroyed || !packet?.state) return

    const { state } = packet
    this.position = typeof state.position === 'number' ? state.position : 0
    this.connected = !!state.connected
    this.ping = typeof state.ping === 'number' ? state.ping : 0
    this.timestamp = typeof state.time === 'number' ? state.time : Date.now()

    if (!this.connected && !this._voiceDownSince) {
      this._voiceDownSince = Date.now()
      setTimeout(() => !this.connected && !this.destroyed && this.connection.attemptResume(), 1000)
    } else if (this.connected) {
      this._voiceDownSince = 0
    }

    this.aqua.emit('playerUpdate', this, packet)
  }

  async _handleEvent(payload) {
    if (this.destroyed || !payload?.type) return

    const handlerName = EVENT_HANDLERS[payload.type]
    if (!handlerName) {
      this.aqua.emit('nodeError', this, new Error(`Unknown event: ${payload.type}`))
      return
    }

    const handler = this[handlerName]
    if (typeof handler === 'function') {
      try {
        await handler.call(this, this, this.current, payload)
      } catch (error) {
        this.aqua.emit('error', error)
      }
    }
  }

  get previous() { return this.previousTracks?.getLast() || null }
  get currenttrack() { return this.current }
  getQueue() { return this.queue }

  batchUpdatePlayer(data, immediate = false) {
    return this._updateBatcher.batch(data, immediate)
  }

  setAutoplay(enabled) {
    this.isAutoplayEnabled = !!enabled
    this.autoplayRetries = 0
    return this
  }

  async play() {
    if (this.destroyed || !this.connected || !this.queue?.size) return this

    const item = this.queue.shift()
    if (!item) return this

    try {
      this.current = item.track ? item : await item.resolve(this.aqua)
      if (!this.current?.track) throw new Error('Failed to resolve track')

      Object.assign(this, { playing: true, paused: false, position: 0 })
      await this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true)
      return this
    } catch (error) {
      this.aqua.emit('error', error)
      return this.queue?.size ? this.play() : this
    }
  }

  connect(options = {}) {
    if (this.destroyed) throw new Error('Cannot connect destroyed player')

    const voiceChannel = _toId(options.voiceChannel || this.voiceChannel)
    if (!voiceChannel) throw new TypeError('Voice channel is required')

    Object.assign(this, {
      deaf: options.deaf !== undefined ? !!options.deaf : true,
      mute: !!options.mute, connected: true, destroyed: false, voiceChannel
    })

    this.send({
      guild_id: options.guildId || this.guildId,
      channel_id: voiceChannel,
      self_deaf: this.deaf,
      self_mute: this.mute
    })
    return this
  }

  async _voiceWatchdog() {
    if (this.destroyed || !this.voiceChannel || this.connected || !this._voiceDownSince ||
        (Date.now() - this._voiceDownSince) < 10000 || this._voiceRecovering) return

    this._voiceRecovering = true
    try {
      try {
        if (await this.connection.attemptResume()) {
          this.aqua.emit('debug', `[Player ${this.guildId}] Watchdog: resume sent`)
          return
        }
      } catch (e) {
        this.aqua.emit('debug', `[Player ${this.guildId}] Watchdog: resume failed: ${e}`)
      }

      const toggleMute = !this.mute
      this.send({ guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: toggleMute })
      setTimeout(() => !this.destroyed && this.send({
        guild_id: this.guildId, channel_id: this.voiceChannel, self_deaf: this.deaf, self_mute: this.mute
      }), 300)

      this.connection.resendVoiceUpdate({ resume: false })
      this.aqua.emit('debug', `[Player ${this.guildId}] Watchdog: forced voice update/rejoin`)
    } catch (err) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Watchdog recover failed: ${err?.message || err}`)
    } finally {
      this._voiceRecovering = false
    }
  }

  destroy({ preserveClient = true, skipRemote = false } = {}) {
    if (this.destroyed) return this

    if (this._voiceWatchdogTimer) {
      clearInterval(this._voiceWatchdogTimer)
      this._voiceWatchdogTimer = null
    }

    Object.assign(this, { destroyed: true, connected: false, playing: false, paused: false })
    this.emit('destroy')

    if (this.shouldDeleteMessage && this.nowPlayingMessage) {
      _safeDel(this.nowPlayingMessage)
      this.nowPlayingMessage = null
    }

    this.off('playerUpdate', this._boundPlayerUpdate)
    this.off('event', this._boundEvent)
    this.removeAllListeners()

    this._updateBatcher?.destroy()
    this._updateBatcher = null

    if (this._boundAquaPlayerMove) {
      try { this.aqua.off('playerMove', this._boundAquaPlayerMove) } catch {}
      this._boundAquaPlayerMove = null
    }

    if (!skipRemote) {
      try {
        this.send({ guild_id: this.guildId, channel_id: null })
        this.aqua?.destroyPlayer?.(this.guildId)
        this.nodes?.connected && this.nodes?.rest?.destroyPlayer?.(this.guildId).catch(() => {})
      } catch (error) {
        console.error(`[Player ${this.guildId}] Destroy error:`, error?.message)
      }
    }

    this.voiceChannel = null
    Object.assign(this, { isAutoplay: false, autoplayRetries: 0, reconnectionRetries: 0 })
    this.clearData()

    this.queue = this.connection = this.filters = this._dataStore = null
    if (!preserveClient) this.aqua = this.nodes = null
    return this
  }

  pause(paused) {
    if (this.destroyed) return this
    const state = !!paused
    if (this.paused === state) return this
    this.paused = state
    this.batchUpdatePlayer({ paused: state }, true)
    return this
  }

  seek(position) {
    if (this.destroyed || !this.playing || !_validPos(position)) return this
    const maxPos = this.current?.info?.length
    this.position = maxPos ? Math.min(position, maxPos) : position
    this.batchUpdatePlayer({ position: this.position }, true)
    return this
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    Object.assign(this, { playing: false, paused: false, position: 0 })
    this.batchUpdatePlayer({ track: { encoded: null } }, true)
    return this
  }

  setVolume(volume) {
    if (this.destroyed) return this
    const vol = _clamp(volume)
    if (this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ volume: vol })
    return this
  }

  setLoop(mode) {
    if (this.destroyed) return this
    const modeIndex = typeof mode === 'string' ? LOOP_MODE_NAMES.indexOf(mode) : mode
    if (modeIndex < 0 || modeIndex > 2) throw new Error('Invalid loop mode. Use: none, track, or queue')
    this.loop = modeIndex
    this.batchUpdatePlayer({ loop: LOOP_MODE_NAMES[modeIndex] })
    return this
  }

  setTextChannel(channel) {
    if (this.destroyed) return this
    const channelId = _toId(channel)
    if (!channelId) throw new TypeError('Invalid text channel')
    this.textChannel = channelId
    this.batchUpdatePlayer({ text_channel: channelId })
    return this
  }

  setVoiceChannel(channel) {
    if (this.destroyed) return this
    const targetId = _toId(channel)
    if (!targetId) throw new TypeError('Voice channel is required')
    if (this.connected && targetId === _toId(this.voiceChannel)) return this
    this.voiceChannel = targetId
    this.connect({ deaf: this.deaf, guildId: this.guildId, voiceChannel: targetId, mute: this.mute })
    return this
  }

  disconnect() {
    if (this.destroyed || !this.connected) return this
    this.connected = false
    this.voiceChannel = null
    this.send({ guild_id: this.guildId, channel_id: null })
    return this
  }

  shuffle() {
    if (this.destroyed || !this.queue?.size) return this
    const items = this.queue.toArray()
    if (items.length <= 1) return this

    for (let i = items.length - 1; i > 0; i--) {
      const j = _randIdx(i + 1)
      if (i !== j) [items[i], items[j]] = [items[j], items[i]]
    }

    this.queue.clear()
    items.forEach(item => this.queue.push(item))
    return this
  }

  replay() { return this.seek(0) }
  skip() { return this.stop() }

  async getLyrics(options = {}) {
    if (this.destroyed || !this.nodes?.rest) return null
    const { query, useCurrentTrack = true, skipTrackSource = false } = options

    if (query) return this.nodes.rest.getLyrics({ track: { info: { title: query } }, skipTrackSource })

    if (useCurrentTrack && this.playing && this.current) {
      const currentInfo = this.current.info
      return this.nodes.rest.getLyrics({
        track: { info: currentInfo, encoded: this.current.track, identifier: currentInfo.identifier, guild_id: this.guildId },
        skipTrackSource
      })
    }
    return null
  }

  subscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player is destroyed')) : this.nodes?.rest?.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    return this.destroyed ? Promise.reject(new Error('Player is destroyed')) : this.nodes?.rest?.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (this.destroyed || !this.isAutoplayEnabled || !this.previous || this.queue?.size) return this

    const prev = this.previous
    const prevInfo = prev?.info
    if (!prevInfo?.sourceName || !prevInfo.identifier) return this

    const { sourceName, identifier, uri, requester, author } = prevInfo
    this.isAutoplay = true

    if (sourceName === 'spotify' && prev?.identifier) {
      this.previousIdentifiers.add(prev.identifier)
      if (this.previousIdentifiers.size > 20) {
        const firstKey = this.previousIdentifiers.values().next().value
        this.previousIdentifiers.delete(firstKey)
      }
      if (!this.autoplaySeed) {
        this.autoplaySeed = { trackId: identifier, artistIds: Array.isArray(author) ? author.join(',') : author }
      }
    }

    for (let attempts = 0; !this.destroyed && attempts < 3 && !this.queue?.size; attempts++) {
      try {
        let track = null

        if (sourceName === 'youtube') {
          const response = await this.aqua.resolve({
            query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`,
            source: 'ytmsearch',
            requester
          })
          if (!this._isInvalidResponse(response) && response.tracks?.length) {
            track = response.tracks[_randIdx(response.tracks.length)]
          }
        } else if (sourceName === 'soundcloud') {
          const scResults = await scAutoPlay(uri)
          if (scResults?.length) {
            const response = await this.aqua.resolve({ query: scResults[0], source: 'scsearch', requester })
            if (!this._isInvalidResponse(response) && response.tracks?.length) {
              track = response.tracks[_randIdx(response.tracks.length)]
            }
          }
        } else if (sourceName === 'spotify') {
          const resolved = await spAutoPlay(this.autoplaySeed, this, requester, Array.from(this.previousIdentifiers))
          if (resolved?.length) track = resolved[_randIdx(resolved.length)]
        } else break

        if (track?.info?.title) {
          this.autoplayRetries = 0
          track.requester = prev.requester || { id: 'Unknown' }
          this.queue.push(track)
          await this.play()
          return this
        }
      } catch (err) {
        this.aqua.emit('error', new Error(`Autoplay attempt ${attempts + 1} failed: ${err.message}`))
      }
    }

    this.aqua.emit('autoplayFailed', this, new Error('Max autoplay retries reached'))
    this.stop()
    return this
  }

  _isInvalidResponse(response) {
    return !response?.tracks?.length || ['error', 'empty', 'LOAD_FAILED', 'NO_MATCHES'].includes(response.loadType)
  }

  async trackStart(player, track) {
    if (this.destroyed) return
    Object.assign(this, { playing: true, paused: false })
    this.aqua.emit('trackStart', this, track)
  }

  async trackEnd(player, track, payload) {
    if (this.destroyed) return
    if (track && this.previousTracks) this.previousTracks.push(track)
    if (this.shouldDeleteMessage) await _safeDel(this.nowPlayingMessage)

    const reason = payload?.reason
    const isFailure = reason === 'loadFailed' || reason === 'cleanup'
    const isReplaced = reason === 'replaced'

    if (isFailure) {
      if (!this.queue?.size) {
        this.clearData()
        this.aqua.emit('queueEnd', this)
      } else {
        this.aqua.emit('trackEnd', this, track, reason)
        await this.play()
      }
      return
    }

    if (track && !isReplaced) {
      if (this.loop === LOOP_MODES.TRACK) this.queue.unshift(track)
      else if (this.loop === LOOP_MODES.QUEUE) this.queue.push(track)
    }

    if (this.queue?.size) {
      this.aqua.emit('trackEnd', this, track, reason)
      await this.play()
    } else if (this.isAutoplayEnabled && !isReplaced) {
      await this.autoplay()
    } else {
      this.playing = false
      if (this.leaveOnEnd && !this.destroyed) {
        this.clearData()
        this.destroy()
      }
      this.aqua.emit('queueEnd', this)
    }
  }

  async trackError(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('trackError', this, track, payload)
    return this.stop()
  }

  async trackStuck(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('trackStuck', this, track, payload)
    return this.stop()
  }

  async trackChange(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('trackChange', this, track, payload)
  }

  async _attemptVoiceResume() {
    if (!this.connection?.sessionId) throw new Error('Missing connection or sessionId')
    if (!await this.connection.attemptResume()) throw new Error('Resume request failed')

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('playerUpdate', onUpdate)
        reject(new Error('No resume confirmation'))
      }, 5000)

      const onUpdate = payload => {
        if (payload?.state?.connected || typeof payload?.state?.time === 'number') {
          clearTimeout(timeout)
          this.off('playerUpdate', onUpdate)
          resolve()
        }
      }
      this.on('playerUpdate', onUpdate)
    })
  }

  async socketClosed(player, track, payload) {
    if (this.destroyed) return
    const code = payload?.code

    if (code === 4022) {
      this.aqua.emit('socketClosed', this, payload)
      this.destroy()
      return
    }

    if (code === 4015) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Voice server crashed (4015), attempting resume...`)
      try {
        await this._attemptVoiceResume()
        this.aqua.emit('debug', `[Player ${this.guildId}] Voice resume succeeded`)
        return
      } catch (err) {
        this.aqua.emit('debug', `[Player ${this.guildId}] Resume failed: ${err.message}. Falling back to reconnect`)
      }
    }

    if (![4015, 4009, 4006].includes(code)) {
      this.aqua.emit('socketClosed', this, payload)
      return
    }

    // Reconnection logic condensed
    const aquaRef = this.aqua
    const voiceChannelId = _toId(this.voiceChannel)
    if (!voiceChannelId) {
      aquaRef?.emit?.('socketClosed', this, payload)
      return
    }

    const savedState = {
      volume: this.volume, position: this.position, paused: this.paused, loop: this.loop,
      isAutoplayEnabled: this.isAutoplayEnabled, currentTrack: this.current, queue: this.queue?.toArray() || [],
      previousIdentifiers: [...this.previousIdentifiers], autoplaySeed: this.autoplaySeed
    }

    this.destroy({ preserveClient: true, skipRemote: true })

    const tryReconnect = async attempt => {
      try {
        const newPlayer = await aquaRef.createConnection({
          guildId: this.guildId, voiceChannel: voiceChannelId, textChannel: _toId(this.textChannel),
          deaf: this.deaf, mute: this.mute, defaultVolume: savedState.volume
        })

        if (!newPlayer) throw new Error('Failed to create new player during reconnection')

        Object.assign(newPlayer, {
          reconnectionRetries: 0, loop: savedState.loop, isAutoplayEnabled: savedState.isAutoplayEnabled,
          autoplaySeed: savedState.autoplaySeed, previousIdentifiers: new Set(savedState.previousIdentifiers)
        })

        if (savedState.currentTrack) newPlayer.queue.unshift(savedState.currentTrack)
        savedState.queue.forEach(item => item !== savedState.currentTrack && newPlayer.queue.push(item))

        if (savedState.currentTrack) {
          await newPlayer.play()
          if (savedState.position > 5000) setTimeout(() => !newPlayer.destroyed && newPlayer.seek(savedState.position), 800)
          if (savedState.paused) setTimeout(() => !newPlayer.destroyed && newPlayer.pause(true), 1200)
        }

        aquaRef.emit('playerReconnected', newPlayer, { oldPlayer: this, restoredState: savedState })
      } catch (error) {
        const retriesLeft = 3 - attempt
        aquaRef.emit('reconnectionFailed', this, { error, code, payload, retriesLeft })
        if (retriesLeft > 0) setTimeout(() => tryReconnect(attempt + 1), 1500)
        else aquaRef.emit('socketClosed', this, payload)
      }
    }

    tryReconnect(1)
  }

  async lyricsLine(player, track, payload) {
    if (!this.destroyed) this.aqua.emit('lyricsLine', this, track, payload)
  }

  async lyricsFound(player, track, payload) {
    if (!this.destroyed) this.aqua.emit('lyricsFound', this, track, payload)
  }

  async lyricsNotFound(player, track, payload) {
    if (!this.destroyed) this.aqua.emit('lyricsNotFound', this, track, payload)
  }

  _handleAquaPlayerMove(oldChannel, newChannel) {
    try {
      if (_toId(oldChannel) === _toId(this.voiceChannel)) {
        this.voiceChannel = _toId(newChannel)
        this.connected = !!newChannel
        this.send({
          guild_id: this.guildId, channel_id: this.voiceChannel,
          self_deaf: this.deaf, self_mute: this.mute
        })
      }
    } catch {}
  }

  send(data) {
    try { this.aqua.send({ op: 4, d: data }) }
    catch (error) { this.aqua.emit('error', new Error(`Failed to send data: ${error.message}`)) }
  }

  set(key, value) {
    if (this.destroyed) return
    if (!this._dataStore) this._dataStore = new Map()
    this._dataStore.set(key, value)
  }

  get(key) {
    return this.destroyed || !this._dataStore ? undefined : this._dataStore.get(key)
  }

  clearData() {
    this.previousTracks?.clear()
    this._dataStore?.clear()
    this.previousIdentifiers?.clear()
    Object.assign(this, { current: null, position: 0, timestamp: 0 })
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  async cleanup() {
    if (!this.playing && !this.paused && this.queue?.isEmpty?.()) this.destroy()
  }
}

module.exports = Player
