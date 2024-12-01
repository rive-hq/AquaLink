const { getImageUrl } = require("../handlers/fetchImage");

/**
 * @typedef {import("../Aqua")} Aqua
 * @typedef {import("../structures/Player")} Player
 * @typedef {import("../structures/Node")} Node
 */
class Track {
    /**
     * @param {{ encoded: string, info: { identifier: string, isSeekable: boolean, author: string, length: number, isStream: boolean, position: number, title: string, uri: string, sourceName: string, thumbnail: string, track: string, tracks: Array<Track>, playlist: { name: string, selectedTrack: number } } }} data
     * @param {Player} requester
     * @param {Node} nodes
     */
    constructor(data, requester, nodes) {
        this.rawData = data;
        this.info = data.info;
        this.requester = requester;
        this.nodes = nodes;

        if (data.encoded) {
            this.track = data.encoded;
        } else {
            this.track = Buffer.from(data.track, "base64").toString("utf8");
        }
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
        const query = `${this.info.author} - ${this.info.title}`;
        const result = await aqua.resolve({ query, source: aqua.options.defaultSearchPlatform, requester: this.requester, node: this.nodes });

        if (!result || !result.tracks.length) return null;

        const matchedTrack = this.findBestMatch(result.tracks);
        if (matchedTrack) {
            this.updateTrackInfo(matchedTrack);
            return this;
        }
        this.updateTrackInfo(result.tracks[0]);
        return this;
    }

    /**
     * @param {Array<Track>} tracks
     * @returns {Track|null}
     */
    findBestMatch(tracks) {
        const titleLower = this.info.title.toLowerCase();
        const authorLower = this.info.author.toLowerCase();
        const exactMatch = tracks.find(track =>
            track.info.author.toLowerCase() === authorLower && track.info.title.toLowerCase() === titleLower
        );
        if (exactMatch) return exactMatch;
        const authorMatch = tracks.find(track => track.info.author.toLowerCase() === authorLower);
        if (authorMatch) return authorMatch;
        const titleMatch = tracks.find(track => track.info.title.toLowerCase() === titleLower);
        if (titleMatch) return titleMatch;
        if (this.info.length) {
            return tracks.find(track =>
                track.info.length >= (this.info.length - 2000) && track.info.length <= (this.info.length + 2000)
            );
        }

        return null;
    }

    /**
     * @param {Track} track
     */
    updateTrackInfo(track) {
        this.info.identifier = track.info.identifier;
        this.track = track.track;
    }

    /**
     * @private
     */
    cleanup() {
        this.rawData = null;
        this.track = null;
        this.info = null;
    }
}

module.exports = { Track };

