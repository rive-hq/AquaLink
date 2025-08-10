'use strict'

const { EventEmitter } = require('tseep')
const Connection = require('./Connection')
const Queue = require('./Queue')
const Filters = require('./Filters')
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay')

const LOOP_MODES = Object.freeze({
  NONE: 0,
  TRACK: 1,
  QUEUE: 2
})

const LOOP_MODE_NAMES = Object.freeze(['none', 'track', 'queue'])

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

const fnClamp = (v) => {
  const num = +v || 0
  return num < 0 ? 0 : num > 200 ? 200 : num
}

const fnIsValidVolume = (v) => typeof v === 'number' && v >= 0 && v <= 200
const fnIsValidPosition = (p) => typeof p === 'number' && p >= 0 && !Number.isNaN(p)
const fnRandomIndex = (len) => (Math.random() * len) >>> 0
const fnToId = (v) => v?.id || v

const fnSafeDeleteMessage = (msg) => {
  if (msg?.delete) msg.delete().catch(() => { })
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.isScheduled = false
    this.boundFlush = this._flush.bind(this)
  }

  batch(data, immediate = false) {
    if (!this.updates) {
      this.updates = Object.create(null)
    }

    for (const key in data) {
      this.updates[key] = data[key]
    }

    if (immediate || data.track) {
      return this._flush()
    }

    if (!this.isScheduled) {
      this.isScheduled = true
      queueMicrotask(this.boundFlush)
    }

    return Promise.resolve()
  }

  _flush() {
    if (!this.updates) return Promise.resolve()

    const updates = this.updates
    this.updates = null
    this.isScheduled = false

    return this.player.updatePlayer(updates).catch(err => {
      console.error('Update player error:', err)
    })
  }

  destroy() {
    this.updates = null
    this.isScheduled = false
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
    this.buffer[this.index] = item
    this.index = (this.index + 1) % this.size
    if (this.count < this.size) this.count++
  }

  getLast() {
    if (!this.count) return null
    return this.buffer[(this.index - 1 + this.size) % this.size]
  }

  clear() {

    for (let i = 0; i < this.count; i++) {
      this.buffer[i] = undefined
    }
    this.count = 0
    this.index = 0
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS

  playing = false
  paused = false
  connected = false
  destroyed = false
  isAutoplayEnabled = false
  isAutoplay = false
  autoplaySeed = null
  current = null
  position = 0
  timestamp = 0
  ping = 0
  nowPlayingMessage = null
  deaf = true
  mute = false
  volume = 100
  loop = LOOP_MODES.NONE

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

    const loopName = options.loop
    this.loop = LOOP_MODE_NAMES.indexOf(loopName) !== -1
      ? LOOP_MODE_NAMES.indexOf(loopName)
      : LOOP_MODES.NONE

    this.shouldDeleteMessage = !!aqua.options?.shouldDeleteMessage
    this.leaveOnEnd = !!aqua.options?.leaveOnEnd

    this.previousIdentifiers = new Set()
    this.previousTracks = new CircularBuffer(50)
    this._updateBatcher = new MicrotaskUpdateBatcher(this)
    this._dataStore = new Map()

    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)

    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
  }

  _handlePlayerUpdate(packet) {
    const state = packet.state
    this.position = state.position
    this.connected = state.connected
    this.ping = state.ping
    this.timestamp = state.time
    this.aqua.emit('playerUpdate', this, packet)
  }

  async _handleEvent(payload) {
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
    if (!this.connected || this.queue.isEmpty()) return

    const item = this.queue.shift()
    this.current = item.track ? item : await item.resolve(this.aqua)
    this.playing = true
    this.position = 0

    return this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true)
  }

  connect(options = null) {
    const opts = options || {}
    const guildId = opts.guildId || this.guildId
    const voiceChannel = opts.voiceChannel || this.voiceChannel
    const deaf = opts.deaf !== undefined ? opts.deaf : true
    const mute = opts.mute || false

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
    this.previousIdentifiers?.clear()

    this.off('playerUpdate', this._boundPlayerUpdate)
    this.off('event', this._boundEvent)
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
    const modeIndex = typeof mode === 'string'
      ? LOOP_MODE_NAMES.indexOf(mode)
      : mode

    if (modeIndex === -1 || modeIndex > 2) {
      throw new Error('Invalid loop mode')
    }

    this.loop = modeIndex
    this.batchUpdatePlayer({ loop: LOOP_MODE_NAMES[modeIndex] })
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
    if (this.queue.isEmpty()) return this

    const items = Array.from(this.queue)
    const len = items.length

    for (let i = len - 1; i > 0; i--) {
      const j = fnRandomIndex(i + 1)
      if (i !== j) {
        const tmp = items[i]
        items[i] = items[j]
        items[j] = tmp
      }
    }

    this.queue = new Queue()
    for (let i = 0; i < len; i++) {
      this.queue.push(items[i])
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
    const prevInfo = this.previous.info
    const { sourceName, identifier, uri, requester, author } = prevInfo

    try {
      let query = null
      let source = null
      let resolved = null

      switch (sourceName) {
        case 'youtube':

          query = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`
          source = 'ytmsearch'
          break

        case 'soundcloud':
          const scResults = await scAutoPlay(uri)
          if (!scResults?.length) return this
          query = scResults[0]
          source = 'scsearch'
          break

        case 'spotify':

          if (this.previous) {
            this.previousIdentifiers.add(this.previous.identifier)

            if (this.previousIdentifiers.size > 20) {
              const first = this.previousIdentifiers.values().next().value
              this.previousIdentifiers.delete(first)
            }
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
            Array.from(this.previousIdentifiers)
          )
          if (!resolved?.length) return this
          break

        default:
          return this
      }

      let track = null
      if (resolved) {
        track = resolved[fnRandomIndex(resolved.length)]
      } else if (query) {
        const response = await this.aqua.resolve({ query, source, requester })
        const tracks = response?.tracks

        if (!tracks?.length ||
          response.loadType === 'error' ||
          response.loadType === 'empty' ||
          response.loadType === 'LOAD_FAILED' ||
          response.loadType === 'NO_MATCHES') {
          return this.stop()
        }

        track = tracks[fnRandomIndex(tracks.length)]
      }

      if (!track?.info?.title) {
        throw new Error('Invalid track object')
      }

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
    const isFailure = reason === 'LOAD_FAILED' || reason === 'CLEANUP'

    if (isFailure) {
      if (this.queue.isEmpty()) {
        this.clearData()
        this.aqua.emit('queueEnd', this)
      } else {
        this.aqua.emit('trackEnd', this, track, reason)
        await this.play()
      }
      return
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
    const code = payload.code

    if (code === 4014) return this.destroy()

    if (code === 4015) {
      try {
        if (this.connection) {
          this.connection._updatePlayerVoiceData(true)
          this.aqua.emit('debug', `[Player ${this.guildId}] Attempting resume...`)
          return
        }
      } catch (error) {
        console.error('Resume failed, falling back to reconnect', error)
      }
    }

    if (code !== 4015 && code !== 4009 && code !== 4006) {
      this.aqua.emit('socketClosed', this, payload)
      return
    }

    try {
      const voiceChannelId = fnToId(this.voiceChannel)
      if (!voiceChannelId) {
        this.aqua.emit('socketClosed', this, payload)
        return
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
        queue: this.queue ? Array.from(this.queue) : []
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

      if (!newPlayer) {
        throw new Error('Failed to create a new player during reconnection.')
      }

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
        newPlayer.queue.push(savedState.currentTrack)

        const q = savedState.queue
        for (let i = 0, len = q.length; i < len; i++) {
          newPlayer.queue.push(q[i])
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
    this.previousIdentifiers?.clear()
    return this
  }

  updatePlayer(data) {
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  async cleanup() {
    if (!this.playing && !this.paused && this.queue.isEmpty()) {
      this.destroy()
    }
  }
}

module.exports = Player
