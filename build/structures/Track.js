const { getImageUrl } = require("../handlers/fetchImage");

/**
 * @typedef {import("../Aqua")} Aqua
 * @typedef {import("../structures/Player")} Player
 * @typedef {import("../structures/Node")} Node
 */

class Track {
  /**
   * @param {Object} data
   * @param {Player} requester
   * @param {Node} nodes
   */
  constructor(data, requester, nodes) {
    const info = data.info || {};
    
    this.info = {
      identifier: info.identifier || '',
      isSeekable: info.isSeekable || false,
      author: info.author || '',
      length: ~~info.length, 
      isStream: info.isStream || false,
      title: info.title || '',
      uri: info.uri || '',
      sourceName: info.sourceName || '',
      artworkUrl: info.artworkUrl || ''
    };

    this.track = data.encoded || null;
    this.playlist = data.playlist || null;
    this.requester = requester;
    this.nodes = nodes;
  }

  /**
   * @param {string} thumbnail
   * @returns {string|null}
   */
  resolveThumbnail(thumbnail) {
    return !thumbnail ? null : thumbnail.startsWith("http") ? thumbnail : getImageUrl(thumbnail, this.nodes);
  }

  /**
   * @param {Aqua} aqua
   * @returns {Promise<Track|null>}
   */
  async resolve(aqua) {
    if (!aqua || !aqua.options) return null;
    const platform = aqua.options.defaultSearchPlatform;
    if (!platform) return null;

    const info = this.info;
    
    try {
      const query = info.author + ' - ' + info.title;
      
      const result = await aqua.resolve({
        query,
        source: platform,
        requester: this.requester,
        node: this.nodes
      });

      const tracks = result?.tracks;
      if (!tracks?.length) return null;

      const len = tracks.length;
      let match = null;

      const targetAuthor = info.author;
      const targetTitle = info.title;
      const targetLength = info.length;

      for (let i = 0; i < len; i++) {
        const track = tracks[i];
        const trackInfo = track.info;
        
        if (trackInfo.author === targetAuthor && 
            trackInfo.title === targetTitle && 
            (!targetLength || Math.abs(trackInfo.length - targetLength) <= 2000)) {
          match = track;
          break;
        }
      }

      if (!match) match = tracks[0];
      
      if (!match) return null;

      info.identifier = match.info.identifier;
      this.track = match.track;
      this.playlist = match.playlist || null;
      
      return this;

    } catch {
      return null;
    }
  }


  destroy() {
    Object.assign(this, {
      requester: null,
      nodes: null,
      track: null,
      playlist: null,
      info: null
    });
  }
}

module.exports = { Track };
