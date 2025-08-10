'use strict'

const { Buffer } = require('node:buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const { createBrotliDecompress, createGunzip, createInflate } = require('node:zlib')

const JSON_TYPE_REGEX = /^application\/json\b/i
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024
const API_VERSION = 'v4'

const ERRORS = Object.freeze({
  NO_SESSION: 'Session ID required',
  INVALID_TRACK: 'Invalid encoded track format',
  INVALID_TRACKS: 'One or more tracks have invalid format',
  RESPONSE_TOO_LARGE: 'Response too large',
  JSON_PARSE: 'JSON parse error: ',
  REQUEST_TIMEOUT: 'Request timeout: '
})

const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64_URL = /^[A-Za-z0-9_-]*={0,2}$/
const isValidBase64 = (str) => {
  if (typeof str !== 'string') return false
  const s = str.trim()
  if (s.length === 0) return false
  const re = (s.includes('-') || s.includes('_')) ? BASE64_URL : BASE64_STD
  return re.test(s)
}

const _bool = (b) => (b ? 'true' : 'false')
const ipv6Host = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)

class Rest {
  constructor(aqua, node) {
    this.aqua = aqua
    this.node = node
    this.sessionId = node.sessionId
    this.timeout = node.timeout || 15000

    const protocol = node.secure ? 'https:' : 'http:'
    const host = ipv6Host(node.host)
    this.baseUrl = `${protocol}//${host}:${node.port}`

    this.defaultHeaders = Object.freeze({
      Authorization: String(node.password ?? ''),
      Accept: 'application/json, */*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': `Aqua-Lavalink/${API_VERSION} (Node.js ${process.version})`
    })

    const AgentClass = node.secure ? HttpsAgent : HttpAgent

    // configuration SOON !!! (I think)
    this.agent = new AgentClass({
      keepAlive: true,
      maxSockets: node.maxSockets ?? 32,
      maxFreeSockets: node.maxFreeSockets ?? 16,
      timeout: this.timeout,
      freeSocketTimeout: node.freeSocketTimeout ?? 30000,
      keepAliveMsecs: node.keepAliveMsecs ?? 1000,
      scheduling: 'lifo'
    })

    this.request = node.secure ? httpsRequest : httpRequest
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
  }

  _validateSessionId() {
    if (!this.sessionId) throw new Error(ERRORS.NO_SESSION)
  }

  async makeRequest(method, endpoint, body = undefined) {
    const url = `${this.baseUrl}${endpoint}`
    const headers = { ...this.defaultHeaders }
    let payload

    if (body != null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }

    const options = {
      method,
      headers,
      timeout: this.timeout,
      agent: this.agent
    }

    return new Promise((resolve, reject) => {
      const req = this.request(url, options, (res) => {
        if (res.statusCode === 204 || res.headers['content-length'] === '0') {
          res.resume()
          resolve(null)
          return
        }

        const contentType = res.headers['content-type'] || ''
        const isJson = JSON_TYPE_REGEX.test(contentType)
        const encoding = (res.headers['content-encoding'] || '').toLowerCase()

        let src = res
        let decompressor
        const onStreamError = (err) => {
          req.destroy()
          reject(err)
        }

        try {
          if (encoding === 'br') decompressor = createBrotliDecompress()
          else if (encoding === 'gzip') decompressor = createGunzip()
          else if (encoding === 'deflate') decompressor = createInflate()
        } catch (e) {
          decompressor = null
        }

        if (decompressor) {
          res.pipe(decompressor)
          src = decompressor
          decompressor.once('error', onStreamError)
        } else {
          res.once('error', onStreamError)
        }

        const chunks = []
        let total = 0

        const onData = (chunk) => {
          total += chunk.length
          if (total > MAX_RESPONSE_SIZE) {
            req.destroy()
            reject(new Error(ERRORS.RESPONSE_TOO_LARGE))
            return
          }
          chunks.push(chunk)
        }

        const onEnd = () => {
          if (total === 0) {
            resolve(null)
            return
          }

          const dataBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
          const text = dataBuf.toString('utf8')

          let parsed = text
          if (isJson) {
            try {
              parsed = JSON.parse(text)
            } catch (err) {
              reject(new Error(`${ERRORS.JSON_PARSE}${err.message}`))
              return
            }
          }

          const status = res.statusCode || 0
          if (status >= 400) {
            const err = new Error(`HTTP ${status} ${method} ${endpoint}`)
            err.statusCode = status
            err.statusMessage = res.statusMessage
            err.headers = res.headers
            err.body = parsed
            reject(err)
            return
          }

          resolve(parsed)
        }

        src.on('data', onData)
        src.once('end', onEnd)
      })

      const onError = (err) => {
        req.destroy()
        reject(err)
      }

      const onTimeout = () => {
        req.destroy()
        reject(new Error(`${ERRORS.REQUEST_TIMEOUT}${this.timeout}ms`))
      }

      req.once('error', onError)
      req.once('timeout', onTimeout)
      req.once('socket', (socket) => socket.setNoDelay(true))

      if (payload) req.write(payload)
      req.end()
    })
  }

  async updatePlayer({ guildId, data }) {
    this._validateSessionId()
    return this.makeRequest(
      'PATCH',
      `/${API_VERSION}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`,
      data
    )
  }

  async getPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest(
      'GET',
      `/${API_VERSION}/sessions/${this.sessionId}/players/${guildId}`
    )
  }

  async getPlayers() {
    this._validateSessionId()
    return this.makeRequest('GET', `/${API_VERSION}/sessions/${this.sessionId}/players`)
  }

  async destroyPlayer(guildId) {
    this._validateSessionId()
    return this.makeRequest('DELETE', `/${API_VERSION}/sessions/${this.sessionId}/players/${guildId}`)
  }

  async loadTracks(identifier) {
    return this.makeRequest('GET', `/${API_VERSION}/loadtracks?identifier=${encodeURIComponent(identifier)}`)
  }

  async decodeTrack(encodedTrack) {
    if (!isValidBase64(encodedTrack)) {
      throw new Error(ERRORS.INVALID_TRACK)
    }
    return this.makeRequest('GET', `/${API_VERSION}/decodetrack?encodedTrack=${encodeURIComponent(encodedTrack)}`)
  }

  async decodeTracks(encodedTracks) {
    if (!Array.isArray(encodedTracks) || encodedTracks.length === 0 || !encodedTracks.every(isValidBase64)) {
      throw new Error(ERRORS.INVALID_TRACKS)
    }
    return this.makeRequest('POST', `/${API_VERSION}/decodetracks`, encodedTracks)
  }

  async getStats() {
    return this.makeRequest('GET', `/${API_VERSION}/stats`)
  }

  async getInfo() {
    return this.makeRequest('GET', `/${API_VERSION}/info`)
  }

  async getVersion() {
    return this.makeRequest('GET', `/${API_VERSION}/version`)
  }

  async getRoutePlannerStatus() {
    return this.makeRequest('GET', `/${API_VERSION}/routeplanner/status`)
  }

  async freeRoutePlannerAddress(address) {
    return this.makeRequest('POST', `/${API_VERSION}/routeplanner/free/address`, { address })
  }

  async freeAllRoutePlannerAddresses() {
    return this.makeRequest('POST', `/${API_VERSION}/routeplanner/free/all`)
  }

  async getLyrics({ track, skipTrackSource = false }) {
    if (!track || (!track.guild_id && !track.encoded && !track.info?.title)) {
      this.aqua?.emit?.('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = _bool(skipTrackSource)

    if (track.guild_id) {
      try {
        this._validateSessionId()
        const lyrics = await this.makeRequest(
          'GET',
          `/${API_VERSION}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=${skipParam}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (track.encoded && isValidBase64(track.encoded)) {
      try {
        const lyrics = await this.makeRequest(
          'GET',
          `/${API_VERSION}/lyrics?track=${encodeURIComponent(track.encoded)}&skipTrackSource=${skipParam}`
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
          `/${API_VERSION}/lyrics/search?query=${encodeURIComponent(query)}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    return null
  }

  _isValidLyrics(response) {
    if (!response) return false
    if (Array.isArray(response)) return response.length > 0
    if (typeof response === 'object') return Object.keys(response).length > 0
    if (typeof response === 'string') return response.trim().length > 0
    return false
  }

  async subscribeLiveLyrics(guildId, skipTrackSource = false) {
    this._validateSessionId()
    try {
      const result = await this.makeRequest(
        'POST',
        `/${API_VERSION}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe?skipTrackSource=${_bool(skipTrackSource)}`
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
        `/${API_VERSION}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe`
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
