"use strict";
const { Pool } = require("undici");

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
        this.client = new Pool(this.baseUrl, { pipelining: 1 });
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null) {
        try {
            const response = await this.client.request({
                path: endpoint,
                method,
                headers: this.headers,
                body: body ? JSON.stringify(body) : undefined,
            });

            return response.statusCode === 204 ? null : await response.body.json();
        } catch (error) {
            throw new Error(`Request failed (${method} ${endpoint}): ${error.message}`);
        }
    }

    validateSessionId() {
        if (!this.sessionId) throw new Error("Session ID is not set.");
    }

    async updatePlayer({ guildId, data }) {
        if ((data.track?.encoded && data.track?.identifier) || (data.encodedTrack && data.identifier)) {
            throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
        }
        this.validateSessionId();
        return this.makeRequest("PATCH", `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`, data);
    }

    async getPlayers() {
        this.validateSessionId();
        return this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players`);
    }

    async destroyPlayer(guildId) {
        this.validateSessionId();
        return this.makeRequest("DELETE", `/${this.version}/sessions/${this.sessionId}/players/${guildId}`);
    }

    async getTracks(identifier) {
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);
    }

    async decodeTrack(track) {
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`);
    }

    async decodeTracks(tracks) {
        return this.makeRequest("POST", `/${this.version}/decodetracks`, tracks);
    }

    async getStats() {
        return this.makeRequest("GET", `/${this.version}/stats`);
    }

    async getInfo() {
        return this.makeRequest("GET", `/${this.version}/info`);
    }

    async getRoutePlannerStatus() {
        return this.makeRequest("GET", `/${this.version}/routeplanner/status`);
    }

    async getRoutePlannerAddress(address) {
        return this.makeRequest("POST", `/${this.version}/routeplanner/free/address`, { address });
    }

    async getLyrics({ track }) {
        if (track.search) {
            const res = await this.makeRequest("GET", `/${this.version}/lyrics/search?query=${encodeURIComponent(track.encoded.info.title)}&source=genius`);
            if (res) return res;
        }
        this.validateSessionId();
        return this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=false`);
    }
}

module.exports = Rest;
