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
    const { encoded = null, info = {}, playlist = null } = data;
    this.info = Object.freeze({
      identifier: info.identifier,
      isSeekable: info.isSeekable,
      author: info.author,
      length: info.length,
      isStream: info.isStream,
      title: info.title,
      uri: info.uri,
      sourceName: info.sourceName,
      artworkUrl: info.artworkUrl
    });
    this.requester = requester;
    this.nodes = nodes;
    this.track = encoded;
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

  async resolve(aqua) {
    if (!aqua?.options?.defaultSearchPlatform) return null;

    try {
      const query = `${this.info.author} - ${this.info.title}`;
      const result = await aqua.resolve({
        query,
        source: aqua.options.defaultSearchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;

      const matchedTrack = result.tracks.find(track => this.isTrackMatch(track)) || result.tracks[0];

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

  isTrackMatch(track) {
    const { author, title, length } = this.info;
    const { author: tAuthor, title: tTitle, length: tLength } = track.info;

    return tAuthor === author && 
           tTitle === title && 
           (!length || Math.abs(tLength - length) <= 2000);
  }

  /**
   * @param {Track} track
   */
  updateTrackInfo(track) {
    if (!track) return;
    this.info = Object.freeze({
      ...this.info,
      identifier: track.info.identifier
    });
    
    this.track = track.track;
    this.playlist = track.playlist || null;
  }

  /**
   * Cleanup method to help garbage collection
   */
  destroy() {
    this.requester = null;
    this.nodes = null;
    this.track = null;
    this.playlist = null;
  }
}

module.exports = { Track };
