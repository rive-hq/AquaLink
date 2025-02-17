"use strict";
const { Pool } = require("undici");

class Rest {
    constructor(aqua, { secure, host, port, sessionId, password }) {
        this.aqua = aqua;
        this.sessionId = sessionId;
        this.version = "v4";
        this.baseUrl = new URL(`http${secure ? "s" : ""}://${host}:${port}`).toString();
        this.headers = Object.freeze({
            "Content-Type": "application/json",
            Authorization: password,
        });
        this.client = new Pool(this.baseUrl, {
            pipelining: 6,
            connections: 4, 
            keepAliveTimeout: 30000,
            keepAliveMaxTimeout: 60000,
            bodyTimeout: 10000,
            headersTimeout: 10000
        });
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null) {
        const options = {
            path: endpoint,
            method,
            headers: this.headers,
            ...(body && { body: JSON.stringify(body) })
        };

        let response;
        try {
            response = await this.client.request(options);
            const { statusCode } = response;
            
            if (statusCode === 204) return null;
            
            const result = await response.body.json();
            return result;
        } catch (error) {
            throw new Error(`Request to ${endpoint} failed: ${error.message}`);
        } finally {
            if (response?.body) {
                await response.body.dump();
            }
        }
    }

    buildEndpoint(...segments) {
        return '/' + segments.filter(Boolean).join('/');
    }

    validateSessionId() {
        if (!this.sessionId) throw new Error("Session ID is not set.");
    }

    async updatePlayer({ guildId, data }) {
        if (!guildId || !data) throw new Error("Invalid parameters");
        
        if ((data.track?.encoded && data.track?.identifier) || 
            (data.encodedTrack && data.identifier)) {
            throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
        }

        this.validateSessionId();
        const endpoint = `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`;
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
        const encoded = encodeURIComponent(identifier);
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encoded}`);
    }

    async decodeTrack(track) {
        const encoded = encodeURIComponent(track);
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encoded}`);
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
            const encoded = encodeURIComponent(track.encoded.info.title);
            const res = await this.makeRequest("GET", `/v4/lyrics/search?query=${encoded}&source=genius`);
            if (res) return res;
        }
        
        this.validateSessionId();
        return this.makeRequest(
            "GET", 
            `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=false`
        );
    }
}

module.exports = Rest;
