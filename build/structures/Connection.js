'use strict'

const ENDPOINT_REGEX = /^([a-z\-]+)(?:-\d+\.discord\.media(?::\d+)?|\d+)/i

class Connection {
  constructor(player) {
    this.player = player
    this.voiceChannel = player.voiceChannel
    this.guildId = player.guildId
    this.aqua = player.aqua
    this.nodes = player.nodes
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
  }

  _extractRegionFromEndpoint(endpoint) {
    if (!endpoint) return null
    const match = endpoint.match(ENDPOINT_REGEX)
    return match ? match[1] : 'unknown'
  }

  setServerUpdate(data) {
    if (!data?.endpoint || !data?.token) return

    const fullEndpoint = data.endpoint.trim()
    const newRegion = this._extractRegionFromEndpoint(fullEndpoint)

    if (this.region !== newRegion) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Voice region: ${this.region || 'none'} → ${newRegion}`)
    }

    this.endpoint = fullEndpoint
    this.token = data.token
    this.region = newRegion

    if (this.player.paused) this.player.paused = false
    this._updatePlayerVoiceData()
  }

  setStateUpdate(data) {
    if (!data || data.user_id !== this.aqua.clientId) return

    const { session_id, channel_id, self_deaf, self_mute } = data

    if (channel_id) {
      if (this.voiceChannel !== channel_id) {
        this.aqua.emit('playerMove', this.voiceChannel, channel_id)
        this.voiceChannel = channel_id
        this.player.voiceChannel = channel_id
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
      }

      this.player.self_deaf = !!self_deaf
      this.player.self_mute = !!self_mute
      this.player.connected = true

      this._updatePlayerVoiceData()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (!this.player.connected) return

    this.aqua.emit('debug', `[Player ${this.guildId}] Voice disconnected`)
    this.voiceChannel = null
    this.player.voiceChannel = null
    this.player.destroy()
  }

  _updatePlayerVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) return


    setImmediate(() => {

      try {
        this.nodes.rest.updatePlayer({
          guildId: this.guildId,
          data: {
            voice: {
              token: this.token,
              endpoint: this.endpoint,
              sessionId: this.sessionId
            },
            volume: this.player.volume
          }
        })
      } catch (error) {
        if (!error.message.includes('ECONNREFUSED')) {
          this.aqua.emit('debug', `[Player ${this.guildId}] Update error: ${error.message}`)
        }
      }
    })
  }
}

module.exports = Connection
