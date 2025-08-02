'use strict'

const { getImageUrl } = require('../handlers/fetchImage')

class Track {
  constructor(data = {}, requester, nodes) {
    const info = data.info || {}

    this.identifier = info.identifier || ''
    this.isSeekable = !!info.isSeekable
    this.author = info.author || ''
    this.position = info.position || 0
    this.duration = info.length || 0
    this.isStream = !!info.isStream
    this.title = info.title || ''
    this.uri = info.uri || ''
    this.sourceName = info.sourceName || ''
    this.artworkUrl = info.artworkUrl || ''

    this.track = data.encoded || null
    this.playlist = data.playlist || null
    this.requester = requester
    this.nodes = nodes

    this._infoCache = null
  }

  get info() {
    if (!this._infoCache) {
      this._infoCache = Object.freeze({
        identifier: this.identifier,
        isSeekable: this.isSeekable,
        position: this.position,
        author: this.author,
        length: this.duration,
        isStream: this.isStream,
        title: this.title,
        uri: this.uri,
        sourceName: this.sourceName,
        artworkUrl: this.artworkUrl
      })
    }
    return this._infoCache
  }

  get length() {
    return this.duration
  }

  get thumbnail() {
    return this.artworkUrl
  }

  resolveThumbnail(url = this.artworkUrl) {
    if (!url) return null
    try {
      return getImageUrl(url)
    } catch {
      return null
    }
  }

  async resolve(aqua) {
    if (!aqua?.options?.defaultSearchPlatform || !this.author || !this.title) {
      return null
    }

    try {
      const result = await aqua.resolve({
        query: `${this.author} - ${this.title}`,
        source: aqua.options.defaultSearchPlatform,
        requester: this.requester,
        node: this.nodes
      })

      const track = result?.tracks?.[0]
      if (!track) return null

      this.identifier = track.info.identifier
      this.track = track.track
      this.playlist = track.playlist || null
      this._infoCache = null

      return this
    } catch {
      return null
    }
  }

  isValid() {
    return !!(this.identifier && this.title && (this.track || this.uri))
  }

  dispose() {
    this._infoCache = null
    this.requester = null
    this.nodes = null
  }
}

module.exports = Track
