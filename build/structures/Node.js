const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    #ws = null;
    #lastStatsRequest = 0;
    #reconnectAttempted = 0;
    #reconnectTimeoutId = null;

    constructor(aqua, connOptions, options = {}) {
        const {
            name,
            host = "localhost",
            port = 2333,
            password = "youshallnotpass",
            secure = false,
            sessionId = null,
            regions = []
        } = connOptions;

        this.aqua = aqua;
        this.name = name || host;
        this.host = host;
        this.port = port;
        this.password = password;
        this.secure = secure;
        this.sessionId = sessionId;
        this.regions = regions;
        this.wsUrl = new URL(`ws${secure ? "s" : ""}://${host}:${port}/v4/websocket`);
        this.rest = new Rest(aqua, this);
        this.resumeKey = options.resumeKey || null;
        this.resumeTimeout = options.resumeTimeout || 60;
        this.autoResume = options.autoResume || false;
        this.reconnectTimeout = options.reconnectTimeout || 2000;
        this.reconnectTries = options.reconnectTries || 3;
        this.infiniteReconnects = options.infiniteReconnects || false;
        this.connected = false;
        this.info = null;
        this.stats = this.#createStats();

        this._onOpen = this.#onOpen.bind(this);
        this._onError = this.#onError.bind(this);
        this._onMessage = this.#onMessage.bind(this);
        this._onClose = this.#onClose.bind(this);
    }

    #createStats() {
        return {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { free: 0, used: 0, allocated: 0, reservable: 0, freePercentage: 0, usedPercentage: 0 },
            cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0, lavalinkLoadPercentage: 0 },
            frameStats: { sent: 0, nulled: 0, deficit: 0 },
            ping: 0
        };
    }

    async connect() {
        this.#ws = new WebSocket(this.wsUrl.href, {
            headers: this.#constructHeaders(),
            perMessageDeflate: false,
            handshakeTimeout: 30000
        });

        this.#ws.once("open", this._onOpen);
        this.#ws.once("error", this._onError);
        this.#ws.on("message", this._onMessage);
        this.#ws.once("close", this._onClose);
        this.aqua.emit("debug", this.name, "Connecting...");
    }

    #constructHeaders() {
        return {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
            ...(this.sessionId && { "Session-Id": this.sessionId }),
            ...(this.resumeKey && { "Resume-Key": this.resumeKey })
        };
    }

    async #onOpen() {
        this.connected = true;
        this.#reconnectAttempted = 0;
        this.aqua.emit("debug", this.name, `Connected to ${this.wsUrl.href}`);
        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            if (this.autoResume) await this.resumePlayers();
        } catch (err) {
            this.info = null;
            if (!this.aqua.bypassChecks?.nodeFetchInfo) {
                this.aqua.emit("error", `Failed to fetch node info: ${err.message}`);
            }
        }
    }

    async getStats() {
        if (!this.connected) return this.stats;
        const now = Date.now();
        const STATS_COOLDOWN = 60000;
        if (now - this.#lastStatsRequest < STATS_COOLDOWN) return this.stats;
        try {
            const stats = await this.rest.makeRequest("GET", "/v4/stats");
            this.stats = { ...this.#createStats(), ...stats };
            this.#lastStatsRequest = now;
        } catch (err) {
            this.aqua.emit("debug", `Stats fetch error: ${err.message}`);
        }
        return this.stats;
    }

    #updateStats(payload) {
        if (!payload) return;
        this.stats = {
            ...this.stats,
            ...payload,
            memory: this.#updateMemoryStats(payload.memory),
            cpu: this.#updateCpuStats(payload.cpu),
            frameStats: this.#updateFrameStats(payload.frameStats)
        };
    }

    #updateMemoryStats(memory = {}) {
        const allocated = memory.allocated || 0;
        const free = memory.free || 0;
        const used = memory.used || 0;
        return {
            free,
            used,
            allocated,
            reservable: memory.reservable || 0,
            freePercentage: allocated ? (free / allocated) * 100 : 0,
            usedPercentage: allocated ? (used / allocated) * 100 : 0
        };
    }

    #updateCpuStats(cpu = {}) {
        const cores = cpu.cores || 0;
        return {
            cores,
            systemLoad: cpu.systemLoad || 0,
            lavalinkLoad: cpu.lavalinkLoad || 0,
            lavalinkLoadPercentage: cores ? (cpu.lavalinkLoad / cores) * 100 : 0
        };
    }

    #updateFrameStats(frameStats = {}) {
        if (!frameStats) return { sent: 0, nulled: 0, deficit: 0 };
        return {
            sent: frameStats.sent || 0,
            nulled: frameStats.nulled || 0,
            deficit: frameStats.deficit || 0
        };
    }

 #onMessage(msg) {
        let payload;
        try {
            payload = JSON.parse(msg);
        } catch {
            return;
        }

        const op = payload?.op;
        if (!op) return;

        // Use switch for better performance with multiple conditions
        switch (op) {
            case "stats":
                this.#updateStats(payload);
                break;
            case "ready":
                this.#handleReadyOp(payload);
                break;
            default:
                this.#handlePlayerOp(payload);
        }
    }

    #handleReadyOp(payload) {
        if (this.sessionId !== payload.sessionId) {
            this.sessionId = payload.sessionId;
            this.rest.setSessionId(payload.sessionId);
        }
        this.aqua.emit("nodeConnect", this);
    }

    #handlePlayerOp(payload) {
        const player = this.aqua.players.get(payload.guildId);
        if (player) player.emit(payload.op, payload);
    }

    #onError(error) {
        this.aqua.emit("nodeError", this, error);
    }

    #onClose(code, reason) {
        this.connected = false;
        this.aqua.emit("nodeDisconnect", this, { code, reason });
        this.#reconnect();
    }

    #reconnect() {
        if (this.infiniteReconnects) {
            this.aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, trying non-stop...");
            setTimeout(() => this.connect(), 10000);
            return;
        }

        if (this.#reconnectAttempted >= this.reconnectTries) {
            this.aqua.emit("nodeError", this, 
                new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            this.destroy(true);
            return;
        }

        clearTimeout(this.#reconnectTimeoutId);
        
        const jitter = Math.random() * 10000;
        const backoffTime = Math.min(
            this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, this.#reconnectAttempted) + jitter,
            Node.MAX_BACKOFF
        );

        this.#reconnectTimeoutId = setTimeout(() => {
            this.#reconnectAttempted++;
            this.aqua.emit("nodeReconnect", {
                nodeName: this.name,
                attempt: this.#reconnectAttempted,
                backoffTime
            });
            this.connect();
        }, backoffTime);
    }

    get penalties() {
        if (!this.connected) return Number.MAX_SAFE_INTEGER;
        
        let penalties = this.stats.players;
        
        const { cpu, frameStats } = this.stats;
        if (cpu?.systemLoad) {
            penalties += Math.round(Math.pow(1.05, 100 * cpu.systemLoad) * 10 - 10);
        }
        if (frameStats) {
            penalties += frameStats.deficit + (frameStats.nulled * 2);
        }
        
        return penalties;
    }

    destroy(clean = false) {
        if (clean) {
            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodes.delete(this.name);
            return;
        }
        if (this.connected) {
            for (const player of this.aqua.players.values()) {
                if (player.node === this) {
                    player.destroy();
                }
            }
        }
        this.connected = false;
        this.aqua.nodeMap.delete(this.name);
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
        this.#lastStatsRequest = 0;
        this.stats = this.#createStats();
    }
}

module.exports = { Node };
