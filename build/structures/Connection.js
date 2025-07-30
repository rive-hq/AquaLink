'use strict'

const LEGACY_ENDPOINT_REGEX = /^([a-z0-9-]+)/i;
const CLOUDFLARE_ENDPOINT_REGEX = /^[a-zA-Z0-9]-([a-z]+)\d+-[a-zA-Z0-9]+\.discord\.media:\d+$/

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

    const cfMatch = endpoint.startsWith('c-') && CLOUDFLARE_ENDPOINT_REGEX.exec(endpoint)
    if (cfMatch) return cfMatch[1]

    const legacyMatch = LEGACY_ENDPOINT_REGEX.exec(endpoint)
    if (legacyMatch) return legacyMatch[1]

    this.aqua.emit('debug', `[Player ${this.guildId}] Failed to parse endpoint: ${endpoint}`)
    return null
  }

  setServerUpdate(data) {
    const { endpoint, token } = data || {}

    if (!endpoint || !token) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Incomplete server update`)
      return
    }

    const newRegion = this._extractRegionFromEndpoint(endpoint)
    if (!newRegion) return

    if (this.endpoint === endpoint && this.token === token && this.region === newRegion) return

    const oldRegion = this.region
    this.endpoint = endpoint
    this.token = token
    this.region = newRegion

    this.aqua.emit('debug', `[Player ${this.guildId}] Voice server updated: ${oldRegion ? `${oldRegion} → ${newRegion}` : newRegion}`)

    if (this.player.paused) this.player.paused = false
    this._updatePlayerVoiceData()
  }

  setStateUpdate(data) {
    if (!data || data.user_id !== this.aqua.clientId) return

    const { session_id: sessionId, channel_id: channelId, self_deaf: selfDeaf, self_mute: selfMute } = data

    if (!channelId || !sessionId) {
      this._destroyPlayer()
      return
    }

    if (this.voiceChannel !== channelId) {
      this.aqua.emit('playerMove', this.voiceChannel, channelId)
      this.voiceChannel = channelId
      this.player.voiceChannel = channelId
    }

    this.player.selfDeaf = !!selfDeaf
    this.player.selfMute = !!selfMute
    this.sessionId = sessionId
  }

  _destroyPlayer() {
    if (!this.player?.destroyed) {
      this.player.destroy()
      this.aqua.emit('playerDestroy', this.player)
    }
  }

  _updatePlayerVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Incomplete voice data, waiting...`)
      return
    }

    const voiceData = {
      token: this.token,
      endpoint: this.endpoint,
      sessionId: this.sessionId
    }

    try {
      this.nodes.rest.updatePlayer({
        guildId: this.guildId,
        data: {
          voice: voiceData,
          volume: this.player.volume
        }
      })
    } catch (error) {
      this.aqua.emit('debug', 'updatePlayer', {
        error,
        guildId: this.guildId,
        voiceData
      })
    }
  }
}

module.exports = Connection
