'use strict'

const ENDPOINT_REGEX = /^([a-z-]+)/i
const WHITESPACE_REGEX = /^\s+|\s+$/g

class UpdatePayloadPool {
  constructor() {
    this.pool = []
  }

  acquire() {
    return this.pool.pop() || {
      guildId: null,
      data: {
        voice: {
          token: null,
          endpoint: null,
          sessionId: null
        },
        volume: null
      }
    }
  }

  release(payload) {
    payload.guildId = null
    payload.data.voice.token = null
    payload.data.voice.endpoint = null
    payload.data.voice.sessionId = null
    payload.data.volume = null
    delete payload.data.voice.resume
    delete payload.data.voice.sequence

    if (this.pool.length < 10) {
      this.pool.push(payload)
    }
  }
}

class Connection {
  constructor(player) {
    if (!player) throw new TypeError('Player is required: CONNECTION')
    if (!player.aqua) throw new TypeError('Player.aqua is required: CONNECTION')
    if (!player.nodes) throw new TypeError('Player.nodes is required: CONNECTION')

    this._player = player
    this._aqua = player.aqua
    this._nodes = player.nodes
    this._guildId = player.guildId
    this._clientId = player.aqua.clientId

    const state = Object.create(null)
    state.voiceChannel = player.voiceChannel
    state.sessionId = null
    state.endpoint = null
    state.token = null
    state.region = null
    state.sequence = 0
    state._lastEndpoint = null
    state._pendingUpdate = null
    state._updateTimer = null

    Object.assign(this, state)

    this._hasDebugListeners = false
    this._hasMoveListeners = false
    this._lastListenerCheck = 0
    this._listenerCheckInterval = 5000

    this._payloadPool = new UpdatePayloadPool()

    this._checkListeners()
  }

  _checkListeners() {
    const now = Date.now()
    if (now - this._lastListenerCheck < this._listenerCheckInterval) {
      return
    }

    this._hasDebugListeners = this._aqua.listenerCount('debug') > 0
    this._hasMoveListeners = this._aqua.listenerCount('playerMove') > 0
    this._lastListenerCheck = now
  }

  _extractRegion(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return null

    const match = ENDPOINT_REGEX.exec(endpoint)
    return match ? match[1] : null
  }

  setServerUpdate(data) {
    if (!data || typeof data !== 'object') return
    if (!data.endpoint || typeof data.endpoint !== 'string') return
    if (!data.token || typeof data.token !== 'string') return

    const newEndpoint = data.endpoint
    const hasWhitespace = WHITESPACE_REGEX.test(newEndpoint)
    const trimmedEndpoint = hasWhitespace ? newEndpoint.trim() : newEndpoint

    const newRegion = this._extractRegion(trimmedEndpoint)
    const hasRegionChange = this.region !== newRegion
    const hasEndpointChange = this._lastEndpoint !== trimmedEndpoint

    if (hasRegionChange || hasEndpointChange) {
      if (hasRegionChange && this._hasDebugListeners) {
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
    if (!this.sessionId || !this.endpoint || !this.token) {
      return false
    }

    this._scheduleVoiceUpdate(resume)
    return true
  }

  setStateUpdate(data) {
    if (!data ||
        typeof data !== 'object' ||
        data.user_id !== this._clientId) {
      return
    }

    const { session_id, channel_id, self_deaf, self_mute } = data

    if (channel_id) {
      if (this.voiceChannel !== channel_id) {
        if (this._hasMoveListeners) {
          this._aqua.emit('playerMove', this.voiceChannel, channel_id)
        }
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
      }

      const playerUpdates = Object.create(null)
      playerUpdates.self_deaf = !!self_deaf
      playerUpdates.self_mute = !!self_mute
      playerUpdates.connected = true

      Object.assign(this._player, playerUpdates)

      this._scheduleVoiceUpdate()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (!this._player.connected) return

    if (this._hasDebugListeners) {
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

  updateSequence(seq) {
    if (typeof seq !== 'number' || seq < 0 || !Number.isFinite(seq)) {
      return
    }

    this.sequence = Math.max(seq, this.sequence)
  }

  _clearPendingUpdate() {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer)
      this._updateTimer = null
    }

    if (this._pendingUpdate && this._pendingUpdate.payload) {
      this._payloadPool.release(this._pendingUpdate.payload)
    }

    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate(isResume = false) {
    if (!this.sessionId || !this.endpoint || !this.token) {
      return
    }

    this._clearPendingUpdate()

    const payload = this._payloadPool.acquire()
    payload.guildId = this._guildId
    payload.data.voice.token = this.token
    payload.data.voice.endpoint = this.endpoint
    payload.data.voice.sessionId = this.sessionId
    payload.data.volume = this._player.volume

    if (isResume) {
      payload.data.voice.resume = true
      payload.data.voice.sequence = this.sequence
    }

    this._pendingUpdate = {
      isResume,
      payload,
      timestamp: Date.now()
    }

    this._updateTimer = setImmediate(() => this._executeVoiceUpdate())
  }

  _executeVoiceUpdate() {
    const pending = this._pendingUpdate
    if (!pending) return

    this._updateTimer = null

    const age = Date.now() - pending.timestamp
    if (age > 5000) {
      this._payloadPool.release(pending.payload)
      this._pendingUpdate = null
      return
    }

    const payload = pending.payload
    this._pendingUpdate = null

    this._sendUpdate(payload)
      .finally(() => {
        this._payloadPool.release(payload)
      })
  }

  async _sendUpdate(payload) {
    if (!this._nodes || !this._nodes.rest) {
      throw new Error('Nodes or REST interface not available')
    }

    try {
      await this._nodes.rest.updatePlayer(payload)
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' &&
          error.code !== 'ENOTFOUND' &&
          this._hasDebugListeners) {
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
  }
}

module.exports = Connection
