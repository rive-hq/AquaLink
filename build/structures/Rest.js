'use strict'

const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')

const JSON_TYPE_REGEX = /^application\/json/i
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/
const MAX_RESPONSE_SIZE = 10485760
const ERRORS = Object.freeze({
  NO_SESSION: 'Session ID required',
  INVALID_TRACK: 'Invalid encoded track format',
  INVALID_TRACKS: 'One or more tracks have invalid format',
  RESPONSE_TOO_LARGE: 'Response too large',
  JSON_PARSE: 'JSON parse error: ',
  REQUEST_TIMEOUT: 'Request timeout: '
})

const isValidBase64 = str => {
  if (typeof str !== 'string' || !str) return false
  const len = str.length
  return len % 4 === 0 && BASE64_REGEX.test(str)
}

class Rest {
  constructor(aqua, node) {
    this.aqua = aqua
    this.node = node
    this.sessionId = node.sessionId
    this.version = 'v4'
    this.timeout = node.timeout || 15000

    const protocol = node.secure ? 'https:' : 'http:'
    this.baseUrl = `${protocol}//${node.host}:${node.port}`

    this.headers = Object.freeze({
      'Content-Type': 'application/json',
      'Authorization': node.password,
      'Accept': 'application/json'
    })

    const AgentClass = node.secure ? HttpsAgent : HttpAgent
    this.agent = new AgentClass({
      keepAlive: true,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: this.timeout,
      freeSocketTimeout: 30000,
      keepAliveMsecs: 1000,
      scheduling: 'fifo'
    })

    this.request = node.secure ? httpsRequest : httpRequest
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _validateSessionId() {
    if (!this.sessionId) throw new Error(ERRORS.NO_SESSION)
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
        if (res.statusCode === 204) {
          res.resume()
          return resolve(null)
        }

        const chunks = []
        let totalLength = 0
        const contentType = res.headers['content-type']
        const isJson = contentType && JSON_TYPE_REGEX.test(contentType)

        const onData = chunk => {
          totalLength += chunk.length
          if (totalLength > MAX_RESPONSE_SIZE) {
            req.destroy()
            reject(new Error(ERRORS.RESPONSE_TOO_LARGE))
            return
          }
          chunks.push(chunk)
        }

        const onEnd = () => {
          if (totalLength === 0) {
            resolve(null)
            return
          }

          const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)

          if (!isJson) {
            resolve(data.toString())
            return
          }

          try {
            resolve(JSON.parse(data))
          } catch (err) {
            reject(new Error(`${ERRORS.JSON_PARSE}${err.message}`))
          }
        }

        res.on('data', onData)
        res.once('end', onEnd)
        res.once('error', reject)
      })

      const onError = err => {
        req.destroy()
        reject(err)
      }

      const onTimeout = () => {
        req.destroy()
        reject(new Error(`${ERRORS.REQUEST_TIMEOUT}${this.timeout}ms`))
      }

      req.once('error', onError)
      req.once('timeout', onTimeout)

      if (body) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        req.setHeader('Content-Length', Buffer.byteLength(payload))
        req.write(payload)
      }

      req.end()
    })
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
    return this.makeRequest('GET', `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`)
  }

  async decodeTrack(encodedTrack) {
    if (!isValidBase64(encodedTrack)) {
      throw new Error(ERRORS.INVALID_TRACK)
    }
    return this.makeRequest('GET', `/${this.version}/decodetrack?encodedTrack=${encodedTrack}`)
  }

  async decodeTracks(encodedTracks) {
    for (let i = 0; i < encodedTracks.length; i++) {
      if (!isValidBase64(encodedTracks[i])) {
        throw new Error(ERRORS.INVALID_TRACKS)
      }
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
    if (!track || (!track.guild_id && !track.encoded && !track.info?.title)) {
      this.aqua.emit('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = skipTrackSource ? 'true' : 'false'

    if (track.guild_id) {
      try {
        this._validateSessionId()
        const lyrics = await this.makeRequest(
          'GET',
          `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=${skipParam}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (track.encoded && isValidBase64(track.encoded)) {
      try {
        const lyrics = await this.makeRequest(
          'GET',
          `/${this.version}/lyrics?track=${track.encoded}&skipTrackSource=${skipParam}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (track.info?.title) {
      const query = track.info.author
        ? `${track.info.title} ${track.info.author}`
        : track.info.title

      try {
        const lyrics = await this.makeRequest(
          'GET',
          `/${this.version}/lyrics/search?query=${encodeURIComponent(query)}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    return null
  }

  _isValidLyrics(response) {
    return response &&
      response.status !== 204 &&
      !(Array.isArray(response) && response.length === 0)
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    this._validateSessionId()
    try {
      const result = await this.makeRequest(
        'POST',
        `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe?skipTrackSource=${skipTrackSource ? 'true' : 'false'}`
      )
      return result === null
    } catch {
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
    } catch {
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
