"use strict";

const { request } = require("undici");
class Rest {
    constructor(aqua, { secure, host, port, sessionId, password }) {
        this.aqua = aqua;
        this.sessionId = sessionId;
        this.version = "v4";
        this.baseUrl = `http${secure ? "s" : ""}://${host}:${port}`;
        this.headers = {
            "Content-Type": "application/json",
            Authorization: password,
        };
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null) {
        const options = {
            method,
            headers: this.headers,
        };
        if (body && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            options.body = JSON.stringify(body);
        }
        try {
            const response = await request(`${this.baseUrl}${endpoint}`, options);
            const data = response.status === 204 ? null : await response.body.json();
            return data;
        } catch (error) {
            throw new Error(`Request to ${endpoint} failed: ${error.message}`);
        }
    }

    buildEndpoint(...segments) {
        const validSegments = segments.filter(segment => segment && segment.trim());
        return '/' + validSegments.join('/');
    }

    validateSessionId() {
        if (!this.sessionId) {
            throw new Error("Session ID is not set.");
        }
    }

    async updatePlayer({ guildId, data }) {
        const hasEncodedTrack = data.track?.encoded && data.track?.identifier;
        const hasEncodedTrackAlt = data.encodedTrack && data.identifier;

        if (hasEncodedTrack || hasEncodedTrackAlt) {
            throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
        }

        this.validateSessionId();
        const endpoint = this.buildEndpoint(this.version, "sessions", this.sessionId, "players", guildId) + "?noReplace=false";
        return this.makeRequest("PATCH", endpoint, data);
    }

    async getPlayers() {
        this.validateSessionId();
        const endpoint = this.buildEndpoint(this.version, "sessions", this.sessionId, "players");
        return this.makeRequest("GET", endpoint);
    }

    async destroyPlayer(guildId) {
        this.validateSessionId();
        const endpoint = this.buildEndpoint(this.version, "sessions", this.sessionId, "players", guildId);
        return this.makeRequest("DELETE", endpoint);
    }

    async getTracks(identifier) {
        const endpoint = `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`;
        return this.makeRequest("GET", endpoint);
    }

    async decodeTrack(track) {
        const endpoint = `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`;
        return this.makeRequest("GET", endpoint);
    }

    async decodeTracks(tracks) {
        const endpoint = `/${this.version}/decodetracks`;
        return this.makeRequest("POST", endpoint, tracks);
    }

    async getStats() {
        const endpoint = `/${this.version}/stats`;
        return this.makeRequest("GET", endpoint);
    }

    async getInfo() {
        const endpoint = `/${this.version}/info`;
        return this.makeRequest("GET", endpoint);
    }

    async getRoutePlannerStatus() {
        const endpoint = `/${this.version}/routeplanner/status`;
        return this.makeRequest("GET", endpoint);
    }

    async getRoutePlannerAddress(address) {
        const endpoint = `/${this.version}/routeplanner/free/address`;
        return this.makeRequest("POST", endpoint, { address });
    }

    async getLyrics({ track }) {
        if (track.search) {
            const endpoint = `/v4/lyrics/search?query=${encodeURIComponent(track.encoded.info.title)}&source=genius`;
            const res = await this.makeRequest("GET", endpoint);
            if (res) return res;
        }
        this.validateSessionId();
        const endpoint = this.buildEndpoint(this.version, "sessions", this.sessionId, "players", track.guild_id, "track", "lyrics") + "?skipTrackSource=false";
        return this.makeRequest("GET", endpoint);
    }
}

module.exports = Rest;
