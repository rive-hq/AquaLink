const { request } = require("undici");

class Rest {
    #requestCache = new Map();
    #cacheTTL = 5000; // 5 seconds cache TTL
    #pendingRequests = new Map();

    constructor(aqua, options) {
        this.aqua = aqua;
        this.url = new URL(`http${options.secure ? "s" : ""}://${options.host}:${options.port}`);
        this.sessionId = options.sessionId;
        this.password = options.password;
        this.version = options.restVersion || "v4";
        this.calls = 0;
        this.headers = Object.freeze({
            "Content-Type": "application/json",
            "Authorization": this.password,
        });
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async #dedupeRequest(key, requestFn) {
        // Return cached response if available and fresh
        const cached = this.#requestCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.#cacheTTL) {
            return cached.data;
        }

        // Dedupe in-flight requests
        const pending = this.#pendingRequests.get(key);
        if (pending) return pending;

        const promise = requestFn().finally(() => {
            this.#pendingRequests.delete(key);
        });
        this.#pendingRequests.set(key, promise);

        return promise;
    }

    async makeRequest(method, endpoint, body = null, includeHeaders = false) {
        const url = new URL(endpoint, this.url);
        const cacheKey = `${method}:${url.toString()}:${body ? JSON.stringify(body) : ''}`;

        return this.#dedupeRequest(cacheKey, async () => {
            const options = {
                method,
                headers: this.headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(10000), // 10s timeout
            };

            let response;
            try {
                response = await request(url, options);
                this.calls++;

                const data = await response.body.json();
                const result = includeHeaders ? { 
                    data, 
                    headers: Object.freeze({ ...response.headers })
                } : data;

                // Cache successful GET requests
                if (method === 'GET' && response.statusCode === 200) {
                    this.#requestCache.set(cacheKey, {
                        data: result,
                        timestamp: Date.now()
                    });
                }

                this.aqua.emit("apiResponse", endpoint, {
                    status: response.statusCode,
                    headers: response.headers
                });

                return result;

            } catch (error) {
                this.aqua.emit("apiError", endpoint, error);
                if (error.name === 'AbortError') {
                    throw new Error(`Request timeout for ${endpoint}`);
                }
                throw new Error(`Failed to make request to ${endpoint}: ${error.message}`);

            } finally {
                if (response?.body) {
                    try {
                        await response.body.dump();
                    } catch {}
                }
            }
        });
    }

    // Batch multiple track updates into a single request
    async updatePlayer(options) {
        const { guildId, data } = options;
        
        if (!guildId || !data) {
            throw new Error("Missing required parameters for player update");
        }

        const requestBody = { ...data };

        // Validate track data
        if (requestBody.track) {
            const hasEncodedAndIdentifier = 
                (requestBody.track.encoded && requestBody.track.identifier) ||
                (requestBody.encodedTrack && requestBody.identifier);

            if (hasEncodedAndIdentifier) {
                throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
            }

            // Handle v3 compatibility
            if (this.version === "v3") {
                const { track } = requestBody;
                delete requestBody.track;
                requestBody[track.encoded ? 'encodedTrack' : 'identifier'] = 
                    track.encoded || track.identifier;
            }
        }

        const endpoint = `/${this.version}/sessions/${this.sessionId}/players/${guildId}?noReplace=false`;
        return this.makeRequest("PATCH", endpoint, requestBody);
    }

    // Add request methods with memoization for frequently accessed data
    getPlayers = this.#memoize(() => 
        this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players`)
    );

    getStats = this.#memoize(() => 
        this.makeRequest("GET", `/${this.version}/stats${this.version !== "v3" ? "/all" : ""}`)
    );

    getInfo = this.#memoize(() => 
        this.makeRequest("GET", `/${this.version}/info`)
    );

    // Helper method for memoization
    #memoize(fn, ttl = 5000) {
        let lastCall = 0;
        let cachedResult = null;

        return async () => {
            const now = Date.now();
            if (!cachedResult || now - lastCall > ttl) {
                cachedResult = await fn();
                lastCall = now;
            }
            return cachedResult;
        };
    }

    // Cleanup method to prevent memory leaks
    cleanup() {
        this.#requestCache.clear();
        this.#pendingRequests.clear();
    }
}

module.exports = { Rest };
