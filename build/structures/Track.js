'use strict';

const YT_ID_RE = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/;

class Track {
  constructor(data = {}, requester = null, node = null) {
    const info = data.info || {};

    this.track = data.track || data.encoded || null;

    this.identifier = typeof info.identifier === 'string' ? info.identifier : '';
    this.isSeekable = Boolean(info.isSeekable);
    this.author = typeof info.author === 'string' ? info.author : '';
    this.position = Number.isFinite(info.position) ? info.position : 0;
    this.duration = Number.isFinite(info.length) ? info.length : 0;
    this.isStream = Boolean(info.isStream);
    this.title = typeof info.title === 'string' ? info.title : '';
    this.uri = typeof info.uri === 'string' ? info.uri : '';
    this.sourceName = typeof info.sourceName === 'string' ? info.sourceName : '';
    this.artworkUrl = typeof info.artworkUrl === 'string' ? info.artworkUrl : '';

    this.playlist = data.playlist || null;

    this.node = node || data.node || null;
    this.nodes = data.nodes || null;

    this.requester = requester || null;

    this._infoCache = null;
  }

  get info() {
    if (this._infoCache) return this._infoCache;
    const artwork = this.artworkUrl || this._computeArtworkFromKnownSources();
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
      artworkUrl: artwork || null
    });
    return this._infoCache;
  }

  get length() {
    return this.duration;
  }

  get thumbnail() {
    return this.artworkUrl || this._computeArtworkFromKnownSources();
  }

  async resolve(aqua, opts = {}) {
    if (this.track && typeof this.track === 'string') return this;

    if (!aqua || typeof aqua.resolve !== 'function') return null;

    const platform = opts.platform || aqua?.options?.defaultSearchPlatform || 'ytsearch';
    const node = opts.node || this.node || this.nodes || undefined;

    let query = this.uri;
    if (!query) {
      if (this.title) {
        query = this.author ? `${this.author} - ${this.title}`.trim() : this.title.trim();
      } else if (this.identifier && this.sourceName?.toLowerCase().includes('youtube')) {
        query = this.identifier;
      }
    }
    if (!query) return null;

    const payload = { query, source: platform, requester: this.requester };
    if (node) payload.node = node;

    let result;
    try {
      result = await aqua.resolve(payload);
    } catch {
      return null;
    }

    const found = result?.tracks?.[0];
    if (!found) return null;

    this.track = typeof found.track === 'string' ? found.track : (found.encoded || this.track);

    this.identifier = info.identifier ?? this.identifier;
    this.title = info.title ?? this.title;
    this.author = info.author ?? this.author;
    this.uri = info.uri ?? this.uri;
    this.sourceName = info.sourceName ?? this.sourceName;
    this.artworkUrl = info.artworkUrl ?? this.artworkUrl;
    this.isSeekable = Boolean(info.isSeekable);
    this.isStream = Boolean(info.isStream);
    this.position = Number.isFinite(info.position) ? info.position : this.position;
    this.duration = Number.isFinite(info.length) ? info.length : this.duration;

    this.playlist = found.playlist ?? this.playlist;
    this._infoCache = null;

    return this;
  }

  isValid() {
    return (typeof this.track === 'string' && this.track.length > 0)
        || (typeof this.uri === 'string' && this.uri.length > 0);
  }

  dispose() {
    this._infoCache = null;
    this.requester = null;
    this.node = null;
    this.nodes = null;
  }

  _computeArtworkFromKnownSources() {
    let id = this.identifier;
    if (!id && this.uri) {
      const m = String(this.uri).match(YT_ID_RE);
      if (m) id = m[1];
    }
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }
}

module.exports = Track;