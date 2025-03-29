"use strict";
const https = require("https");
const http = require("http");

let http2;
try {
    http2 = require("http2");
} catch (e) {
}

class Rest {
    constructor(aqua, { secure = false, host, port, sessionId = null, password, timeout = 30000 }) {
        this.aqua = aqua;
        this.sessionId = sessionId;
        this.version = "v4";
        this.baseUrl = `${secure ? "https" : "http"}://${host}:${port}`;
        this.headers = {
            "Content-Type": "application/json",
            "Authorization": password,
        };
        this.secure = secure;
        this.timeout = timeout;
        
        this.client = secure ? (http2 || https) : http;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null) {
        const url = `${this.baseUrl}${endpoint}`;
        const options = {
            method,
            headers: this.headers,
            timeout: this.timeout,
        };

        return new Promise((resolve, reject) => {
            const req = this.client.request(url, options, (res) => {
                res.setEncoding('utf8');
                
                let data = '';
                
                res.on("data", (chunk) => {
                    data += chunk;
                });
                
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (!data) {
                            resolve(null);
                            return;
                        }
                        
                        try {
                            resolve(JSON.parse(data));
                        } catch (error) {
                            reject(new Error(`Failed to parse response: ${error.message}`));
                        }
                    } else {
                        reject(new Error(`Request failed with status ${res.statusCode}: ${res.statusMessage || 'Unknown error'}`));
                    }
                });
            });

            req.on("error", (error) => reject(new Error(`Request failed (${method} ${url}): ${error.message}`)));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error(`Request timeout after ${this.timeout}ms (${method} ${url})`));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    validateSessionId() {
        if (!this.sessionId) throw new Error("Session ID is required but not set.");
    }

    async updatePlayer({ guildId, data }) {
        if (data.track && data.track.encoded && data.track.identifier) {
            throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
        }
        
        this.validateSessionId();
        return this.makeRequest(
            "PATCH", 
            `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`, 
            data
        );
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
        if (!track) return null;
        
        try {
            if (track.search) {
                const query = encodeURIComponent(track.info.title);
                try {
                    const res = await this.makeRequest("GET", `/${this.version}/lyrics/search?query=${query}&source=genius`);
                    if (res) return res;
                } catch (err) {}
            } else {
                this.validateSessionId();
                return await this.makeRequest(
                    "GET", 
                    `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=false`
                );
            }
         
        } catch (error) {
            console.error("Failed to fetch lyrics:", error.message);
            return null;
        }
    }
}

module.exports = Rest;
