'use strict'

const { Buffer } = require('node:buffer')
const { Agent: HttpsAgent, request: httpsRequest } = require('node:https')
const { Agent: HttpAgent, request: httpRequest } = require('node:http')
const { createBrotliDecompress, createUnzip } = require('node:zlib')

const JSON_TYPE_REGEX = /^(?:application\/json|application\/(?:[a-z0-9.+-]*\+json))\b/i

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024
const API_VERSION = 'v4'

const ERRORS = Object.freeze({
  NO_SESSION: 'Session ID required',
  INVALID_TRACK: 'Invalid encoded track format',
  INVALID_TRACKS: 'One or more tracks have invalid format',
  RESPONSE_TOO_LARGE: 'Response too large',
  JSON_PARSE: 'JSON parse error: ',
  REQUEST_TIMEOUT: 'Request timeout: ',
  RESPONSE_ABORTED: 'Response aborted'
})

const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64_URL = /^[A-Za-z0-9_-]*={0,2}$/

const isValidBase64 = (str) => {
  if (typeof str !== 'string') return false
  const s = str.trim()
  if (s.length === 0) return false

  const isUrl = s.includes('-') || s.includes('_')
  if (isUrl) {
    if (s.length % 4 === 1) return false
    return BASE64_URL.test(s)
  } else {
    if (s.length % 4 !== 0) return false
    return BASE64_STD.test(s)
  }
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
    this.agent = new AgentClass({
      keepAlive: true,
      maxSockets: node.maxSockets ?? 32,
      maxFreeSockets: node.maxFreeSockets ?? 16,
      freeSocketTimeout: node.freeSocketTimeout ?? 30000,
      keepAliveMsecs: node.keepAliveMsecs ?? 1000,
      scheduling: 'lifo'
    })

    this.request = node.secure ? httpsRequest : httpRequest

    this._sessionBaseCached = this.sessionId ? `/${API_VERSION}/sessions/${this.sessionId}` : null
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId
    this._sessionBaseCached = sessionId ? `/${API_VERSION}/sessions/${sessionId}` : null
  }

  _validateSessionId() {
    if (!this.sessionId) throw new Error(ERRORS.NO_SESSION)
  }

  _sessionBase() {
    this._validateSessionId()
    return this._sessionBaseCached
  }

  async makeRequest(method, endpoint, body = undefined) {
    const url = `${this.baseUrl}${endpoint}`
    let payload
    let headers = this.defaultHeaders

    if (body != null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers = {
        ...this.defaultHeaders,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }

    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        try { req.destroy() } catch {}
        reject(new Error(`${ERRORS.REQUEST_TIMEOUT}${this.timeout}ms`))
      }

      const onReqError = (err) => {
        try { req.destroy() } catch {}
        reject(err)
      }

      const req = this.request(url, { method, headers, agent: this.agent }, (res) => {
        if (res.statusCode === 204 || res.headers['content-length'] === '0') {
          res.resume()
          resolve(null)
          return
        }

        const contentType = res.headers['content-type'] || ''
        const isJson = JSON_TYPE_REGEX.test(contentType)
        const encoding = String(res.headers['content-encoding'] || '')
          .split(',')[0]
          .trim()
          .toLowerCase()

        let src = res
        let decompressor = null

        const abort = (err) => {
          try { req.destroy() } catch {}
          try { res.destroy() } catch {}
          if (decompressor) {
            try { decompressor.destroy() } catch {}
          }
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        const cl = res.headers['content-length']
        if (cl != null) {
          const size = Number(cl)
          if (Number.isFinite(size) && size > MAX_RESPONSE_SIZE) {
            abort(new Error(ERRORS.RESPONSE_TOO_LARGE))
            return
          }
        }

        try {
          if (encoding === 'br') {
            decompressor = createBrotliDecompress()
          } else if (encoding === 'gzip' || encoding === 'deflate') {
            decompressor = createUnzip()
          }
        } catch {
          decompressor = null
        }

        res.once('aborted', () => abort(new Error(ERRORS.RESPONSE_ABORTED)))
        res.once('error', abort)

        if (decompressor) {
          decompressor.once('error', abort)
          res.pipe(decompressor)
          src = decompressor
        }

        const chunks = []
        let total = 0

        const onData = (chunk) => {
          total += chunk.length
          if (total > MAX_RESPONSE_SIZE) {
            abort(new Error(ERRORS.RESPONSE_TOO_LARGE))
            return
          }
          chunks.push(chunk)
        }

        const onEnd = () => {
          if (total === 0) {
            resolve(null)
            return
          }

          const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
          let result = buffer

          const asString = buffer.toString('utf8')
          let parsed = asString

          if (isJson) {
            try {
              parsed = JSON.parse(asString)
            } catch (err) {
              abort(new Error(`${ERRORS.JSON_PARSE}${err.message}`))
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
            err.url = url
            reject(err)
            return
          }

          resolve(isJson ? parsed : asString)
        }

        src.on('data', onData)
        src.once('end', onEnd)
      })

      req.once('error', onReqError)
      req.once('socket', (socket) => socket.setNoDelay(true))
      req.setTimeout(this.timeout, onTimeout)

      if (payload != null) req.end(payload)
      else req.end()
    })
  }

  async updatePlayer({ guildId, data, noReplace = false }) {
    const base = this._sessionBase()
    return this.makeRequest(
      'PATCH',
      `${base}/players/${guildId}?noReplace=${_bool(noReplace)}`,
      data
    )
  }

  async getPlayer(guildId) {
    const base = this._sessionBase()
    return this.makeRequest('GET', `${base}/players/${guildId}`)
  }

  async getPlayers() {
    const base = this._sessionBase()
    return this.makeRequest('GET', `${base}/players`)
  }

  async destroyPlayer(guildId) {
    const base = this._sessionBase()
    return this.makeRequest('DELETE', `${base}/players/${guildId}`)
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
    const gid = track?.guild_id ?? track?.guildId
    const hasEncoded = typeof track?.encoded === 'string' && isValidBase64(track.encoded)
    const hasTitle = track?.info?.title

    if (!track || (!gid && !hasEncoded && !hasTitle)) {
      this.aqua?.emit?.('error', '[Aqua/Lyrics] Invalid track object')
      return null
    }

    const skipParam = _bool(skipTrackSource)

    if (gid) {
      try {
        const base = this._sessionBase()
        const lyrics = await this.makeRequest(
          'GET',
          `${base}/players/${gid}/track/lyrics?skipTrackSource=${skipParam}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (hasEncoded) {
      try {
        const lyrics = await this.makeRequest(
          'GET',
          `/${API_VERSION}/lyrics?track=${encodeURIComponent(track.encoded)}&skipTrackSource=${skipParam}`
        )
        if (this._isValidLyrics(lyrics)) return lyrics
      } catch {}
    }

    if (hasTitle) {
      const query = track.info.author ? `${track.info.title} ${track.info.author}` : track.info.title
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
    try {
      const base = this._sessionBase()
      const result = await this.makeRequest(
        'POST',
        `${base}/players/${guildId}/lyrics/subscribe?skipTrackSource=${_bool(skipTrackSource)}`
      )
      return result === null
    } catch {
      return false
    }
  }

  async unsubscribeLiveLyrics(guildId) {
    try {
      const base = this._sessionBase()
      const result = await this.makeRequest(
        'DELETE',
        `${base}/players/${guildId}/lyrics/subscribe`
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
