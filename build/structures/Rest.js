const { request } = require("undici");

class Rest {
    constructor(aqua, options) {
        this.aqua = aqua;
        this.url = `http${options.secure ? "s" : ""}://${options.host}:${options.port}`;
        this.sessionId = options.sessionId;
        this.password = options.password;
        this.version = options.restVersion || "v4";
        this.calls = 0;
        this.headers = Object.freeze({
            "Content-Type": "application/json",
            Authorization: this.password,
        });
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    getFullUrl(endpoint) {
        return `${this.url}${endpoint}`;
    }

    async makeRequest(method, endpoint, body = null, includeHeaders = false) {
        let response;
        const options = {
            method,
            headers: this.headers,
            ...(body && { body: JSON.stringify(body) }), 
        };

        try {
            response = await request(this.getFullUrl(endpoint), options);
            this.calls++;
            const data = await response.body.json();
            this.aqua.emit("apiResponse", endpoint, {
                status: response.statusCode,
                headers: response.headers,
            });
            return includeHeaders ? { data, headers: response.headers } : data;
        } catch (error) {
            this.aqua.emit("apiError", endpoint, error);
            throw new Error(`Failed to make request to ${endpoint}: ${error.message}`);
        } finally {
            if (response?.body) {
                try {
                    await response.body.dump();
                } catch (e) {
                    console.error("Error dumping response body:", e); 
                }
            }
        }
    }

     updatePlayer(options) {
        const requestBody = { ...options.data };
        if ((requestBody.track?.encoded && requestBody.track?.identifier) ||
            (requestBody.encodedTrack && requestBody.identifier)) {
            throw new Error("Cannot provide both 'encoded' and 'identifier' for track");
        }
        if (this.version === "v3" && requestBody.track) {
            const { track } = requestBody;
            delete requestBody.track;
            requestBody[track.encoded ? 'encodedTrack' : 'identifier'] = track.encoded || track.identifier;
        }
        return this.makeRequest(
            "PATCH",
            `/${this.version}/sessions/${this.sessionId}/players/${options.guildId}?noReplace=false`,
            requestBody
        );
    }

    getPlayers() {
        return this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players`);
    }

    destroyPlayer(guildId) {
        return this.makeRequest("DELETE", `/${this.version}/sessions/${this.sessionId}/players/${guildId}`);
    }

    getTracks(identifier) {
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);
    }

    decodeTrack(track) {
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`);
    }

    decodeTracks(tracks) {
        return this.makeRequest("POST", `/${this.version}/decodetracks`, tracks);
    }

    getStats() {
        return this.makeRequest("GET", `/${this.version}/stats${this.version !== "v3" ? "/all" : ""}`);
    }

    getInfo() {
        return this.makeRequest("GET", `/${this.version}/info`);
    }

    getRoutePlannerStatus() {
        return this.makeRequest("GET", `/${this.version}/routeplanner/status`);
    }

    getRoutePlannerAddress(address) {
        return this.makeRequest("POST", `/${this.version}/routeplanner/free/address`, { address });
    }
}

module.exports = { Rest };
