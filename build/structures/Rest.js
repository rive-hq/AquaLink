const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')

const JSON_TYPE_REGEX = /^application\/json/i
const MAX_RESPONSE_SIZE = 10485760
const TRACK_VALIDATION_REGEX = /^[A-Za-z0-9+/]+=*$/

class Rest {
  constructor(aqua, { secure = false, host, port, sessionId = null, password, timeout = 15000 }) {
    this.aqua = aqua
    this.sessionId = sessionId
    this.version = 'v4'
    this.baseUrl = `${secure ? 'https' : 'http'}://${host}:${port}`
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': password
    }
    this.timeout = timeout
    this.secure = secure

    const AgentClass = secure ? HttpsAgent : HttpAgent
    this.agent = new AgentClass({
      keepAlive: true,
      maxSockets: 5,
      maxFreeSockets: 2,
      timeout: this.timeout,
      freeSocketTimeout: 45000,
      keepAliveMsecs: 1000
    })

    this.request = secure ? httpsRequest : httpRequest
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _validateSessionId() {
    if (!this.sessionId) {
      throw new Error('Session ID required')
    }
  }

  _isValidEncodedTrack(track) {
    return typeof track === 'string' && TRACK_VALIDATION_REGEX.test(track)
  }

  async makeRequest(method, endpoint, body = null) {
    const url = `${this.baseUrl}${endpoint}`
    const options = {
      method,
      headers: this.headers,
      timeout: this.timeout,
      agent: this.agent
    }

    return new Promise((resolve, reject) => {
      const req = this.request(url, options, res => {
        if (res.statusCode === 204) return resolve(null)

        // Optimized for Lavalink's typical JSON responses
        const chunks = []
        let totalLength = 0

        res.on('data', chunk => {
          totalLength += chunk.length
          if (totalLength > MAX_RESPONSE_SIZE) {
            req.destroy()
            return reject(new Error('Response too large'))
          }
          chunks.push(chunk)
        })

        res.on('end', () => {
          if (totalLength === 0) return resolve(null)

          const data = Buffer.concat(chunks, totalLength).toString()

          if (JSON_TYPE_REGEX.test(res.headers['content-type'] || '')) {
            try {
              resolve(JSON.parse(data))
            } catch (err) {
              reject(new Error(`JSON parse error: ${err.message}`))
            }
          } else {
            resolve(data)
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Request timeout: ${this.timeout}ms`))
      })

      if (body) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        req.write(payload)
      }

      req.end()
    })
  }

  // Lavalink player operations
  async updatePlayer({ guildId, data }) {
    const { track } = data
    if (track?.encoded && track?.identifier) {
      throw new Error('Cannot provide both encoded and identifier')
    }

    this._validateSessionId()
    return this.makeRequest('PATCH', `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`, data)
  }

  async getPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest('GET', `/${this.version}/sessions/${this.sessionId}/players/${guildId}`)
  }

  async getPlayers() {
    this._validateSessionId()
    return this.makeRequest('GET', `/${this.version}/sessions/${this.sessionId}/players`)
  }

  async destroyPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest('DELETE', `/${this.version}/sessions/${this.sessionId}/players/${guildId}`)
  }

  // Track operations
  async loadTracks(identifier) {
    return this.makeRequest('GET', `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`)
  }

  async decodeTrack(encodedTrack) {
    if (!this._isValidEncodedTrack(encodedTrack)) {
      throw new Error('Invalid encoded track format')
    }
    return this.makeRequest('GET', `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    const validTracks = encodedTracks.filter(track => this._isValidEncodedTrack(track))
    if (validTracks.length !== encodedTracks.length) {
      throw new Error('One or more tracks have invalid format')
    }
    return this.makeRequest('POST', `/${this.version}/decodetracks`, validTracks)
  }

  // Server info
  async getStats() {
    return this.makeRequest('GET', `/${this.version}/stats`)
  }

  async getInfo() {
    return this.makeRequest('GET', `/${this.version}/info`)
  }

  async getVersion() {
    return this.makeRequest('GET', `/${this.version}/version`)
  }

  // Route planner
  async getRoutePlannerStatus() {
    return this.makeRequest('GET', `/${this.version}/routeplanner/status`)
  }

  async freeRoutePlannerAddress(address) {
    return this.makeRequest('POST', `/${this.version}/routeplanner/free/address`, { address })
  }

  async freeAllRoutePlannerAddresses() {
    return this.makeRequest('POST', `/${this.version}/routeplanner/free/all`)
  }

  // Lyrics functionality
  async getLyrics({ track, skipTrackSource = false }) {
    if (!this._isValidTrackForLyrics(track)) {
      this.aqua.emit('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const strategies = this._getLyricsStrategies(track, skipTrackSource)

    for (const strategy of strategies) {
      try {
        const result = await strategy()
        if (result && !this._isLyricsError(result)) {
          return result
        }
      } catch (error) {
        this.aqua.emit('debug', `[Aqua/Lyrics] Strategy failed: ${error.message}`)
      }
    }

    this.aqua.emit('debug', '[Aqua/Lyrics] No lyrics found')
    return null
  }

  _isValidTrackForLyrics(track) {
    return track && (track.identifier || track.info?.title || track.guild_id)
  }

  _getLyricsStrategies(track, skipTrackSource) {
    const strategies = []

    if (track.guild_id) {
      strategies.push(() => this._getPlayerLyrics(track, skipTrackSource))
    }

    if (track.identifier) {
      strategies.push(() => this._getIdentifierLyrics(track))
    }

    if (track.info?.title) {
      strategies.push(() => this._getSearchLyrics(track))
    }

    return strategies
  }

  async _getPlayerLyrics(track, skipTrackSource) {
    this._validateSessionId()
    const baseUrl = `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}`
    const query = skipTrackSource ? '?skipTrackSource=true' : ''

    try {
      return await this.makeRequest('GET', `${baseUrl}/lyrics${query}`)
    } catch {
      return await this.makeRequest('GET', `${baseUrl}/track/lyrics${query}`)
    }
  }

  async _getIdentifierLyrics(track) {
    return this.makeRequest('GET', `/${this.version}/lyrics/${encodeURIComponent(track.identifier)}`)
  }

  async _getSearchLyrics(track) {
    const query = encodeURIComponent(track.info.title)
    return this.makeRequest('GET', `/${this.version}/lyrics/search?query=${query}&source=genius`)
  }

  _isLyricsError(response) {
    return response?.status === 404 || response?.status === 500
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    this._validateSessionId()
    try {
      const query = skipTrackSource ? '?skipTrackSource=true' : ''
      const result = await this.makeRequest(
        'POST',
        `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe${query}`
      )
      return result === null
    } catch (error) {
      this.aqua.emit('debug', `[Aqua/Lyrics] Subscribe failed: ${error.message}`)
      return false
    }
  }

  async unsubscribeLiveLyrics(guildId) {
    this._validateSessionId()
    try {
      const result = await this.makeRequest(
        'DELETE',
        `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe`
      )
      return result === null
    } catch (error) {
      this.aqua.emit('debug', `[Aqua/Lyrics] Unsubscribe failed: ${error.message}`)
      return false
    }
  }

  // Cleanup
  destroy() {
    if (this.agent) {
      this.agent.destroy()
    }
  }
}

module.exports = Rest
