"use strict";
const WebSocket = require("ws");
const Rest = require("./Rest");

class Node {
    #ws = null;
    #reconnectAttempted = 0;
    #reconnectTimeoutId = null;
    static BACKOFF_MULTIPLIER = 1.5;
    static MAX_BACKOFF = 60000;

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
        this.defaultStats = this.#createDefaultStats();
        this.stats = { ...this.defaultStats };
        this._onOpen = this.#onOpen.bind(this);
        this._onError = this.#onError.bind(this);
        this._onMessage = this.#onMessage.bind(this);
        this._onClose = this.#onClose.bind(this);
    }

    #createDefaultStats() {
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
        });
        this.#ws.once('open', this._onOpen);
        this.#ws.once('error', this._onError);
        this.#ws.on('message', this._onMessage);
        this.#ws.once('close', this._onClose);
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
        if (this.autoResume) {
            try {
                this.info = await this.rest.makeRequest("GET", "/v4/info");
                await this.resumePlayers();
            } catch (err) {
                this.info = null;
                if (!this.aqua.bypassChecks?.nodeFetchInfo) {
                    this.aqua.emit("error", `Failed to fetch node info: ${err.message}`);
                }
            }
        }
    }

    async getStats() {
        const stats = await this.rest.makeRequest("GET", "/v4/stats");
        this.stats = { ...this.defaultStats, ...stats };
        return this.stats;
    }

    async #onMessage(msg) {
        let payload;
        try {
            payload = JSON.parse(msg);
        } catch {
            return;
        }
        const op = payload?.op;
        if (!op) return;
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

    #updateStats(payload) {
        if (!payload) return;

        // Directly modify the stats object
        Object.assign(this.stats, payload);
        this.stats.memory = this.#updateMemoryStats(payload.memory);
        this.stats.cpu = this.#updateCpuStats(payload.cpu);
        this.stats.frameStats = this.#updateFrameStats(payload.frameStats);
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

    async #reconnect() {
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
        const controlledJitterFraction = 0.2;
        const jitter = this.reconnectTimeout * controlledJitterFraction * Math.random();
        const backoffTime = Math.min(
            this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, this.#reconnectAttempted) + jitter,
            Node.MAX_BACKOFF
        );
        this.#reconnectTimeoutId = setTimeout(async () => {
            this.#reconnectAttempted++;
            this.aqua.emit("nodeReconnect", {
                nodeName: this.name,
                attempt: this.#reconnectAttempted,
                backoffTime
            });
            await this.connect();
        }, backoffTime);
    }

    destroy(clean = false) {
        clearTimeout(this.#reconnectTimeoutId);
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
    }
}

module.exports = Node;
