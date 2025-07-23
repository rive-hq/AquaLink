const https = require("https");
const http = require("http");


const URL_PATTERN = /^https?:\/\/.+/;
const JSON_CONTENT_TYPE = /^application\/json/i;

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

        const AgentClass = secure ? https.Agent : http.Agent;
        this.agent = new AgentClass({
            keepAlive: true,
            maxSockets: 20,
            maxFreeSockets: 10,
            timeout: this.timeout,
            freeSocketTimeout: 30000,
            keepAliveMsecs: 1000
        });

        this.client = secure ? https : http;
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
            agent: this.agent
        };

        return new Promise((resolve, reject) => {
            const req = this.client.request(url, options, (res) => {
                if (res.statusCode === 204) return resolve(null);

                const chunks = [];
                let totalLength = 0;
                const maxSize = 10 * 1024 * 1024;

                res.on('data', (chunk) => {
                    totalLength += chunk.length;
                    if (totalLength > maxSize) {
                        req.destroy();
                        return reject(new Error('Response too large'));
                    }
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    if (totalLength === 0) return resolve(null);

                    const data = Buffer.concat(chunks, totalLength).toString('utf8');
                    
                    if (JSON_CONTENT_TYPE.test(res.headers['content-type'] || '')) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (err) {
                            reject(new Error(`JSON parse error: ${err.message}`));
                        }
                    } else {
                        resolve(data);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Timeout after ${this.timeout}ms`));
            });

            if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }

            req.end();
        });
    }

    async updatePlayer({ guildId, data }) {
        if (data.track?.encoded && data.track?.identifier) {
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

    async getLyrics({ track, skipTrackSource = false }) {
        if (!track || (!track.identifier && !track.info?.title && !track.guild_id)) {
            this.aqua.emit("error", "[Aqua/Lyrics] Invalid track object");
            return null;
        }

        const strategies = [
            () => this._getPlayerLyrics(track, skipTrackSource),
            () => this._getIdentifierLyrics(track),
            () => this._getSearchLyrics(track)
        ].filter(Boolean);

        for (const strategy of strategies) {
            try {
                const result = await strategy();
                if (result && !this._isErrorResponse(result)) {
                    return result;
                }
            } catch (error) {
                this.aqua.emit("debug", `[Aqua/Lyrics] Strategy failed: ${error.message}`);
            }
        }

        this.aqua.emit("debug", "[Aqua/Lyrics] All strategies failed");
        return null;
    }

    async _getPlayerLyrics(track, skipTrackSource) {
        if (!track.guild_id) return null;
        
        this.validateSessionId();
        const baseUrl = `/${this.version}/sessions/${this.sessionId}/players/${track.guild_id}`;
        const query = `?skipTrackSource=${skipTrackSource}`;
        
        try {
            return await this.makeRequest("GET", `${baseUrl}/lyrics${query}`);
        } catch {
            return await this.makeRequest("GET", `${baseUrl}/track/lyrics${query}`);
        }
    }

    async _getIdentifierLyrics(track) {
        if (!track.identifier) return null;
        
        return this.makeRequest("GET", `/${this.version}/lyrics/${encodeURIComponent(track.identifier)}`);
    }

    async _getSearchLyrics(track) {
        if (!track.info?.title) return null;
        
        const query = track.info.title;
        return this.makeRequest("GET", `/${this.version}/lyrics/search?query=${encodeURIComponent(query)}&source=genius`);
    }

    _isErrorResponse(response) {
        return response && (
            (response.status === 404 && response.error === 'Not Found') ||
            (response.status === 500 && response.error === 'Internal Server Error')
        );
    }

    async subscribeLiveLyrics(guildId, skipTrackSource = false) {
        this.validateSessionId();
        try {
            const result = await this.makeRequest(
                "POST", 
                `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe?skipTrackSource=${skipTrackSource}`
            );
            return result === null;
        } catch (error) {
            this.aqua.emit("debug", `[Aqua/Lyrics] Subscribe failed: ${error.message}`);
            return false;
        }
    }

    async unsubscribeLiveLyrics(guildId) {
        this.validateSessionId();
        try {
            const result = await this.makeRequest(
                "DELETE", 
                `/${this.version}/sessions/${this.sessionId}/players/${guildId}/lyrics/subscribe`
            );
            return result === null;
        } catch (error) {
            this.aqua.emit("debug", `[Aqua/Lyrics] Unsubscribe failed: ${error.message}`);
            return false;
        }
    }

    destroy() {
        if (this.agent) {
            this.agent.destroy();
        }
    }
}

module.exports = Rest;
