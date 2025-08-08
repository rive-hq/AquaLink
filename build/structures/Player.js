'use strict'

const { EventEmitter } = require('node:events')

const Connection = require('./Connection')
const Queue = require('./Queue')
const Filters = require('./Filters')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')

const LOOP_MODES = Object.freeze({
  NONE: 'none',
  TRACK: 'track',
  QUEUE: 'queue'
})

const EVENT_HANDLERS = Object.freeze({
  TrackStartEvent: 'trackStart',
  TrackEndEvent: 'trackEnd',
  TrackExceptionEvent: 'trackError',
  TrackStuckEvent: 'trackStuck',
  TrackChangeEvent: 'trackChange',
  WebSocketClosedEvent: 'socketClosed',
  LyricsLineEvent: 'lyricsLine',
  LyricsFoundEvent: 'lyricsFound',
  LyricsNotFoundEvent: 'lyricsNotFound'
})

const VALID_MODES = new Set(Object.values(LOOP_MODES))
const FAILURE_REASONS = new Set(['LOAD_FAILED', 'CLEANUP'])
const RECONNECT_CODES = new Set([4015, 4009, 4006])
const FAIL_LOAD_TYPES = new Set(['error', 'empty', 'LOAD_FAILED', 'NO_MATCHES'])

const fnClamp = v => Math.max(0, Math.min(200, +v || 0))
const fnIsValidVolume = v => typeof v === 'number' && v >= 0 && v <= 200
const fnIsValidPosition = p => typeof p === 'number' && !Number.isNaN(p) && p >= 0
const fnRandomIndex = arr => (Math.random() * arr.length) | 0
const fnToId = v => v && (v.id || v)
const fnSafeDeleteMessage = msg => {
  if (msg) msg.delete().catch(() => {})
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.isScheduled = false
  }

  batch(data, immediate = false) {
    this.updates ??= Object.create(null)
    Object.assign(this.updates, data)

    if (immediate || data.track) {
      return this._flush()
    }

    if (!this.isScheduled) {
      this.isScheduled = true
      queueMicrotask(() => {
        this._flush()
        this.isScheduled = false
      })
    }

    return Promise.resolve()
  }

  _flush() {
    if (!this.updates) return Promise.resolve()

    const updates = this.updates
    this.updates = null
    return this.player.updatePlayer(updates).catch(err => {
      console.error('Update player error:', err)
    })
  }

  destroy() {
    this.updates = null
    this.isScheduled = false
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
    this.buffer[this.index] = item
    this.index = (this.index + 1) % this.size
    if (this.count < this.size) this.count++
  }

  getLast() {
    return this.count ? this.buffer[(this.index - 1 + this.size) % this.size] : null
  }

  clear() {
    this.buffer.fill(undefined, 0, this.count)
    this.count = 0
    this.index = 0
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS
  static validModes = VALID_MODES

  playing = false
  paused = false
  connected = false
  destroyed = false
  isAutoplayEnabled = false
  isAutoplay = false
  autoplaySeed = null
  previousIdentifiers = []
  current = null
  position = 0
  timestamp = 0
  ping = 0
  nowPlayingMessage = null
  deaf = true
  mute = false

  constructor(aqua, nodes, options = {}) {
    super()

    this.aqua = aqua
    this.nodes = nodes
    this.guildId = options.guildId
    this.textChannel = options.textChannel
    this.voiceChannel = options.voiceChannel

    this.connection = new Connection(this)
    this.filters = new Filters(this)
    this.queue = new Queue()

    const vol = options.defaultVolume ?? 100
    this.volume = fnIsValidVolume(vol) ? vol : fnClamp(vol)

    this.loop = VALID_MODES.has(options.loop) ? options.loop : LOOP_MODES.NONE
    this.shouldDeleteMessage = !!aqua.options?.shouldDeleteMessage
    this.leaveOnEnd = !!aqua.options?.leaveOnEnd

    this.previousTracks = new CircularBuffer(50)
    this._updateBatcher = new MicrotaskUpdateBatcher(this)
    this._dataStore = new Map()

    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)

    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
  }

  _handlePlayerUpdate(packet) {
    const { position, connected, ping, time } = packet.state
    this.position = position
    this.connected = connected
    this.ping = ping
    this.timestamp = time
    this.aqua.emit('playerUpdate', this, packet)
  }

  async _handleEvent(payload) {
    const handlerName = EVENT_HANDLERS[payload.type]
    if (!handlerName) {
      this.aqua.emit('nodeError', this, new Error(`Unknown event: ${payload.type}`))
      return;
    }

    const handler = this[handlerName]
    if (typeof handler !== 'function') return;

    try {
      await handler.call(this, this, this.current, payload)
    } catch (error) {
      this.aqua.emit('error', error)
    }
  }

  get previous() {
    return this.previousTracks.getLast()
  }

  get currenttrack() {
    return this.current
  }

  getQueue() {
    return this.queue
  }

  batchUpdatePlayer(data, immediate = false) {
    return this._updateBatcher.batch(data, immediate)
  }

  setAutoplay(enabled) {
    this.isAutoplayEnabled = !!enabled
    return this
  }

  async play() {
    if (!this.connected || !this.queue.length) return;

    const item = this.queue.shift()
    this.current = item.track ? item : await item.resolve(this.aqua)
    this.playing = true
    this.position = 0

    return this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true)
  }

  connect(options = null) {
    const guildId = options?.guildId ?? this.guildId
    const voiceChannel = options?.voiceChannel ?? this.voiceChannel
    const deaf = options?.deaf ?? true
    const mute = options?.mute ?? false

    this.deaf = deaf
    this.mute = mute
    this.connected = true
    this.destroyed = false

    this.send({
      guild_id: guildId,
      channel_id: voiceChannel,
      self_deaf: deaf,
      self_mute: mute
    })
    return this
  }

  destroy() {
    if (!this.connected && this.destroyed) return this

    this.connected = false
    this.destroyed = true
    this._updateBatcher?.destroy()

    this.send({ guild_id: this.guildId, channel_id: null })

    fnSafeDeleteMessage(this.nowPlayingMessage)
    this.nowPlayingMessage = null

    this.voiceChannel = null
    this.isAutoplay = false

    this.aqua.destroyPlayer(this.guildId)

    if (this.nodes?.connected) {
      this.nodes.rest.destroyPlayer(this.guildId).catch(error => {
        if (!error.message.includes('ECONNREFUSED')) {
          console.error(`[Player ${this.guildId}] Destroy error:`, error.message)
        }
      })
    }

    this.previousTracks?.clear()
    this._dataStore?.clear()
    this.removeAllListeners()

    this.queue = null
    this.previousTracks = null
    this.connection = null
    this.filters = null
    this._updateBatcher = null
    this._dataStore = null

    return this
  }

  pause(paused) {
    const state = !!paused
    if (this.paused === state) return this
    this.paused = state
    this.batchUpdatePlayer({ paused: state })
    return this
  }

  seek(position) {
    if (!this.playing || !fnIsValidPosition(position)) return this
    const maxPos = this.current?.info?.length
    this.position = maxPos ? Math.min(position, maxPos) : position
    this.batchUpdatePlayer({ position: this.position })
    return this
  }

  stop() {
    if (!this.playing) return this
    this.playing = false
    this.position = 0
    this.batchUpdatePlayer({ track: { encoded: null } }, true)
    return this
  }

  setVolume(volume) {
    if (!fnIsValidVolume(volume)) return this
    const vol = fnClamp(volume)
    if (this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ volume: vol })
    return this
  }

  setLoop(mode) {
    if (!VALID_MODES.has(mode)) throw new Error('Invalid loop mode')
    this.loop = mode
    this.batchUpdatePlayer({ loop: mode })
    return this
  }

  setTextChannel(channel) {
    this.textChannel = channel
    this.batchUpdatePlayer({ text_channel: channel })
    return this
  }

  setVoiceChannel(channel) {
    if (!channel) throw new TypeError('Channel required')

    const targetId = fnToId(channel)
    const currentId = fnToId(this.voiceChannel)
    if (this.connected && targetId === currentId) return this

    this.voiceChannel = channel
    this.connect({
      deaf: this.deaf,
      guildId: this.guildId,
      voiceChannel: channel,
      mute: this.mute
    })
    return this
  }

  disconnect() {
    if (!this.connected) return this
    this.connected = false
    this.voiceChannel = null
    this.send({ guild_id: this.guildId, channel_id: null })
    return this
  }

  shuffle() {
    const queue = this.queue
    const len = queue.length
    for (let i = len - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      const tmp = queue[i]
      queue[i] = queue[j]
      queue[j] = tmp
    }
    return this
  }

  replay() {
    return this.seek(0)
  }

  skip() {
    this.stop()
    return this.play()
  }

  async getLyrics({ query, useCurrentTrack = true, skipTrackSource = false } = {}) {
    if (query) {
      return this.nodes.rest.getLyrics({
        track: { info: { title: query } },
        skipTrackSource
      })
    }

    if (useCurrentTrack && this.playing && this.current) {
      const currentInfo = this.current.info
      return this.nodes.rest.getLyrics({
        track: {
          info: currentInfo,
          encoded: this.current.track,
          identifier: currentInfo.identifier,
          guild_id: this.guildId
        },
        skipTrackSource
      })
    }

    return null
  }

  subscribeLiveLyrics() {
    return this.nodes.rest.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    return this.nodes.rest.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (!this.isAutoplayEnabled || !this.previous) return this

    this.isAutoplay = true
    const { sourceName, identifier, uri, requester, author } = this.previous.info

    try {
      let query = null
      let source = null
      let resolved = null

      if (sourceName === 'youtube') {
        query = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`
        source = 'ytmsearch'
      } else if (sourceName === 'soundcloud') {
        const scResults = await scAutoPlay(uri)
        if (!scResults?.length) return this
        query = scResults[0]
        source = 'scsearch'
      } else if (sourceName === 'spotify') {
        if (this.previous) {
          this.previousIdentifiers.unshift(this.previous.identifier)
          if (this.previousIdentifiers.length >= 20) this.previousIdentifiers.pop()
        }

        if (!this.autoplaySeed) {
          this.autoplaySeed = {
            trackId: identifier,
            artistIds: Array.isArray(author) ? author.join(',') : author
          }
        }

        resolved = await spAutoPlay(
          this.autoplaySeed,
          this,
          requester,
          this.previousIdentifiers
        )
        if (!resolved?.length) return this
      } else {
        return this
      }

      let track = null
      if (resolved) {
        track = resolved[fnRandomIndex(resolved)]
      } else {
        const response = await this.aqua.resolve({ query, source, requester })
        if (!response?.tracks?.length || FAIL_LOAD_TYPES.has(response.loadType)) {
          return this.stop()
        }
        track = response.tracks[fnRandomIndex(response.tracks)]
      }

      if (!track?.info?.title) throw new Error('Invalid track object')

      track.requester = this.previous.requester || { id: 'Unknown' }
      this.queue.push(track)
      await this.play()
      return this
    } catch (err) {
      console.error('Autoplay failed:', err)
      return this.stop()
    }
  }

  async trackStart(player, track) {
    this.playing = true
    this.paused = false
    this.aqua.emit('trackStart', this, track)
  }

  async trackEnd(player, track, payload) {
    if (track) this.previousTracks.push(track)

    fnSafeDeleteMessage(this.nowPlayingMessage)
    this.nowPlayingMessage = null

    const reason = payload.reason

    if (FAILURE_REASONS.has(reason)) {
      if (!this.queue.length) {
        this.clearData()
        this.aqua.emit('queueEnd', this)
      } else {
        this.aqua.emit('trackEnd', this, track, reason)
        await this.play()
      }
      return;
    }

    if (this.loop === LOOP_MODES.TRACK) {
      this.queue.unshift(track)
    } else if (this.loop === LOOP_MODES.QUEUE) {
      this.queue.push(track)
    }

    if (this.queue.isEmpty()) {
      if (this.isAutoplayEnabled) {
        await this.autoplay()
      } else {
        this.playing = false
        if (this.leaveOnEnd) {
          this.clearData()
          this.destroy()
        }
        this.aqua.emit('queueEnd', this)
      }
    } else {
      this.aqua.emit('trackEnd', this, track, reason)
      await this.play()
    }
  }

  async trackError(player, track, payload) {
    this.aqua.emit('trackError', this, track, payload)
    return this.stop()
  }

  async trackStuck(player, track, payload) {
    this.aqua.emit('trackStuck', this, track, payload)
    return this.stop()
  }

  async socketClosed(player, track, payload) {
    if (payload.code === 4014) return this.destroy()

    if (payload.code === 4015) {
      try {
        if (this.connection) {
          this.connection._updatePlayerVoiceData(true)
          this.aqua.emit('debug', `[Player ${this.guildId}] Attempting resume...`)
          return;
        }
      } catch (error) {
        console.error('Resume failed, falling back to reconnect', error)
      }
    }

    if (!RECONNECT_CODES.has(payload.code)) {
      this.aqua.emit('socketClosed', this, payload)
      return;
    }

    try {
      const voiceChannelId = fnToId(this.voiceChannel)
      if (!voiceChannelId) {
        this.aqua.emit('socketClosed', this, payload)
        return;
      }

      const connection = this.connection
      const savedState = {
        sessionId: connection?.sessionId,
        endpoint: connection?.endpoint,
        token: connection?.token,
        region: connection?.region,
        volume: this.volume,
        position: this.position,
        paused: this.paused,
        loop: this.loop,
        isAutoplayEnabled: this.isAutoplayEnabled,
        currentTrack: this.current,
        queue: this.queue ? [...this.queue] : []
      }

      if (!this.destroyed) {
        this.destroy()
        this.aqua.emit('playerDestroy', this)
      }

      const newPlayer = await this.aqua.createConnection({
        guildId: payload.guildId,
        voiceChannel: voiceChannelId,
        textChannel: fnToId(this.textChannel),
        deaf: this.deaf,
        mute: this.mute,
        defaultVolume: savedState.volume
      })

      if (!newPlayer) throw new Error('Failed to create a new player during reconnection.')

      newPlayer.loop = savedState.loop
      newPlayer.isAutoplayEnabled = savedState.isAutoplayEnabled

      if (savedState.sessionId && newPlayer.connection) {
        const newConnection = newPlayer.connection
        newConnection.sessionId = savedState.sessionId
        newConnection.endpoint = savedState.endpoint
        newConnection.token = savedState.token
        newConnection.region = savedState.region
      }

      if (savedState.currentTrack) {
        newPlayer.queue.add(savedState.currentTrack)
        const q = savedState.queue
        const len = q.length
        for (let i = 0; i < len; i++) {
          newPlayer.queue.add(q[i])
        }

        await newPlayer.play()

        if (savedState.position > 5000) {
          setTimeout(() => newPlayer.seek(savedState.position), 1000)
        }

        if (savedState.paused) {
          setTimeout(() => newPlayer.pause(true), 1500)
        }
      }

      this.aqua.emit('playerReconnected', newPlayer, {
        oldPlayer: this,
        restoredState: savedState
      })
    } catch (error) {
      console.error('Reconnection failed:', error)
      this.aqua.emit('reconnectionFailed', this, {
        error,
        code: payload.code,
        payload
      })
      this.aqua.emit('socketClosed', this, payload)
    }
  }

  async lyricsLine(player, track, payload) {
    this.aqua.emit('lyricsLine', this, track, payload)
  }

  async lyricsFound(player, track, payload) {
    this.aqua.emit('lyricsFound', this, track, payload)
  }

  async lyricsNotFound(player, track, payload) {
    this.aqua.emit('lyricsNotFound', this, track, payload)
  }

  send(data) {
    this.aqua.send({ op: 4, d: data })
  }

  set(key, value) {
    this._dataStore.set(key, value)
  }

  get(key) {
    return this._dataStore.get(key)
  }

  clearData() {
    this.previousTracks?.clear()
    this._dataStore?.clear()
    this.previousIdentifiers = []
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  async cleanup() {
    if (!this.playing && !this.paused && this.queue.isEmpty()) this.destroy()
  }
}

module.exports = Player
