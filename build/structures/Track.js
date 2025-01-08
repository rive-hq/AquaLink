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
    const info = data?.info || {};
    
    this.info = {
      identifier: info.identifier || '',
      isSeekable: !!info.isSeekable,
      author: info.author || '',
      length: ~~info.length,
      isStream: !!info.isStream,
      title: info.title || '',
      uri: info.uri || '',
      sourceName: info.sourceName || '',
      artworkUrl: info.artworkUrl || ''
    };

    this.track = data?.encoded || null;
    this.playlist = data?.playlist || null;
    this.requester = requester;
    this.nodes = nodes;
  }

  /**
   * @param {string} thumbnail
   * @returns {string|null}
   */
  resolveThumbnail(thumbnail) {
    if (!thumbnail) return null;
    return thumbnail.startsWith("http") ? thumbnail : getImageUrl(thumbnail, this.nodes);
  }

  /**
   * @param {Aqua} aqua
   * @returns {Promise<Track|null>}
   */
  async resolve(aqua) {
    if (!aqua?.options?.defaultSearchPlatform) return null;

    try {
      const result = await aqua.resolve({
        query: this.info.author + ' - ' + this.info.title,
        source: aqua.options.defaultSearchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;

      const track = this._findMatchingTrack(result.tracks);
      if (!track) return null;

      this._updateTrack(track);
      return this;
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  _findMatchingTrack(tracks) {
    const { author, title, length } = this.info;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const tInfo = track.info;
      
      if (tInfo.author === author && 
          tInfo.title === title && 
          (!length || Math.abs(tInfo.length - length) <= 2000)) {
        return track;
      }
    }

    return tracks[0];
  }

  /**
   * @private
   */
  _updateTrack(track) {
    this.info.identifier = track.info.identifier;
    this.track = track.track;
    this.playlist = track.playlist || null;
  }

  /**
   * Fast cleanup
   */
  destroy() {
    this.requester = null;
    this.nodes = null;
    this.track = null;
    this.playlist = null;
    this.info = null;
  }
}

module.exports = { Track };
