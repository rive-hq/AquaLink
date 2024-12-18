const { getImageUrl } = require("../handlers/fetchImage");
/**
 * @typedef {import("../Aqua")} Aqua
 * @typedef {import("../structures/Player")} Player
 * @typedef {import("../structures/Node")} Node
 */
class Track {
  /**
   * @param {{ encoded: string, info: { identifier: string, isSeekable: boolean, author: string, length: number, isStream: boolean, position: number, title: string, uri: string, sourceName: string, artworkUrl: string, track: string, tracks: Array<Track>, playlist: { name: string, selectedTrack: number } } }} data
   * @param {Player} requester
   * @param {Node} nodes
   */
  constructor(data, requester, nodes) {
    this.info = Object.assign({}, data.info);
    this.requester = requester;
    this.nodes = nodes;
    this.track = data.encoded || Buffer.from(data.track, "base64").toString("utf8");
    this.playlist = data.playlist ? Object.assign({}, data.playlist) : null;
  }

  /**
   * @param {string} thumbnail
   * @returns {string|null}
   */
  resolveThumbnail(thumbnail) {
    return thumbnail && (thumbnail.startsWith("http") ? thumbnail : getImageUrl(thumbnail, this.nodes)) || null;
  }

  /**
   * @param {Aqua} aqua
   * @returns {Promise<Track|null>}
   */
  async resolve(aqua) {
    const query = `${this.info.author} - ${this.info.title}`;
    try {
      const result = await aqua.resolve({ query, source: aqua.options.defaultSearchPlatform, requester: this.requester, node: this.nodes });
      if (!result?.tracks?.length) return null;

      const matchedTrack = this.findBestMatch(result.tracks) || result.tracks[0];
      this.updateTrackInfo(matchedTrack);
      return this;
    } catch (error) {
      console.error(`Error resolving track: ${error.message}`);
      return null;
    }
  }

  /**
   * @param {Array<Track>} tracks
   * @returns {Track|null}
   */
  findBestMatch(tracks) {
    const { title, author, length } = this.info;
    return tracks.find(track => {
      const { author: tAuthor, title: tTitle, length: tLength } = track.info;
      return tAuthor === author && tTitle === title && this.isLengthMatch(tLength, length);
    });
  }

  /**
   * @param {number} tLength
   * @param {number} length
   * @returns {boolean}
   */
  isLengthMatch(tLength, length) {
    return !length || (tLength >= (length - 2000) && tLength <= (length + 2000));
  }

  /**
   * @param {Track} track
   */
  updateTrackInfo(track) {
    Object.assign(this.info, track.info);
    this.track = track.track;
    if (track.playlist) {
      this.playlist = Object.assign({}, track.playlist);
    }
  }

  /**
   * @private
   */
  cleanup() {
    this.info = null;
    this.track = null;
    this.playlist = null;
  }
}

module.exports = { Track };

