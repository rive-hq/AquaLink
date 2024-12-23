const { getImageUrl } = require("../handlers/fetchImage");

/**
 * @typedef {import("../Aqua")} Aqua
 * @typedef {import("../structures/Player")} Player
 * @typedef {import("../structures/Node")} Node
 */
class Track {
  /**
   * @param {{ encoded: string, info: { identifier: string, isSeekable: boolean, author: string, length: number, isStream: boolean, position: number, title: string, uri: string, sourceName: string, artworkUrl: string, track: string }, playlist?: { name: string, selectedTrack: number } }} data
   * @param {Player} requester
   * @param {Node} nodes
   */
  constructor(data, requester, nodes) {
    const { encoded, info, playlist = null } = data;
    this.info = Object.freeze({ ...info });
    this.requester = requester;
    this.nodes = nodes;
    this.track = encoded || null;
    this.playlist = playlist;
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

    const query = `${this.info.author} - ${this.info.title}`;
    try {
      const result = await aqua.resolve({
        query,
        source: aqua.options.defaultSearchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;

      const matchedTrack = this.findBestMatch(result.tracks) || result.tracks[0];
      if (matchedTrack) {
        this.updateTrackInfo(matchedTrack);
        return this;
      }
      return null;
    } catch (error) {
      console.error('Error resolving track:', error);
      return null;
    }
  }

  /**
   * @param {Array<Track>} tracks
   * @returns {Track|null}
   */
  findBestMatch(tracks) {
    if (!Array.isArray(tracks)) return null;
    
    const { title, author, length } = this.info;
    for (const track of tracks) {
      const { author: tAuthor, title: tTitle, length: tLength } = track.info;
      if (tAuthor === author && tTitle === title && this.isLengthMatch(tLength, length)) {
        return track;
      }
    }
    return null;
  }

  /**
   * @param {number} tLength
   * @param {number} length
   * @returns {boolean}
   */
  isLengthMatch(tLength, length) {
    if (!length) return true;
    const threshold = 2000;
    return tLength >= (length - threshold) && tLength <= (length + threshold);
  }

  /**
   * @param {Track} track
   */
  updateTrackInfo(track) {
    if (!track) return;
    this.info.identifier = track.info.identifier;
    this.track = track.track;
    this.playlist = track.playlist || null;
  }
}

module.exports = { Track };
