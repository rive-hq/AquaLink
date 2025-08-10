'use strict'

const ENDPOINT_REGEX = /^(?<region>[a-z-]+)(?:-\d+\.discord\.media(?::\d+)?|\d+)/i
class Connection {
  constructor(player) {
    this._player = player
    this._aqua = player.aqua
    this._nodes = player.nodes
    this._guildId = player.guildId
    this._clientId = player.aqua.clientId

    Object.assign(this, {
      voiceChannel: player.voiceChannel,
      sessionId: null,
      endpoint: null,
      token: null,
      region: null,
      sequence: 0,
      _lastEndpoint: null,
      _pendingUpdate: null,
      _updateTimer: null
    })

    this._hasDebugListeners = false
    this._hasMoveListeners = false
    this._checkListeners()
  }

  _checkListeners() {
    this._hasDebugListeners = this._aqua.listenerCount('debug') > 0
    this._hasMoveListeners = this._aqua.listenerCount('playerMove') > 0
  }

  _extractRegion(endpoint) {
    if (!endpoint) return null
    const match = ENDPOINT_REGEX.exec(endpoint)
    return match?.groups?.region || match?.[1] || null
  }

  setServerUpdate(data) {
    if (!data?.endpoint || !data.token) return

    const newEndpoint = data.endpoint
    const trimmedEndpoint = /^\s|\s$/.test(newEndpoint) ? newEndpoint.trim() : newEndpoint

    const newRegion = this._extractRegion(trimmedEndpoint)
    const hasChanges = this.region !== newRegion || this._lastEndpoint !== trimmedEndpoint

    if (hasChanges) {
      if (this.region !== newRegion && this._hasDebugListeners) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Region: ${this.region || 'none'} → ${newRegion}`)
      }

      if (this._lastEndpoint !== trimmedEndpoint) {
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

  setStateUpdate(data) {
    if (!data || data.user_id !== this._clientId) return

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

      Object.assign(this._player, {
        self_deaf: !!self_deaf,
        self_mute: !!self_mute,
        connected: true
      })

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

    this._player.destroy()
  }

  updateSequence(seq) {
    this.sequence = seq > this.sequence ? seq : this.sequence
  }

  _clearPendingUpdate() {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer)
      this._updateTimer = null
    }
    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate(isResume = false) {
    if (!this.sessionId || !this.endpoint || !this.token) return

    this._clearPendingUpdate()

    this._pendingUpdate = { isResume }

    this._updateTimer = setTimeout(() => this._executeVoiceUpdate(), 0)
  }

  _executeVoiceUpdate() {
    if (!this._pendingUpdate) return

    const { isResume } = this._pendingUpdate
    this._pendingUpdate = null
    this._updateTimer = null

    const payload = {
      guildId: this._guildId,
      data: {
        voice: {
          token: this.token,
          endpoint: this.endpoint,
          sessionId: this.sessionId
        },
        volume: this._player.volume
      }
    }

    if (isResume) {
      payload.data.voice.resume = true
      payload.data.voice.sequence = this.sequence
    }

    this._sendUpdate(payload)
  }

  async _sendUpdate(payload) {
    try {
      await this._nodes.rest.updatePlayer(payload)
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' && this._hasDebugListeners) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Update failed: ${error.message}`)
      }
    }
  }

  destroy() {
    this._clearPendingUpdate()
    this._player = null
    this._aqua = null
    this._nodes = null
  }
}

module.exports = Connection
