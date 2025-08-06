'use strict'

const ENDPOINT_REGEX = /^([a-z-]+)(?:-\d+\.discord\.media(?::\d+)?|\d+)/i

class Connection {
  constructor(player) {
    this._player = player
    this._aqua = player.aqua
    this._nodes = player.nodes
    this._guildId = player.guildId

    this.voiceChannel = player.voiceChannel
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null

    this.sequence = 0
    this._lastEndpoint = null
  }

  _extractRegion(endpoint) {
    const match = endpoint?.match(ENDPOINT_REGEX)
    return match?.[1] || null
  }

  setServerUpdate(data) {
    if (!data?.endpoint || !data?.token) return

    const newEndpoint = data.endpoint.trim()
    const newRegion = this._extractRegion(newEndpoint)
    const regionChanged = this.region !== newRegion
    const endpointChanged = this._lastEndpoint !== newEndpoint

    if (regionChanged || endpointChanged) {
      if (regionChanged && this._aqua.listenerCount('debug') > 0) {
        this._aqua.emit('debug', `[Player ${this._guildId}] Region: ${this.region || 'none'} → ${newRegion}`)
      }

      if (endpointChanged) {
        this.sequence = 0
        this._lastEndpoint = newEndpoint
      }

      this.endpoint = newEndpoint
      this.region = newRegion
    }

    this.token = data.token

    if (this._player.paused) {
      this._player.paused = false
    }

    this._updateVoiceData()
  }

  setStateUpdate(data) {
    if (!data || data.user_id !== this._aqua.clientId) return

    const { session_id, channel_id, self_deaf, self_mute } = data

    if (channel_id) {
      if (this.voiceChannel !== channel_id) {
        if (this._aqua.listenerCount('playerMove') > 0) {
          this._aqua.emit('playerMove', this.voiceChannel, channel_id)
        }
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
      }

      this._player.self_deaf = !!self_deaf
      this._player.self_mute = !!self_mute
      this._player.connected = true

      this._updateVoiceData()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (!this._player.connected) return

    this._aqua.emit('debug', `[Player ${this._guildId}] Disconnected`)

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0

    this._player.destroy()
  }

  updateSequence(seq) {
    this.sequence = seq > this.sequence ? seq : this.sequence
  }

  _updateVoiceData(isResume = false) {
    if (!this.sessionId || !this.endpoint || !this.token) return

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

    setImmediate(() => {
      try {
        this._nodes.rest.updatePlayer(payload)
      } catch (error) {
        if (!error.message.includes('ECONNREFUSED')) {
          this._aqua.emit('debug', `[Player ${this._guildId}] Update failed: ${error.message}`)
        }
      }
    })
  }
}

module.exports = Connection
