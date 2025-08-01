const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const { URL } = require('node:url')

const JSON_TYPE_REGEX = /^application\/json/i
const MAX_RESPONSE_SIZE = 10485760
const TRACK_VALIDATION_REGEX = /^[A-Za-z0-9+/]+=*$/

const ERRORS = {
  NO_SESSION: 'Session ID required',
  INVALID_TRACK: 'Invalid encoded track format',
  INVALID_TRACKS: 'One or more tracks have invalid format',
  RESPONSE_TOO_LARGE: 'Response too large',
  JSON_PARSE: 'JSON parse error: ',
  REQUEST_TIMEOUT: 'Request timeout: '
}

class Rest {
  constructor(aqua, { secure = false, host, port, sessionId = null, password, timeout = 15000 }) {
    this.aqua = aqua
    this.sessionId = sessionId
    this.version = 'v4'
    this.secure = secure
    this.timeout = timeout

    this.baseUrl = new URL(`${secure ? 'https' : 'http'}://${host}:${port}`)

    this.headers = Object.freeze({
      'Content-Type': 'application/json',
      'Authorization': password,
      'Accept': 'application/json',
    })

    const AgentClass = secure ? HttpsAgent : HttpAgent
    this.agent = new AgentClass({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: this.timeout,
      freeSocketTimeout: 30000,
      keepAliveMsecs: 1000,
      scheduling: 'fifo'
    })

    this.request = secure ? httpsRequest : httpRequest

    this._validateSessionId = this._validateSessionId.bind(this)
    this._isValidEncodedTrack = this._isValidEncodedTrack.bind(this)
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _validateSessionId() {
    if (!this.sessionId) {
      throw new Error(ERRORS.NO_SESSION)
    }
  }

  _isValidEncodedTrack(track) {
    return typeof track === 'string' && TRACK_VALIDATION_REGEX.test(track)
  }

  async makeRequest(method, endpoint, body = null) {
    const url = new URL(endpoint, this.baseUrl)

    const options = {
      method,
      headers: this.headers,
      timeout: this.timeout,
      agent: this.agent
    }

    return new Promise((resolve, reject) => {
      const req = this.request(url, options, res => {
        if (res.statusCode === 204) {
          res.resume()
          return resolve(null)
        }

        const chunks = []
        let totalLength = 0
        const isJson = JSON_TYPE_REGEX.test(res.headers['content-type'] || '')

        res.on('data', chunk => {
          totalLength += chunk.length
          if (totalLength > MAX_RESPONSE_SIZE) {
            req.destroy()
            return reject(new Error(ERRORS.RESPONSE_TOO_LARGE))
          }
          chunks.push(chunk)
        })

        res.on('end', () => {
          if (totalLength === 0) return resolve(null)

          const data = Buffer.concat(chunks, totalLength)

          if (isJson) {
            try {
              resolve(JSON.parse(data))
            } catch (err) {
              reject(new Error(`${ERRORS.JSON_PARSE}${err.message}`))
            }
          } else {
            resolve(data.toString())
          }
        })

        res.on('error', reject)
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`${ERRORS.REQUEST_TIMEOUT}${this.timeout}ms`))
      })

      if (body) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        req.setHeader('Content-Length', Buffer.byteLength(payload))
        req.write(payload)
      }

      req.end()
    })
  }

  async batchRequests(requests) {
    return Promise.all(requests.map(({ method, endpoint, body }) =>
      this.makeRequest(method, endpoint, body)
    ))
  }

  async updatePlayer({ guildId, data }) {
    this._validateSessionId()
    const endpoint = `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`
    return this.makeRequest('PATCH', endpoint, data)
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

  async loadTracks(identifier) {
    const params = new URLSearchParams({ identifier })
    return this.makeRequest('GET', `/${this.version}/loadtracks?${params}`)
  }

  async decodeTrack(encodedTrack) {
    if (!this._isValidEncodedTrack(encodedTrack)) {
      throw new Error(ERRORS.INVALID_TRACK)
    }
    const params = new URLSearchParams({ encodedTrack })
    return this.makeRequest('GET', `/${this.version}/decodetrack?${params}`)
  }

  async decodeTracks(encodedTracks) {
    const invalidIndex = encodedTracks.findIndex(track => !this._isValidEncodedTrack(track))
    if (invalidIndex !== -1) {
      throw new Error(ERRORS.INVALID_TRACKS)
    }
    return this.makeRequest('POST', `/${this.version}/decodetracks`, encodedTracks)
  }

  async getStats() {
    return this.makeRequest('GET', `/${this.version}/stats`)
  }

  async getInfo() {
    return this.makeRequest('GET', `/${this.version}/info`)
  }

  async getVersion() {
    return this.makeRequest('GET', `/${this.version}/version`)
  }
  async getRoutePlannerStatus() {
    return this.makeRequest('GET', `/${this.version}/routeplanner/status`)
  }

  async freeRoutePlannerAddress(address) {
    return this.makeRequest('POST', `/${this.version}/routeplanner/free/address`, { address })
  }

  async freeAllRoutePlannerAddresses() {
    return this.makeRequest('POST', `/${this.version}/routeplanner/free/all`)
  }

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
    const params = skipTrackSource ? new URLSearchParams({ skipTrackSource: 'true' }) : ''
    const query = params ? `?${params}` : ''

    try {
      return await this.makeRequest('GET', `${baseUrl}/lyrics${query}`)
    } catch {
      return await this.makeRequest('GET', `${baseUrl}/track/lyrics${query}`)
    }
  }

  async _getIdentifierLyrics(track) {
    const params = new URLSearchParams({ identifier: track.identifier })
    return this.makeRequest('GET', `/${this.version}/lyrics?${params}`)
  }

  async _getSearchLyrics(track) {
    const params = new URLSearchParams({
      query: track.info.title,
      source: 'genius'
    })
    return this.makeRequest('GET', `/${this.version}/lyrics/search?${params}`)
  }

  _isLyricsError(response) {
    return response?.status === 404 || response?.status === 500
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    this._validateSessionId()
    try {
      const params = skipTrackSource ? new URLSearchParams({ skipTrackSource: 'true' }) : ''
      const query = params ? `?${params}` : ''
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

  destroy() {
    if (this.agent) {
      this.agent.destroy()
      this.agent = null
    }
  }
}

module.exports = Rest
