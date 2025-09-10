'use strict'
const {AqualinkEvents} = require('./AqualinkEvents')

const UPDATE_TIMEOUT = 4000
const RECONNECT_DELAY = 2000
const MAX_RECONNECT_ATTEMPTS = 3
const RESUME_BACKOFF_BASE = 1000
const RESUME_BACKOFF_MAX = 8000
const VOICE_DATA_TIMEOUT = 30000

const STATE_FLAGS = {
  CONNECTED: 1,
  UPDATE_SCHEDULED: 2,
  DISCONNECTING: 4,
  ATTEMPTING_RESUME: 8,
  VOICE_DATA_STALE: 16
}

class Connection {
  constructor(player) {
    if (!player?.aqua?.clientId || !player.nodes?.rest) {
      throw new TypeError('Invalid player configuration')
    }

    this._player = player
    this._aqua = player.aqua
    this._rest = player.nodes.rest
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
    this._reconnectAttempts = 0
    this._destroyed = false
    this._reconnectTimer = null
    this._lastVoiceDataUpdate = 0
    this._consecutiveFailures = 0
  }

  _hasValidVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) return false
    const dataAge = Date.now() - this._lastVoiceDataUpdate
    if (dataAge > VOICE_DATA_TIMEOUT) {
      this._stateFlags |= STATE_FLAGS.VOICE_DATA_STALE
      return false
    }
    return true
  }

  _canAttemptResume() {
    return !this._destroyed &&
           this._hasValidVoiceData() &&
           this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
           !(this._stateFlags & (STATE_FLAGS.ATTEMPTING_RESUME | STATE_FLAGS.DISCONNECTING | STATE_FLAGS.VOICE_DATA_STALE))
  }

  setServerUpdate(data) {
    if (this._destroyed || !data?.endpoint || !data.token) return

    const endpoint = data.endpoint.trim()
    if (this._lastEndpoint === endpoint && this.token === data.token) return

    const regionEnd = endpoint.indexOf('.')
    const regionPart = regionEnd > 0 ? endpoint.substring(0, regionEnd) : endpoint
    let newRegion = 'unknown'
    let digitIndex = regionPart.length
    for (let i = 0; i < regionPart.length; i++) {
      if (regionPart.charCodeAt(i) >= 48 && regionPart.charCodeAt(i) <= 57) {
        digitIndex = i
        break
      }
    }
    if (digitIndex > 0) {
      newRegion = regionPart.substring(0, digitIndex)
    }
    const regionChanged = this.region !== newRegion
    const endpointChanged = this._lastEndpoint !== endpoint

    if (regionChanged || endpointChanged) {
      if (endpointChanged) {
        this.sequence = 0
        this._lastEndpoint = endpoint
        this._reconnectAttempts = 0
        this._consecutiveFailures = 0
      }
      this.endpoint = endpoint
      this.region = newRegion
    }

    this.token = data.token
    this._lastVoiceDataUpdate = Date.now()
    this._stateFlags &= ~STATE_FLAGS.VOICE_DATA_STALE

    if (this._player.paused) this._player.pause(false)
    this._scheduleVoiceUpdate()
  }

  resendVoiceUpdate() {
    if (this._destroyed || !this._hasValidVoiceData()) return false
    this._scheduleVoiceUpdate()
    return true
  }

  setStateUpdate(data) {
    if (this._destroyed || !data || data.user_id !== this._clientId) return

    const {session_id, channel_id, self_deaf, self_mute} = data

    if (channel_id) {
      let needsUpdate = false

      if (this.voiceChannel !== channel_id) {
        this._aqua.emit(AqualinkEvents.PlayerMove, this.voiceChannel, channel_id)
        this.voiceChannel = channel_id
        this._player.voiceChannel = channel_id
        needsUpdate = true
      }

      if (this.sessionId !== session_id) {
        this.sessionId = session_id
        this._lastVoiceDataUpdate = Date.now()
        this._stateFlags &= ~STATE_FLAGS.VOICE_DATA_STALE
        needsUpdate = true
        this._reconnectAttempts = 0
        this._consecutiveFailures = 0
      }

      this._player.connection.sessionId = session_id || this._player.connection.sessionId
      this._player.self_deaf = !!self_deaf
      this._player.self_mute = !!self_mute
      this._player.connected = true
      this._stateFlags |= STATE_FLAGS.CONNECTED

      if (needsUpdate) this._scheduleVoiceUpdate()
    } else {
      this._handleDisconnect()
    }
  }

  _handleDisconnect() {
    if (this._destroyed || !(this._stateFlags & STATE_FLAGS.CONNECTED)) return

    this._stateFlags = (this._stateFlags | STATE_FLAGS.DISCONNECTING) & ~STATE_FLAGS.CONNECTED
    this._player.connected = false
    this._clearPendingUpdate()

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    this.voiceChannel = null
    this.sessionId = null
    this.sequence = 0
    this._lastVoiceDataUpdate = 0
    this._stateFlags |= STATE_FLAGS.VOICE_DATA_STALE

    try {
      if (typeof this._player.destroy === 'function') this._player.destroy()
    } catch (error) {
      // Silent fail
    } finally {
      this._stateFlags &= ~STATE_FLAGS.DISCONNECTING
    }
  }

  async attemptResume() {
    if (!this._canAttemptResume()) {
      if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
          (this._stateFlags & STATE_FLAGS.VOICE_DATA_STALE)) {
        this._handleDisconnect()
      }
      return false
    }

    this._stateFlags |= STATE_FLAGS.ATTEMPTING_RESUME
    this._reconnectAttempts++

    const payload = {
      guildId: this._guildId,
      data: {
        voice: {
          token: this.token,
          endpoint: this.endpoint,
          sessionId: this.sessionId,
          resume: true,
          sequence: this.sequence
        },
        volume: this._player?.volume ?? 100
      }
    }

    try {
      await this._sendUpdate(payload)
      this._reconnectAttempts = 0
      this._consecutiveFailures = 0
      return true
    } catch (error) {
      this._consecutiveFailures++

      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
          !this._destroyed &&
          this._consecutiveFailures < 5) {
        const delay = Math.min(
          RESUME_BACKOFF_BASE * (1 << (this._reconnectAttempts - 1)),
          RESUME_BACKOFF_MAX
        )
        this._reconnectTimer = setTimeout(() => {
          if (!this._destroyed && this._canAttemptResume()) {
            this.attemptResume()
          }
        }, delay)
        this._reconnectTimer?.unref?.()
      } else {
        this._handleDisconnect()
      }
      return false
    } finally {
      this._stateFlags &= ~STATE_FLAGS.ATTEMPTING_RESUME
    }
  }

  updateSequence(seq) {
    if (typeof seq === 'number' && seq >= 0 && Number.isFinite(seq)) {
      this.sequence = Math.max(seq, this.sequence)
    }
  }

  _clearPendingUpdate() {
    this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED
    this._pendingUpdate = null
  }

  _scheduleVoiceUpdate() {
    if (this._destroyed || !this._hasValidVoiceData() ||
        (this._stateFlags & STATE_FLAGS.UPDATE_SCHEDULED)) return

    this._clearPendingUpdate()

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

    this._pendingUpdate = {payload, timestamp: Date.now()}
    this._stateFlags |= STATE_FLAGS.UPDATE_SCHEDULED

    queueMicrotask(() => {
      if (this._destroyed) return

      this._stateFlags &= ~STATE_FLAGS.UPDATE_SCHEDULED
      const pending = this._pendingUpdate
      if (!pending || Date.now() - pending.timestamp > UPDATE_TIMEOUT) {
        this._pendingUpdate = null
        return
      }

      this._pendingUpdate = null
      this._sendUpdate(pending.payload).catch(() => {})
    })
  }

  async _sendUpdate(payload) {
    if (this._destroyed) throw new Error('Connection destroyed')
    if (!this._rest) throw new Error('REST interface unavailable')

    await this._rest.updatePlayer(payload)
  }

  destroy() {
    if (this._destroyed) return

    this._destroyed = true
    this._clearPendingUpdate()

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    this._player = null
    this._aqua = null
    this._rest = null
    this.voiceChannel = null
    this.sessionId = null
    this.endpoint = null
    this.token = null
    this.region = null
    this._lastEndpoint = null
    this._stateFlags = 0
    this.sequence = 0
    this._reconnectAttempts = 0
    this._consecutiveFailures = 0
    this._lastVoiceDataUpdate = 0
  }
}

module.exports = Connection
