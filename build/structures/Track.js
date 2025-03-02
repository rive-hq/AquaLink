"use strict";
const { getImageUrl } = require("../handlers/fetchImage");

class Track {
  constructor(data = {}, requester, nodes) {
    const { info = {}, encoded = null, playlist = null } = data;
    this.info = {
      identifier: info.identifier || '',
      isSeekable: !!info.isSeekable,
      author: info.author || '',
      length: info.length | 0,
      isStream: !!info.isStream,
      title: info.title || '',
      uri: info.uri || '',
      sourceName: info.sourceName || '',
      artworkUrl: info.artworkUrl || ''
    };
    this.track = encoded;
    this.playlist = playlist;
    this.requester = requester;
    this.nodes = nodes;
  }

  resolveThumbnail(thumbnail) {
    return thumbnail ? getImageUrl(thumbnail) : null;
  }

  async resolve(aqua) {
    const searchPlatform = aqua?.options?.defaultSearchPlatform;
    if (!searchPlatform) {
      console.warn("No search platform configured.");
      return null;
    }

    try {
      const query = `${this.info.author} - ${this.info.title}`;
      const result = await aqua.resolve({
        query,
        source: searchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;
      const track = this._findMatchingTrack(result.tracks);
      if (!track) return null;

      this.info.identifier = track.info.identifier;
      this.track = track.track;
      this.playlist = track.playlist || null;
      return this;
    } catch (error) {
      console.error("Error resolving track:", error);
      return null;
    }
  }

  _findMatchingTrack(tracks) {
    const { author, title, length } = this.info;
    for (const track of tracks) {
      const tInfo = track.info;
      if (author === tInfo.author && title === tInfo.title) {
        if (!length || Math.abs(tInfo.length - length) <= 2000) {
          return track;
        }
      }
    }
    return null;
  }
}

module.exports = Track;
