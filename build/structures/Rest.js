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
            body: body ? JSON.stringify(body) : undefined,
        };

        try {
            const { statusCode, headers, body: responseBody } = await request(`${this.baseUrl}${endpoint}`, options);
            this.aqua.emit("apiResponse", endpoint, { status: statusCode, headers: headers });

            if (statusCode === 204) {
                return null;
            }

            const data = await responseBody.text();
            return data ? JSON.parse(data) : null;
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

    updatePlayer({ guildId, data }) {
        if ((data.track?.encoded && data.track?.identifier) || (data.encodedTrack && data.identifier)) {
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
        const endpoint = `/${this.version}/stats/all`;
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
