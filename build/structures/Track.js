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
        this.rawData = data;
        this.info = data.info;
        this.requester = requester;
        this.nodes = nodes;
        this.track = data.encoded || Buffer.from(data.track, "base64").toString("utf8");
        this.playlist = data.playlist || null;
    }

    /**
     * @param {string} thumbnail
     * @returns {string|null}
     */
    resolveThumbnail(thumbnail) {
        return thumbnail ? (thumbnail.startsWith("http") ? thumbnail : getImageUrl(thumbnail, this.nodes)) : null;
    }

    /**
     * @param {Aqua} aqua
     * @returns {Promise<Track|null>}
     */
    async resolve(aqua) {
        const query = `${this.info.author} - ${this.info.title}`;
        const result = await aqua.resolve({ query, source: aqua.options.defaultSearchPlatform, requester: this.requester, node: this.nodes });
        const matchedTrack = result?.tracks?.length ? this.findBestMatch(result.tracks) || result.tracks[0] : null;
        if (matchedTrack) this.updateTrackInfo(matchedTrack);
        return matchedTrack ? this : null;
    }

    /**
     * @param {Array<Track>} tracks
     * @returns {Track|null}
     */
    findBestMatch(tracks) {
        const { title, author, length } = this.info;
        const titleLower = title.toLowerCase();
        const authorLower = author.toLowerCase();
        return tracks.find(track => {
            const { author, title, length: tLength } = track.info;
            return (author.toLowerCase() === authorLower && title.toLowerCase() === titleLower) ||
                   (author.toLowerCase() === authorLower) ||
                   (title.toLowerCase() === titleLower) ||
                   (length && tLength >= (length - 2000) && tLength <= (length + 2000));
        });
    }

    /**
     * @param {Track} track
     */
    updateTrackInfo(track) {
        this.info.identifier = track.info.identifier;
        this.track = track.track;
        if (track.playlist) {
            this.playlist = track.playlist;
        }
    }

    /**
     * @private
     */
    cleanup() {
        this.rawData = this.track = this.info = this.playlist = null;
    }
}

module.exports = { Track };

