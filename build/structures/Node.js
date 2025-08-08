'use strict'

const WebSocket = require('ws')
const Rest = require('./Rest')

// Pre-compiled patterns
const JSON_START_REGEX = /^[\s{[]/
const WS_STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }

class Node {
  static BACKOFF_MULTIPLIER = 1.5
  static MAX_BACKOFF = 60000
  static DEFAULT_RECONNECT_TIMEOUT = 2000
  static DEFAULT_RESUME_TIMEOUT = 60
  static JITTER_MAX = 2000
  static JITTER_FACTOR = 0.2
  static WS_CLOSE_NORMAL = 1000

  constructor(aqua, connOptions, options = {}) {
    this.aqua = aqua

    // Extract connection options with defaults
    this.host = connOptions.host || 'localhost'
    this.name = connOptions.name || this.host
    this.port = connOptions.port || 2333
    this.password = connOptions.password || 'youshallnotpass'
    this.sessionId = connOptions.sessionId || null
    this.regions = connOptions.regions || []
    this.secure = !!connOptions.secure

    // Pre-build WebSocket URL
    this.wsUrl = `ws${this.secure ? 's' : ''}://${this.host}:${this.port}/v4/websocket`

    // Initialize REST handler
    this.rest = new Rest(aqua, this)

    // Extract options with defaults
    this.resumeTimeout = options.resumeTimeout || Node.DEFAULT_RESUME_TIMEOUT
    this.autoResume = options.autoResume || false
    this.reconnectTimeout = options.reconnectTimeout || Node.DEFAULT_RECONNECT_TIMEOUT
    this.reconnectTries = options.reconnectTries || 3
    this.infiniteReconnects = options.infiniteReconnects || false
    this.timeout = options.timeout || 15000

    // Initialize state
    this.connected = false
    this.info = null
    this.ws = null
    this.reconnectAttempted = 0
    this.reconnectTimeoutId = null
    this.isDestroyed = false

    // Initialize stats with defaults
    this.stats = {
      players: 0,
      playingPlayers: 0,
      uptime: 0,
      memory: { free: 0, used: 0, allocated: 0, reservable: 0 },
      cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0 },
      frameStats: { sent: 0, nulled: 0, deficit: 0 },
      ping: 0
    }

    // Pre-build headers
    this._headers = this._buildHeaders()

    // Bind methods for better performance
    this._handleOpen = this._handleOpen.bind(this)
    this._handleError = this._handleError.bind(this)
    this._handleMessage = this._handleMessage.bind(this)
    this._handleClose = this._handleClose.bind(this)
  }

  _buildHeaders() {
    const headers = {
      'Authorization': this.password,
      'User-Id': this.aqua.clientId,
      'Client-Name': `Aqua/${this.aqua.version} (https://github.com/ToddyTheNoobDud/AquaLink)`
    }

    if (this.sessionId) {
      headers['Session-Id'] = this.sessionId
    }

    return headers
  }

  async _handleOpen() {
    this.connected = true
    this.reconnectAttempted = 0
    this._emitDebug('WebSocket connection established')

    if (this.aqua.bypassChecks?.nodeFetchInfo) return;

    try {
      this.info = await this.rest.makeRequest('GET', '/v4/info')
      this.aqua.emit('nodeConnected', this)

      if (this.autoResume && this.sessionId) {
        await this._resumePlayers()
      }
    } catch (err) {
      this.info = null
      this._emitError(`Failed to fetch node info: ${err.message}`)
    }
  }

  _handleError(error) {
    this.aqua.emit('nodeError', this, error)
  }

  _handleMessage(msg) {
    // Fast path for non-JSON
    if (!JSON_START_REGEX.test(msg)) {
      this._emitDebug(`Invalid JSON format: ${msg.slice(0, 100)}...`)
      return;
    }

    let payload
    try {
      payload = JSON.parse(msg)
    } catch {
      this._emitDebug(`JSON parse failed: ${msg.slice(0, 100)}...`)
      return;
    }

    const { op, guildId } = payload
    if (!op) return;

    // Optimize op handling with switch for known ops
    switch (op) {
      case 'stats':
        this._updateStats(payload)
        break
      case 'ready':
        this._handleReady(payload)
        break
      case 2:
      case 5:
      case 9:
        this._handleNumericOp(op, guildId, payload)
        break
      default:
        if (op.startsWith('Lyrics')) {
          const player = guildId ? this.aqua.players.get(guildId) : null
          this.aqua.emit(op, player, payload.track || null, payload)
        } else if (guildId) {
          const player = this.aqua.players.get(guildId)
          if (player) player.emit(op, payload)
        }
    }
  }

  _handleNumericOp(op, guildId, payload) {
    const player = guildId ? this.aqua.players.get(guildId) : null

    switch (op) {
      case 2:
        player?.connection?.setServerUpdate(payload.d)
        break
      case 5:
        player?.connection?.updateSequence(payload.d.sequence)
        break
      case 9:
        this.aqua.emit('debug', `[Player ${guildId}] Voice resumed successfully`)
        break
    }
  }

  _handleClose(code, reason) {
    this.connected = false
    const reasonStr = reason?.toString() || 'No reason provided'

    this.aqua.emit('nodeDisconnect', this, { code, reason: reasonStr })
    this.aqua.handleNodeFailover(this)
    this._scheduleReconnect(code)
  }

  _scheduleReconnect(code) {
    this._clearReconnectTimeout()

    if (code === Node.WS_CLOSE_NORMAL || this.isDestroyed) {
      this._emitDebug('WebSocket closed normally, not reconnecting')
      return;
    }

    if (this.infiniteReconnects) {
      this.aqua.emit('nodeReconnect', this, 'Infinite reconnects enabled, trying again in 10 seconds')
      this.reconnectTimeoutId = setTimeout(() => this.connect(), 10000)
      return;
    }

    if (this.reconnectAttempted >= this.reconnectTries) {
      this._emitError(new Error(`Max reconnection attempts reached (${this.reconnectTries})`))
      this.destroy(true)
      return;
    }

    const backoffTime = this._calcBackoff()
    this.reconnectAttempted++

    this.aqua.emit('nodeReconnect', this, {
      attempt: this.reconnectAttempted,
      backoffTime
    })

    this.reconnectTimeoutId = setTimeout(() => this.connect(), backoffTime)
  }

  _calcBackoff() {
    const baseBackoff = this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, this.reconnectAttempted)
    const maxJitter = Math.min(Node.JITTER_MAX, baseBackoff * Node.JITTER_FACTOR)
    const jitter = Math.random() * maxJitter
    return Math.min(baseBackoff + jitter, Node.MAX_BACKOFF)
  }

  _clearReconnectTimeout() {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
  }

  connect() {
    if (this.isDestroyed) return;

    if (this.ws?.readyState === WS_STATES.OPEN) {
      this._emitDebug('WebSocket already connected')
      return;
    }

    this._cleanup()

    this.ws = new WebSocket(this.wsUrl, {
      headers: this._headers,
      perMessageDeflate: false
    })

    this.ws.once('open', this._handleOpen)
    this.ws.once('error', this._handleError)
    this.ws.on('message', this._handleMessage)
    this.ws.once('close', this._handleClose)
  }

  _cleanup() {
    if (!this.ws) return;

    this.ws.removeAllListeners()

    if (this.ws.readyState === WS_STATES.OPEN) {
      try {
        this.ws.close()
      } catch (err) {
        this._emitError(`Failed to close WebSocket: ${err.message}`)
      }
    }

    this.ws = null
  }

  destroy(clean = false) {
    this.isDestroyed = true
    this._clearReconnectTimeout()
    this._cleanup()

    if (!clean) {
      this.aqua.handleNodeFailover(this)
    }

    this.connected = false
    this.aqua.destroyNode(this.name)
    this.aqua.emit('nodeDestroy', this)
    this.info = null
  }

  async getStats() {
    if (this.connected) {
      return this.stats
    }

    try {
      const newStats = await this.rest.getStats()
      if (newStats) {
        this._mergeStats(newStats)
      }
      return this.stats
    } catch (err) {
      this._emitError(`Failed to fetch node stats: ${err.message}`)
      return this.stats
    }
  }

  _mergeStats(newStats) {
    // Fast merge with direct assignment
    if (newStats.players !== undefined) this.stats.players = newStats.players
    if (newStats.playingPlayers !== undefined) this.stats.playingPlayers = newStats.playingPlayers
    if (newStats.uptime !== undefined) this.stats.uptime = newStats.uptime
    if (newStats.ping !== undefined) this.stats.ping = newStats.ping

    if (newStats.memory) {
      Object.assign(this.stats.memory, newStats.memory)
    }

    if (newStats.cpu) {
      Object.assign(this.stats.cpu, newStats.cpu)
    }

    if (newStats.frameStats) {
      Object.assign(this.stats.frameStats, newStats.frameStats)
    }
  }

  _updateStats(payload) {
    if (!payload) return;

    this.stats.players = payload.players
    this.stats.playingPlayers = payload.playingPlayers
    this.stats.uptime = payload.uptime
    this.stats.ping = payload.ping

    if (payload.memory) Object.assign(this.stats.memory, payload.memory)
    if (payload.cpu) Object.assign(this.stats.cpu, payload.cpu)
    if (payload.frameStats) Object.assign(this.stats.frameStats, payload.frameStats)
  }

  _handleReady(payload) {
    if (!payload.sessionId) {
      this._emitError('Ready payload missing sessionId')
      return;
    }

    this.sessionId = payload.sessionId
    this.rest.setSessionId(payload.sessionId)
    this._headers['Session-Id'] = payload.sessionId

    this.aqua.emit('nodeConnect', this)
  }

  async _resumePlayers() {
    try {
      await this.rest.makeRequest('PATCH', `/v4/sessions/${this.sessionId}`, {
        resuming: true,
        timeout: this.resumeTimeout
      })
      await this.aqua.loadPlayers()
      this._emitDebug('Session resumed successfully')
    } catch (err) {
      this._emitError(`Failed to resume session: ${err.message}`)
    }
  }

  _emitError(error) {
    const errorObj = error instanceof Error ? error : new Error(error)
    console.error(`[Aqua] [${this.name}] Error:`, errorObj)
    this.aqua.emit('error', this, errorObj)
  }

  _emitDebug(message) {
    this.aqua.emit('debug', this.name, message)
  }
}

module.exports = Node
