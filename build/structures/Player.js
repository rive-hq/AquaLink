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

const AUTOPLAY_MAX_RETRIES = 3
const RECONNECTION_MAX_RETRIES = 3
const RECONNECTION_BACKOFF_MS = 1500

const fnClamp = (v) => {
  const num = +v

  if (num >= 0 && num <= 200) return num

  return num !== num ? 100 : num < 0 ? 0 : 200
}

const fnIsValidVolume = (v) => typeof v === 'number' && v >= 0 && v <= 200 && v === v
const fnIsValidPosition = (p) => typeof p === 'number' && p >= 0 && p === p

const fnRandomIndex = (len) => {

  const result = (Math.random() * len) | 0
  return result >= 0 && result < len ? result : Math.floor(Math.random() * len)
}

const fnToId = (v) => {
  if (!v) return null
  return typeof v === 'string' ? v : v.id || null
}

const fnSafeDeleteMessage = async (msg) => {
  if (msg?.delete) {
    try { await msg.delete() } catch {}
  }
}

class MicrotaskUpdateBatcher {
  constructor(player) {
    this.player = player
    this.updates = null
    this.isScheduled = false
    this.boundFlush = this._flush.bind(this)
    this.pendingImmediate = null
  }

  batch(data, immediate = false) {
    const player = this.player
    if (!player || player.destroyed) {
      return Promise.reject(new Error('Player is destroyed'))
    }

    if (!this.updates) this.updates = Object.create(null)
    Object.assign(this.updates, data)

    if (immediate || ('track' in data) || ('paused' in data) || ('position' in data)) {

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
    if (!this.updates || !this.player || this.player.destroyed) {
      this.updates = null
      this.isScheduled = false
      return Promise.resolve()
    }

    const updates = this.updates
    this.updates = null
    this.isScheduled = false

    return this.player.updatePlayer(updates).catch(err => {

      try {
        this.player?.aqua?.emit?.('error', new Error(`Update player error: ${err.message}`))
      } catch {}
      throw err
    })
  }

  destroy() {
    this.updates = null
    this.isScheduled = false
    this.player = null
    this.boundFlush = null
    this.pendingImmediate = null
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
    if (!this.count) return null
    return this.buffer[(this.index - 1 + this.size) % this.size]
  }

  clear() {

    if (this.count === 0) return

    const clearCount = Math.min(this.count, this.size)
    for (let i = 0; i < clearCount; i++) {
      this.buffer[i] = null
    }
    this.count = 0
    this.index = 0
  }

  toArray() {
    if (!this.count) return []

    const result = new Array(this.count)
    const start = this.count === this.size ? this.index : 0

    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(start + i) % this.size]
      if (item) result[i] = item
    }

    return result.filter(Boolean)
  }
}

class Player extends EventEmitter {
  static LOOP_MODES = LOOP_MODES
  static EVENT_HANDLERS = EVENT_HANDLERS

  constructor(aqua, nodes, options = {}) {
    super()

    if (!aqua) throw new TypeError('Aqua client is required')
    if (!nodes) throw new TypeError('Nodes are required')
    if (!options.guildId) throw new TypeError('Guild ID is required')

    this.aqua = aqua
    this.nodes = nodes

    this.guildId = options.guildId
    this.textChannel = options.textChannel
    this.voiceChannel = options.voiceChannel

    this.playing = false
    this.paused = false
    this.connected = false
    this.destroyed = false
    this.isAutoplayEnabled = false
    this.isAutoplay = false

    this.autoplaySeed = null
    this.current = null
    this.position = 0
    this.timestamp = 0
    this.ping = 0
    this.nowPlayingMessage = null

    this.deaf = options.deaf !== false
    this.mute = !!options.mute

    const vol = +options.defaultVolume || 100
    this.volume = fnIsValidVolume(vol) ? vol : fnClamp(vol)

    let loopMode = LOOP_MODES.NONE
    if (typeof options.loop === 'string') {
      const idx = LOOP_MODE_NAMES.indexOf(options.loop)
      if (idx >= 0 && idx <= 2) loopMode = idx
    } else if (typeof options.loop === 'number' && options.loop >= 0 && options.loop <= 2) {
      loopMode = options.loop
    }
    this.loop = loopMode

    const aquaOptions = aqua.options || {}
    this.shouldDeleteMessage = !!aquaOptions.shouldDeleteMessage
    this.leaveOnEnd = !!aquaOptions.leaveOnEnd

    this.autoplayRetries = 0
    this.reconnectionRetries = 0

    this.connection = new Connection(this)
    this.filters = new Filters(this)
    this.queue = new Queue()

    this.previousIdentifiers = new Set()
    this.previousTracks = new CircularBuffer(50)
    this._updateBatcher = new MicrotaskUpdateBatcher(this)
    this._dataStore = null

    this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this)
    this._boundEvent = this._handleEvent.bind(this)
    this.on('playerUpdate', this._boundPlayerUpdate)
    this.on('event', this._boundEvent)
  }

  _handlePlayerUpdate(packet) {
    if (this.destroyed) return
    const state = packet?.state
    if (!state) return

    this.position = typeof state.position === 'number' ? state.position : 0
    this.connected = !!state.connected
    this.ping = typeof state.ping === 'number' ? state.ping : 0
    this.timestamp = typeof state.time === 'number' ? state.time : Date.now()
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

  get previous() {
    return this.previousTracks?.getLast() || null
  }

  get currenttrack() {
    return this.current
  }

  getQueue() {
    return this.queue
  }

  batchUpdatePlayer(data, immediate = false) {
    if (this.destroyed) return Promise.reject(new Error('Player is destroyed'))
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

      if (!this.current?.track) {
        throw new Error('Failed to resolve track')
      }

      this.playing = true
      this.paused = false
      this.position = 0

      await this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true)
      return this
    } catch (error) {
      this.aqua.emit('error', error)
      return this.queue?.size ? this.play() : this
    }
  }

  connect(options = {}) {
    if (this.destroyed) throw new Error('Cannot connect destroyed player')

    const voiceChannel = fnToId(options.voiceChannel || this.voiceChannel)
    if (!voiceChannel) throw new TypeError('Voice channel is required')

    this.deaf = options.deaf !== undefined ? !!options.deaf : true
    this.mute = !!options.mute
    this.connected = true
    this.destroyed = false
    this.voiceChannel = voiceChannel

    this.send({
      guild_id: options.guildId || this.guildId,
      channel_id: voiceChannel,
      self_deaf: this.deaf,
      self_mute: this.mute
    })
    return this
  }

  destroy({ preserveClient = true, skipRemote = false } = {}) {
    if (this.destroyed) return this

    this.destroyed = true
    this.connected = false
    this.playing = false
    this.paused = false

    this.emit('destroy')

    if (this.nowPlayingMessage) {
      fnSafeDeleteMessage(this.nowPlayingMessage)
      this.nowPlayingMessage = null
    }

    this.off('playerUpdate', this._boundPlayerUpdate)
    this.off('event', this._boundEvent)
    this.removeAllListeners()

    if (this._updateBatcher) {
      this._updateBatcher.destroy()
      this._updateBatcher = null
    }

    if (!skipRemote) {
      try {
        this.send({ guild_id: this.guildId, channel_id: null })
        this.aqua?.destroyPlayer?.(this.guildId)
      } catch (error) {
        console.error(`[Player ${this.guildId}] Destroy error:`, error?.message)
      }

      if (this.nodes?.connected && this.nodes?.rest?.destroyPlayer) {
        this.nodes.rest.destroyPlayer(this.guildId).catch(() => {

        })
      }
    }

    this.voiceChannel = null
    this.isAutoplay = false
    this.autoplayRetries = 0
    this.reconnectionRetries = 0

    this.clearData()

    this.queue = null
    this.connection = null
    this.filters = null
    this._dataStore = null

    if (!preserveClient) {
      this.aqua = null
      this.nodes = null
    }

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
    if (this.destroyed || !this.playing || !fnIsValidPosition(position)) return this
    const maxPos = this.current?.info?.length
    this.position = maxPos ? Math.min(position, maxPos) : position

    this.batchUpdatePlayer({ position: this.position }, true)
    return this
  }

  stop() {
    if (this.destroyed || !this.playing) return this
    this.playing = false
    this.paused = false
    this.position = 0

    this.batchUpdatePlayer({ track: { encoded: null } }, true)
    return this
  }

  setVolume(volume) {
    if (this.destroyed) return this
    const vol = fnClamp(volume)
    if (this.volume === vol) return this
    this.volume = vol
    this.batchUpdatePlayer({ volume: vol })
    return this
  }

  setLoop(mode) {
    if (this.destroyed) return this

    let modeIndex = -1
    if (typeof mode === 'string') {
      modeIndex = LOOP_MODE_NAMES.indexOf(mode)
    } else if (typeof mode === 'number') {
      modeIndex = mode
    }

    if (modeIndex < 0 || modeIndex > 2) {
      throw new Error('Invalid loop mode. Use: none, track, or queue')
    }

    this.loop = modeIndex
    this.batchUpdatePlayer({ loop: LOOP_MODE_NAMES[modeIndex] })
    return this
  }

  setTextChannel(channel) {
    if (this.destroyed) return this
    const channelId = fnToId(channel)
    if (!channelId) throw new TypeError('Invalid text channel')
    this.textChannel = channelId
    this.batchUpdatePlayer({ text_channel: channelId })
    return this
  }

  setVoiceChannel(channel) {
    if (this.destroyed) return this
    const targetId = fnToId(channel)
    if (!targetId) throw new TypeError('Voice channel is required')

    if (this.connected && targetId === fnToId(this.voiceChannel)) return this

    this.voiceChannel = targetId
    this.connect({
      deaf: this.deaf,
      guildId: this.guildId,
      voiceChannel: targetId,
      mute: this.mute
    })
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
    const len = items.length

    if (len <= 1) return this

    for (let i = len - 1; i > 0; i--) {
      const j = fnRandomIndex(i + 1)
      if (i !== j) {

        [items[i], items[j]] = [items[j], items[i]]
      }
    }

    this.queue.clear()
    items.forEach(item => this.queue.push(item))
    return this
  }

  replay() {
    return this.seek(0)
  }

  skip() {
    return this.stop()
  }

  async getLyrics(options = {}) {
    if (this.destroyed || !this.nodes?.rest) return null

    const { query, useCurrentTrack = true, skipTrackSource = false } = options

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
    if (this.destroyed) return Promise.reject(new Error('Player is destroyed'))
    return this.nodes?.rest?.subscribeLiveLyrics(this.guildId, false)
  }

  unsubscribeLiveLyrics() {
    if (this.destroyed) return Promise.reject(new Error('Player is destroyed'))
    return this.nodes?.rest?.unsubscribeLiveLyrics(this.guildId)
  }

  async autoplay() {
    if (this.destroyed || !this.isAutoplayEnabled || !this.previous || this.queue?.size) {
      return this
    }

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
        this.autoplaySeed = {
          trackId: identifier,
          artistIds: Array.isArray(author) ? author.join(',') : author
        }
      }
    }

    let attempts = 0
    while (!this.destroyed && attempts < AUTOPLAY_MAX_RETRIES && !this.queue?.size) {
      attempts++
      try {
        let track = null

        if (sourceName === 'youtube') {
          const query = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`
          const response = await this.aqua.resolve({ query, source: 'ytmsearch', requester })
          if (this._isInvalidResponse(response)) continue
          const tracks = response.tracks
          if (tracks?.length) track = tracks[fnRandomIndex(tracks.length)]
        } else if (sourceName === 'soundcloud') {
          const scResults = await scAutoPlay(uri)
          if (!scResults?.length) continue
          const response = await this.aqua.resolve({ query: scResults[0], source: 'scsearch', requester })
          if (this._isInvalidResponse(response)) continue
          const tracks = response.tracks
          if (tracks?.length) track = tracks[fnRandomIndex(tracks.length)]
        } else if (sourceName === 'spotify') {
          const resolved = await spAutoPlay(
            this.autoplaySeed,
            this,
            requester,
            Array.from(this.previousIdentifiers)
          )
          if (resolved?.length) track = resolved[fnRandomIndex(resolved.length)]
        } else {
          break
        }

        if (!track?.info?.title) continue

        this.autoplayRetries = 0
        track.requester = prev.requester || { id: 'Unknown' }
        this.queue.push(track)
        await this.play()
        return this
      } catch (err) {
        this.aqua.emit('error', new Error(`Autoplay attempt ${attempts} failed: ${err.message}`))
      }
    }

    if (attempts >= AUTOPLAY_MAX_RETRIES) {
      this.aqua.emit('autoplayFailed', this, new Error('Max autoplay retries reached'))
      this.stop()
    }

    return this
  }

  _isInvalidResponse(response) {

    return !response?.tracks?.length ||
           response.loadType === 'error' ||
           response.loadType === 'empty' ||
           response.loadType === 'LOAD_FAILED' ||
           response.loadType === 'NO_MATCHES'
  }

  async trackStart(player, track) {
    if (this.destroyed) return
    this.playing = true
    this.paused = false
    this.aqua.emit('trackStart', this, track)
  }

  async trackEnd(player, track, payload) {
    if (this.destroyed) return

    if (track && this.previousTracks) {
      this.previousTracks.push(track)
    }

    await fnSafeDeleteMessage(this.nowPlayingMessage)
    this.nowPlayingMessage = null

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
      if (this.loop === LOOP_MODES.TRACK) {
        this.queue.unshift(track)
      } else if (this.loop === LOOP_MODES.QUEUE) {
        this.queue.push(track)
      }
    }

    if (this.queue?.size) {
      this.aqua.emit('trackEnd', this, track, reason)
      await this.play()
      return
    }

    if (this.isAutoplayEnabled && !isReplaced) {
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

  async socketClosed(player, track, payload) {
    if (this.destroyed) return

    const code = payload?.code

    if (code === 4014 || code === 4022) {
      this.aqua.emit('socketClosed', this, payload)
      this.destroy()
      return
    }

    if (code === 4015) {
      try {
        if (this.connection) {
          this.connection.resendVoiceUpdate(true)
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

    const aquaRef = this.aqua
    const voiceChannelId = fnToId(this.voiceChannel)
    const textChannelId = fnToId(this.textChannel)

    if (!voiceChannelId) {
      aquaRef?.emit?.('socketClosed', this, payload)
      return
    }

    const savedState = {
      volume: this.volume,
      position: this.position,
      paused: this.paused,
      loop: this.loop,
      isAutoplayEnabled: this.isAutoplayEnabled,
      currentTrack: this.current,
      queue: this.queue?.toArray() || [],
      previousIdentifiers: this.previousIdentifiers ? [...this.previousIdentifiers] : [],
      autoplaySeed: this.autoplaySeed
    }

    const oldPlayer = this

    oldPlayer.destroy({ preserveClient: true, skipRemote: true })

    let attempt = 0
    const tryReconnect = async () => {
      attempt++
      try {
        const newPlayer = await aquaRef.createConnection({
          guildId: oldPlayer.guildId,
          voiceChannel: voiceChannelId,
          textChannel: textChannelId,
          deaf: oldPlayer.deaf,
          mute: oldPlayer.mute,
          defaultVolume: savedState.volume
        })

        if (!newPlayer) {
          throw new Error('Failed to create new player during reconnection')
        }

        newPlayer.reconnectionRetries = 0
        newPlayer.loop = savedState.loop
        newPlayer.isAutoplayEnabled = savedState.isAutoplayEnabled
        newPlayer.autoplaySeed = savedState.autoplaySeed

        if (savedState.currentTrack) {
          newPlayer.queue.unshift(savedState.currentTrack)
        }

        if (savedState.queue.length) {
          for (const item of savedState.queue) {
            if (item !== savedState.currentTrack) {
              newPlayer.queue.push(item)
            }
          }
        }

        if (savedState.previousIdentifiers.length) {
          newPlayer.previousIdentifiers = new Set(savedState.previousIdentifiers)
        }

        if (savedState.currentTrack) {
          await newPlayer.play()

          if (savedState.position > 5000) {
            setTimeout(() => !newPlayer.destroyed && newPlayer.seek(savedState.position), 800)
          }
          if (savedState.paused) {
            setTimeout(() => !newPlayer.destroyed && newPlayer.pause(true), 1200)
          }
        }

        aquaRef.emit('playerReconnected', newPlayer, {
          oldPlayer,
          restoredState: savedState
        })
      } catch (error) {
        const retriesLeft = RECONNECTION_MAX_RETRIES - attempt
        aquaRef.emit('reconnectionFailed', oldPlayer, {
          error,
          code,
          payload,
          retriesLeft
        })
        if (retriesLeft > 0) {
          setTimeout(tryReconnect, RECONNECTION_BACKOFF_MS)
        } else {
          aquaRef.emit('socketClosed', oldPlayer, payload)
        }
      }
    }

    tryReconnect()
  }

  async lyricsLine(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('lyricsLine', this, track, payload)
  }

  async lyricsFound(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('lyricsFound', this, track, payload)
  }

  async lyricsNotFound(player, track, payload) {
    if (this.destroyed) return
    this.aqua.emit('lyricsNotFound', this, track, payload)
  }

  send(data) {
    try {
      this.aqua.send({ op: 4, d: data })
    } catch (error) {
      this.aqua.emit('error', new Error(`Failed to send data: ${error.message}`))
    }
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
    this.current = null
    this.position = 0
    this.timestamp = 0
    return this
  }

  updatePlayer(data) {
    if (this.destroyed) return Promise.reject(new Error('Player is destroyed'))
    if (!this.nodes?.rest) return Promise.reject(new Error('Nodes not available'))
    return this.nodes.rest.updatePlayer({ guildId: this.guildId, data })
  }

  async cleanup() {
    if (!this.playing && !this.paused && this.queue?.isEmpty?.()) {
      this.destroy()
    }
  }
}

module.exports = Player
