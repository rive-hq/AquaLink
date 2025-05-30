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

        this.client = secure ? http2 || https : http;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    validateSessionId() {
        if (!this.sessionId) {
            throw new Error("Session ID is required but not set.");
        }
    }

    async makeRequest(method, endpoint, body = null) {
        const url = `${this.baseUrl}${endpoint}`;
        const options = {
            method,
            headers: this.headers,
            timeout: this.timeout,
            keepAlive: true,
        };

        return new Promise((resolve, reject) => {
            const req = this.client.request(url, options, (res) => {
                const chunks = [];
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    const data = chunks.join("");
                    if (!data) {
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Failed to parse response: ${err.message}`));
                    }
                });
            });

            req.on("error", (err) => reject(new Error(`Request failed (${method} ${url}): ${err.message}`)));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error(`Request timed out after ${this.timeout}ms (${method} ${url})`));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    async updatePlayer({ guildId, data }) {
        if (data.track?.encoded && data.track?.identifier) {
            throw new Error("You cannot provide both 'encoded' and 'identifier' for a track.");
        }

        this.validateSessionId();

        const endpoint = `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`;
        return this.makeRequest("PATCH", endpoint, data);
    }

    async getPlayers() {
        this.validateSessionId();
        const endpoint = `/${this.version}/sessions/${this.sessionId}/players`;
        return this.makeRequest("GET", endpoint);
    }

    async destroyPlayer(guildId) {
        this.validateSessionId();
        const endpoint = `/${this.version}/sessions/${this.sessionId}/players/${guildId}`;
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
        if (!track) return null;

        try {
            if (track.search) {
                const query = encodeURIComponent(track.info.title);
                try {
                    const res = await this.makeRequest(
                        "GET", 
                        `/${this.version}/lyrics/search?query=${query}&source=genius`
                    );
                    if (res) return res;
                } catch (_) {
                }
            } else {
                this.validateSessionId();
                return await this.makeRequest(
                    "GET",
                    `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=true`
                );
            }
        } catch (error) {
            console.error("Failed to fetch lyrics:", error.message);
            return null;
        }
        return null;
    }
}

module.exports = Rest;
