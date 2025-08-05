const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const { URL } = require('node:url')

const JSON_TYPE_REGEX = /^application\/json/i
const MAX_RESPONSE_SIZE = 10485760
const TRACK_VALIDATION_REGEX = /^[A-Za-z0-9+/]+=*$/
const METADATA_PHRASES = [
  'Official Visualizer',
  'Official',
  'Official Video',
  'Music Video',
  'Live',
  'Lyrics',
  'Audio',
  'HD',
  'Remix',
  'Cover',
  'Acoustic',
  'Instrumental',
  'Karaoke',
  'ft',
  'feat'
]
const METADATA_REGEX = new RegExp(
  `\\s*[[({](${METADATA_PHRASES.map(phrase =>
    phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})[^\\]}()]*[\\])}]`,
  'gi'
)

const ERRORS = {
  NO_SESSION: 'Session ID required',
  INVALID_TRACK: 'Invalid encoded track format',
  INVALID_TRACKS: 'One or more tracks have invalid format',
  RESPONSE_TOO_LARGE: 'Response too large',
  JSON_PARSE: 'JSON parse error: ',
  REQUEST_TIMEOUT: 'Request timeout: '
}

function cleanTitle(title) {
  return title
    .replace(METADATA_REGEX, '')
    .replace(/\s*\[[^\]]*\]\s*|\s*\([^\)]*\)\s*|\s*\{[^\}]*\}\s*/g, '')
    .trim()
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
      'Accept': 'application/json'
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
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _validateSessionId() {
    if (!this.sessionId) throw new Error(ERRORS.NO_SESSION)
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

          const data = Buffer.concat(chunks)
          if (!isJson) return resolve(data.toString())

          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(new Error(`${ERRORS.JSON_PARSE}${err.message}`))
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
    return this.makeRequest(
      'PATCH',
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`,
      data
    )
  }

  async getPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest(
      'GET',
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}`
    )
  }

  async getPlayers() {
    this._validateSessionId()
    return this.makeRequest(
      'GET',
      `/${this.version}/sessions/${this.sessionId}/players`
    )
  }

  async destroyPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest(
      'DELETE',
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}`
    )
  }

  async loadTracks(identifier) {
    const params = new URLSearchParams({ identifier })
    return this.makeRequest(
      'GET',
      `/${this.version}/loadtracks?${params}`
    )
  }

  async decodeTrack(encodedTrack) {
    if (!this._isValidEncodedTrack(encodedTrack)) {
      throw new Error(ERRORS.INVALID_TRACK)
    }
    const params = new URLSearchParams({ encodedTrack })
    return this.makeRequest('GET', `/${this.version}/decodetrack?${params}`)
  }

  async decodeTracks(encodedTracks) {
    const invalidTrack = encodedTracks.find(track => !this._isValidEncodedTrack(track))
    if (invalidTrack) throw new Error(ERRORS.INVALID_TRACKS)

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
    return this.makeRequest(
      'POST',
      `/${this.version}/routeplanner/free/address`,
      { address }
    )
  }

  async freeAllRoutePlannerAddresses() {
    return this.makeRequest(
      'POST',
      `/${this.version}/routeplanner/free/all`
    )
  }

  async getLyrics({ track, skipTrackSource }) {
    if (!this._isValidTrackForLyrics(track)) {
      this.aqua.emit('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    if (track.encoded && this._isValidEncodedTrack(track.encoded)) {
      try {
        const lyrics = await this._getEncodedTrackLyrics(track.encoded, skipTrackSource)
        if (lyrics && !this._isEmptyLyrics(lyrics)) return lyrics
      } catch (error) {
        this.aqua.emit('debug', `[Aqua/Lyrics] Encoded track failed: ${error.message}`)
      }
    }

    if (track.guild_id) {
      try {
        const lyrics = await this._getPlayerTrackLyrics(track.guild_id, skipTrackSource)
        if (lyrics && !this._isEmptyLyrics(lyrics)) return lyrics
      } catch (error) {
        this.aqua.emit('debug', `[Aqua/Lyrics] Player track failed: ${error.message}`)
      }
    }

    if (track.info?.title) {
      try {
        const query = [track.info.title, track.info.author].filter(Boolean).join(' ')
        return await this._searchLyrics(query)
      } catch (error) {
        this.aqua.emit('debug', `[Aqua/Lyrics] Search failed: ${error.message}`)
      }
    }

    if (track.info?.title && track.info?.author) {
      try {
        const query = [cleanTitle(track.info.title), track.info.author].filter(Boolean).join(' ')
        return await this._searchLyrics(query)
      } catch (error) {
        this.aqua.emit('debug', `[Aqua/Lyrics] Search failed: ${error.message}`)
      }
    }


    this.aqua.emit('debug', '[Aqua/Lyrics] No lyrics found')
    return null
  }

  async _getPlayerTrackLyrics(guildId, skipTrackSource) {
    this._validateSessionId()
    const params = new URLSearchParams({
      skipTrackSource: skipTrackSource ? 'true' : 'false'
    })
    return this.makeRequest(
      'GET',
      `/${this.version}/sessions/${this.sessionId}/players/${guildId}/track/lyrics?${params}`
    )
  }

  async _getEncodedTrackLyrics(encodedTrack, skipTrackSource) {
    const params = new URLSearchParams({
      track: encodedTrack,
      skipTrackSource: skipTrackSource ? 'true' : 'false'
    })
    return this.makeRequest('GET', `/${this.version}/lyrics?${params}`)
  }

  async _searchLyrics(query) {
    const params = new URLSearchParams({ query })
    return this.makeRequest('GET', `/${this.version}/lyrics/search?${params}`)
  }

  _isValidTrackForLyrics(track) {
    return track && (
      track.guild_id ||
      (track.encoded && this._isValidEncodedTrack(track.encoded)) ||
      track.info?.title
    )
  }

  _isEmptyLyrics(response) {
    return !response ||
      response.status === 204 ||
      (Array.isArray(response) && response.length === 0)
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    this._validateSessionId()
    try {
      const params = new URLSearchParams({
        skipTrackSource: skipTrackSource ? 'true' : 'false'
      })
      const result = await this.makeRequest(
        'POST',
        `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe?${params}`
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
