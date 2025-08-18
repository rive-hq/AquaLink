'use strict'

const POOL_SIZE = 10
const LISTENER_CHECK_INTERVAL = 5000
const UPDATE_TIMEOUT = 5000

const ENDPOINT_PATTERN = /^([a-z-]+)/i

const STATE_FLAGS = {
  CONNECTED: 1 << 0,
  PAUSED: 1 << 1,
  SELF_DEAF: 1 << 2,
  SELF_MUTE: 1 << 3,
  HAS_DEBUG_LISTENERS: 1 << 4,
  HAS_MOVE_LISTENERS: 1 << 5,
  UPDATE_SCHEDULED: 1 << 6
}

class UpdatePayloadPool {
  constructor() {
    this.pool = new Array(POOL_SIZE)
    this.size = 0

    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool[i] = this._createPayload()
    }
    this.size = POOL_SIZE
  }

  _createPayload() {
    return {
      guildId: null,
      data: {
        voice: {
          token: null,
          endpoint: null,
          sessionId: null,
          resume: undefined,
          sequence: undefined
        },
        volume: null
      }
    }
  }

  acquire() {
    if (this.size > 0) {
      return this.pool[--this.size]
    }
    return this._createPayload()
  }

  release(payload) {
    if (!payload || this.size >= POOL_SIZE) return

    payload.guildId = null
    const voice = payload.data.voice
    voice.token = null
    voice.endpoint = null
    voice.sessionId = null
    voice.resume = undefined
    voice.sequence = undefined
    payload.data.volume = null

    this.pool[this.size++] = payload
  }
}

const sharedPayloadPool = new UpdatePayloadPool()

class Connection {
  constructor(player) {
    // Validate once
    if (!player?.aqua?.clientId || !player.nodes) {
      throw new TypeError('Invalid player configuration')
    }

    this._player = player
    this._aqua = player.aqua
    this._nodes = player.nodes
    this._guildId = player.guildId
    this._clientId = player.aqua.clientId

    this.voiceChannel = player.voiceChannel
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this.sequence = 0
    this._lastEndpoint = null
    this._pendingUpdate = null

    this._stateFlags = 0
    this._lastListenerCheck = 0

    this._payloadPool = sharedPayloadPool

    this._executeVoiceUpdate = this._executeVoiceUpdate.bind(this)

    this._checkListeners()
  }

  _checkListeners() {
    const now = Date.now()
    if (now - this._lastListenerCheck < LISTENER_CHECK_INTERVAL) {
      return
    }

    let flags = this._stateFlags
    flags = this._aqua.listenerCount('debug') > 0
      ? flags | STATE_FLAGS.HAS_DEBUG_LISTENERS
      : flags & ~STATE_FLAGS.HAS_DEBUG_LISTENERS

    flags = this._aqua.listenerCount('playerMove') > 0
      ? flags | STATE_FLAGS.HAS_MOVE_LISTENERS
      : flags & ~STATE_FLAGS.HAS_MOVE_LISTENERS

    this._stateFlags = flags
    this._lastListenerCheck = now
  }

  _extractRegion(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return null

    const dashIndex = endpoint.indexOf('-')
    if (dashIndex > 0) {
      const region = endpoint.substring(0, dashIndex)
      let isValid = true
      for (let i = 0; i < region.length; i++) {
        const code = region.charCodeAt(i)
        if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
          isValid = false
          break
        }
      }
      if (isValid) return region
    }

    const match = ENDPOINT_PATTERN.exec(endpoint)
    return match?.[1] || null
  }

  setServerUpdate(data) {
    if (!data?.endpoint || !data.token ||
        typeof data.endpoint !== 'string' ||
        typeof data.token !== 'string') {
      return
    }

    const trimmedEndpoint = data.endpoint.trim()

    if (this._lastEndpoint === trimmedEndpoint && this.token === data.token) {
      return
    }

    const newRegion = this._extractRegion(trimmedEndpoint)

    const hasRegionChange = this.region !== newRegion
    const hasEndpointChange = this._lastEndpoint !== trimmedEndpoint

    if (hasRegionChange || hasEndpointChange) {
      if (hasRegionChange && (this._stateFlags & STATE_FLAGS.HAS_DEBUG_LISTENERS)) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Region: ${this.region || 'none'} → ${newRegion}`)
      }

      if (hasEndpointChange) {
        this.sequence = 0
        this._lastEndpoint = trimmedEndpoint
      }

      this.endpoint = trimmedEndpoint
      this.region = newRegion
    }

    this.token = data.token

    if (this._player.paused) {
      this._player.paused = false
    }

    this._scheduleVoiceUpdate()
  }

  resendVoiceUpdate({ resume = false } = {}) {
    if (!(this.sessionId && this.endpoint && this.token)) {
      return false
    }

    this._scheduleVoiceUpdate(resume)
    return true
  }

  setStateUpdate(data) {
    if (!data || data.user_id !== this._clientId) {
      return
    }

    const { session_id, channel_id, self_deaf, self_mute } = data

    if (channel_id) {
      let needsUpdate = false

      if (this.voiceChannel !== channel_id) {
        if (this._stateFlags & STATE_FLAGS.HAS_MOVE_LISTENERS) {
          this._aqua.emit('playerMove', this.voiceChannel, channel_id)
        }
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
        needsUpdate = true
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
        needsUpdate = true
      }


      this._player.self_deaf = !!self_deaf
      this._player.self_mute = !!self_mute
      this._player.connected = true

      if (needsUpdate) {
        this._scheduleVoiceUpdate()
      }
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (!this._player?.connected) return

    if (this._stateFlags & STATE_FLAGS.HAS_DEBUG_LISTENERS) {
      this._aqua.emit('debug', `[Player ${this._guildId}] Disconnected`)
    }

    this._clearPendingUpdate()

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0

    try {
      this._player.destroy()
    } catch (error) {
      this._aqua.emit('error', new Error(`Player destroy failed: ${error.message}`))
    }
  }

  async attemptResume() {
    if (!(this.sessionId && this.endpoint && this.token)) {
      throw new Error('Missing required voice state')
    }

    const payload = this._payloadPool.acquire()

    try {
      payload.guildId = this._guildId
      payload.data.voice.token = this.token
      payload.data.voice.endpoint = this.endpoint
      payload.data.voice.sessionId = this.sessionId
      payload.data.voice.resume = true
      payload.data.volume = this._player?.volume

      if (this.sequence >= 0 && Number.isFinite(this.sequence)) {
        payload.data.voice.sequence = this.sequence
      }

      await this._sendUpdate(payload)
      return true
    } catch (error) {
      if (this._stateFlags & STATE_FLAGS.HAS_DEBUG_LISTENERS) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Resume update failed: ${error?.message}`)
      }
      return false
    } finally {
      this._payloadPool.release(payload)
    }
  }

  updateSequence(seq) {
    if (typeof seq === 'number' && seq >= 0 && Number.isFinite(seq)) {
      this.sequence = Math.max(seq, this.sequence)
    }
  }

  _clearPendingUpdate() {
    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED

    if (this._pendingUpdate?.payload) {
      this._payloadPool.release(this._pendingUpdate.payload)
    }

    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate(isResume = false) {
    if (!(this.sessionId && this.endpoint && this.token)) {
      return
    }

    if (this._stateFlags & STATE_FLAGS.UPDATE_SCHEDULED) {
      return
    }

    this._clearPendingUpdate()

    const payload = this._payloadPool.acquire()

    payload.guildId = this._guildId
    const voice = payload.data.voice
    voice.token = this.token
    voice.endpoint = this.endpoint
    voice.sessionId = this.sessionId
    payload.data.volume = this._player.volume

    if (isResume) {
      voice.resume = true
      voice.sequence = this.sequence
    }

    this._pendingUpdate = {
      isResume,
      payload,
      timestamp: Date.now()
    }

    this._stateFlags |= STATE_FLAGS.UPDATE_SCHEDULED

    queueMicrotask(this._executeVoiceUpdate)
  }

  _executeVoiceUpdate() {
    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED

    const pending = this._pendingUpdate
    if (!pending) return

    if (Date.now() - pending.timestamp > UPDATE_TIMEOUT) {
      this._payloadPool.release(pending.payload)
      this._pendingUpdate = null
      return
    }

    const payload = pending.payload
    this._pendingUpdate = null

    // to avoid any delay. Uncomment, cuz im too lazy
    // if (pending.isResume) {
    //   this._sendUpdateSync(payload)
    //   return
    // }

    this._sendUpdate(payload)
      .finally(() => {
        this._payloadPool.release(payload)
      })
  }

  async _sendUpdate(payload) {
    if (!this._nodes?.rest) {
      throw new Error('Nodes or REST interface not available')
    }

    try {
      await this._nodes.rest.updatePlayer(payload)
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' &&
          error.code !== 'ENOTFOUND' &&
          (this._stateFlags & STATE_FLAGS.HAS_DEBUG_LISTENERS)) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Update failed: ${error.message}`)
      }
      throw error
    }
  }

  destroy() {
    this._clearPendingUpdate()

    this._player = null
    this._aqua = null
    this._nodes = null
    this._payloadPool = null

    this.voiceChannel = null
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this._lastEndpoint = null
    this._stateFlags = 0
  }
}

module.exports = Connection
