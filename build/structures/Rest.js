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

        this.client = secure ? https || http2 : http;
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

        if (!this.agent) {
            const AgentClass = this.secure ? https.Agent : http.Agent;
            this.agent = new AgentClass({
                keepAlive: true,
                maxSockets: 10,
                maxFreeSockets: 5,
                timeout: this.timeout,
                freeSocketTimeout: 30000
            });
        }

        const options = {
            method,
            headers: this.headers,
            timeout: this.timeout,
            agent: this.agent
        };

        return new Promise((resolve, reject) => {
            const client = this.secure ? https : http;
            const req = client.request(url, options, (res) => {
                if (res.statusCode === 204) return resolve(null);

                const chunks = [];
                let totalLength = 0;

                res.on('data', (chunk) => {
                    chunks.push(chunk);
                    totalLength += chunk.length;
                });

                res.on('end', () => {
                    if (totalLength === 0) {
                        return resolve(null);
                    }

                    const buffer = Buffer.concat(chunks, totalLength);
                    const data = buffer.toString('utf8');

                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Failed to parse response: ${err.message}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`Request failed (${method} ${url}): ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out after ${this.timeout}ms (${method} ${url})`));
            });

            if (body) {
                const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                req.write(bodyStr);
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
        if (!track || !track) {
            console.error("Invalid track object provided.");
            return null;
        }

        console.log(track)

        try {
            // Extract video ID for YouTube tracks
            let videoId = track.identifier;
            // Try fetching YouTube timed lyrics if applicable
            if (videoId) {
                try {
                    const youtubeLyrics = await this.makeRequest(
                        "GET",
                        `/${this.version}/lyrics/${encodeURIComponent(videoId)}`
                    );
                    if (youtubeLyrics) {
                        return youtubeLyrics;
                    }
                } catch (error) {
                    console.warn(`Failed to fetch YouTube lyrics: ${error.message}`);
                }
            }

            // Fallback to player-based lyrics if guild_id is provided
            if (track.guild_id) {
                this.validateSessionId();
                try {
                    const playerLyrics = await this.makeRequest(
                        "GET",
                        `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}/track/lyrics?skipTrackSource=true`
                    );
                    if (playerLyrics) {
                        return playerLyrics;
                    }
                } catch (error) {
                    console.warn(`Failed to fetch player lyrics: ${error.message}`);
                }
            }

            // Fallback to search-based lyrics using Genius
            const query = encodeURIComponent(`${track.info.title} ${track.info.author || ""}`.trim());
            try {
                const searchLyrics = await this.makeRequest(
                    "GET",
                    `/${this.version}/lyrics/search?query=${query}&source=genius`
                );
                if (searchLyrics) {
                    return searchLyrics;
                }
            } catch (error) {
                console.warn(`Failed to fetch search lyrics: ${error.message}`);
            }

            console.error("All lyric fetch attempts failed.");
            return null;
        } catch (error) {
            console.error(`Failed to fetch lyrics: ${error.message}`);
            return null;
        }
    }
}

module.exports = Rest;
