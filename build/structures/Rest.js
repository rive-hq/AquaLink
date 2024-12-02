const { fetch: undiciFetch } = require("undici");
const nodeUtil = require("node:util");

class Rest {
    constructor(aqua, options) {
        this.aqua = aqua;
        this.url = `http${options.secure ? "s" : ""}://${options.host}:${options.port}`;
        this.sessionId = options.sessionId;
        this.password = options.password;
        this.version = options.restVersion;
        this.calls = 0;
        this.queue = []; 
        this.maxQueueSize = options.maxQueueSize || 100; 
        this.maxConcurrentRequests = options.maxConcurrentRequests || 5; 
        this.activeRequests = 0; 
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null, includeHeaders = false) {
        const headers = {
            "Content-Type": "application/json",
            Authorization: this.password,
        };
        const requestOptions = {
            method,
            headers,
            body: body ? JSON.stringify(body) : null,
        };
        try {
            const response = await undiciFetch(`${this.url}${endpoint}`, requestOptions);
            this.calls++;
            const data = await this.parseResponse(response);
            this.aqua.emit("apiResponse", endpoint, response);
            this.aqua.emit(
                "debug",
                `[Rest] ${method} ${endpoint} ${body ? `body: ${JSON.stringify(body)}` : ""} -> Status Code: ${response.status} Response: ${nodeUtil.inspect(data)}`
            );
            return includeHeaders ? { data, headers: response.headers } : data;
        } catch (error) {
            throw new Error(`Network error during request: ${method} ${this.url}${endpoint}`, { cause: error });
        }
    }

    async getPlayers() {
        return this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players`);
    }

    async updatePlayer(options) {
        const requestBody = { ...options.data };
        if ((requestBody.track && requestBody.track.encoded && requestBody.track.identifier) ||
            (requestBody.encodedTrack && requestBody.identifier)) {
            throw new Error(`Cannot provide both 'encoded' and 'identifier' for track in Update Player Endpoint`);
        }
        if (this.version === "v3" && options.data?.track) {
            const { track } = requestBody;
            delete requestBody.track;
            Object.assign(requestBody, track.encoded ? { encodedTrack: track.encoded } : { identifier: track.identifier });
        }
        return this.makeRequest("PATCH", `/${this.version}/sessions/${this.sessionId}/players/${options.guildId}?noReplace=false`, requestBody);
    }

    async destroyPlayer(guildId) {
        return this.makeRequest("DELETE", `/${this.version}/sessions/${this.sessionId}/players/${guildId}`);
    }

    async getTracks(identifier) {
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);
    }

    async decodeTrack(track, node) {
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`);
    }

    async decodeTracks(tracks) {
        return this.makeRequest("POST", `/${this.version}/decodetracks`, tracks);
    }

    async getStats() {
        if (this.version === "v3") {
            return this.makeRequest("GET", `/${this.version}/stats`);
        }
        return this.makeRequest("GET", `/${this.version}/stats/all`);
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

    async parseResponse(response) {
        if (response.status === 204) {
            return null;
        }
        try {
            const contentType = response.headers.get("Content-Type");
            return await response[contentType.includes("text/plain") ? "text" : "json"]();
        } catch (error) {
            this.aqua.emit("debug", `[Rest - Error] Failed to process response from ${response.url}: ${error}`);
            return null;
        }
    }

    /**
     * Adds a request to the queue and processes it.
     * @param {function} requestFunction - The request function to execute.
     */
    async queueRequest(requestFunction) {
        if (this.queue.length >= this.maxQueueSize) {
            this.aqua.emit("debug", "[Rest] Queue is full, discarding oldest request.");
            this.queue.shift(); 
        }
        this.queue.push(requestFunction);
        this.processQueue();
    }

    /**
     * Processes the queue of requests with concurrency control.
     */
    async processQueue() {
        while (this.activeRequests < this.maxConcurrentRequests && this.queue.length > 0) {
            const requestFunction = this.queue.shift(); 
            this.activeRequests++; 
            try {
                await requestFunction(); 
            } catch (error) {
                this.aqua.emit("error", error);
            } finally {
                this.activeRequests--; 
                this.processQueue();
            }
        }
    }

    /**
     * Cleans up resources related to the queue.
     */
    cleanupQueue() {
        this.queue = []; 
    }
}

module.exports = { Rest };
