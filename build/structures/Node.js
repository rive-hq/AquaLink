"use strict";
const WebSocket = require('ws');
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
        this.resumeTimeout = options.resumeTimeout || 60;
        this.autoResume = options.autoResume || false;
        this.reconnectTimeout = options.reconnectTimeout || 2000;
        this.reconnectTries = options.reconnectTries || 3;
        this.infiniteReconnects = options.infiniteReconnects || false;
        this.connected = false;
        this.info = null;
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { free: 0, used: 0, allocated: 0, reservable: 0, freePercentage: 0, usedPercentage: 0 },
            cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0, lavalinkLoadPercentage: 0 },
            frameStats: { sent: 0, nulled: 0, deficit: 0 },
            ping: 0
        };
        this._onOpen = this.#onOpen.bind(this);
        this._onError = this.#onError.bind(this);
        this._onMessage = this.#onMessage.bind(this);
        this._onClose = this.#onClose.bind(this);
    }


    async connect() {
        this.#ws = new WebSocket(this.wsUrl.href, {
            headers: this.#constructHeaders(),
            perMessageDeflate: false,
        });
        this.#ws.once("open", this._onOpen);
        this.#ws.once("error", this._onError);
        this.#ws.on("message", this._onMessage);
        this.#ws.once("close", this._onClose);
    }

    #constructHeaders() {
        const headers = {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
        };
        if (this.sessionId) headers["Session-Id"] = this.sessionId;
        return headers;
    }

    async #onOpen() {
        this.connected = true;
        this.#reconnectAttempted = 0;
        this.aqua.emit("debug", this.name, `Connected to ${this.wsUrl.href}`);

        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            if (this.autoResume && this.sessionId) {
                await this.resumePlayers();
            }
        } catch (err) {
            this.info = null;
            if (!this.aqua.bypassChecks?.nodeFetchInfo) {
                this.aqua.emit("error", this, `Failed to fetch node info: ${err.message}`);
            }
        }
    }

    async getStats() {
        const newStats = await this.rest.getStats();
        Object.assign(this.stats, newStats);
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

    async resumePlayers() {
        try {
            await this.rest.makeRequest("PATCH", `/v4/sessions/${this.sessionId}`, {
                resuming: true,
                timeout: this.resumeTimeout
            });
            this.aqua.emit("debug", this.name, `Successfully resumed session ${this.sessionId}`);
        } catch (err) {
            this.aqua.emit("error", this, `Failed to resume session: ${err.message}`);
        }
    }

    #updateStats(payload) {
        if (!payload) return;

        this.stats.players = payload.players || this.stats.players;
        this.stats.playingPlayers = payload.playingPlayers || this.stats.playingPlayers;
        this.stats.uptime = payload.uptime || this.stats.uptime;
        this.stats.ping = payload.ping || this.stats.ping;

        const memory = payload.memory || {};
        const allocated = memory.allocated || this.stats.memory.allocated;
        const free = memory.free || this.stats.memory.free;
        const used = memory.used || this.stats.memory.used;

        this.stats.memory = {
            free,
            used,
            allocated,
            reservable: memory.reservable || this.stats.memory.reservable,
            freePercentage: allocated ? (free / allocated) * 100 : this.stats.memory.freePercentage,
            usedPercentage: allocated ? (used / allocated) * 100 : this.stats.memory.usedPercentage
        };

        const cpu = payload.cpu || {};
        const cores = cpu.cores || this.stats.cpu.cores;

        this.stats.cpu = {
            cores,
            systemLoad: cpu.systemLoad || this.stats.cpu.systemLoad,
            lavalinkLoad: cpu.lavalinkLoad || this.stats.cpu.lavalinkLoad,
            lavalinkLoadPercentage: cores ? (cpu.lavalinkLoad / cores) * 100 : this.stats.cpu.lavalinkLoadPercentage
        };

        const frameStats = payload.frameStats || {};
        this.stats.frameStats = {
            sent: frameStats.sent || this.stats.frameStats.sent,
            nulled: frameStats.nulled || this.stats.frameStats.nulled,
            deficit: frameStats.deficit || this.stats.frameStats.deficit
        };
    }

    #handleReadyOp(payload) {
        if (!payload.sessionId) {
            this.aqua.emit("error", this, "Ready payload missing sessionId");
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);

        this.aqua.emit("nodeConnect", this);
    }

    #handlePlayerOp(payload) {
        if (!payload.guildId) return;
        const player = this.aqua.players.get(payload.guildId);
        if (player) player.emit(payload.op, payload);
    }

    #onError(error) {
        this.aqua.emit("nodeError", this, error);
    }

    #onClose(code, reason) {
        this.connected = false;
        this.aqua.emit("nodeDisconnect", this, { code, reason: reason?.toString() || "No reason provided" });
        this.#reconnect();
    }

    #reconnect() {
        clearTimeout(this.#reconnectTimeoutId);
        
        if (this.infiniteReconnects) {
            this.aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, trying again in 10 seconds");
            this.#reconnectTimeoutId = setTimeout(() => this.connect(), 10000);
            return;
        }

        if (this.#reconnectAttempted >= this.reconnectTries) {
            this.aqua.emit("nodeError", this, 
                new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            this.destroy(true);
            return;
        }

        const baseBackoff = this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, this.#reconnectAttempted);
        const jitter = Math.random() * Math.min(2000, baseBackoff * 0.2);
        const backoffTime = Math.min(baseBackoff + jitter, Node.MAX_BACKOFF);

        this.#reconnectAttempted++;
        this.aqua.emit("nodeReconnect", this, {
            attempt: this.#reconnectAttempted,
            backoffTime
        });
        
        this.#reconnectTimeoutId = setTimeout(() => {
            this.connect();
        }, backoffTime);
    }

    destroy(clean = false) {
        clearTimeout(this.#reconnectTimeoutId);

        if (this.#ws) {
            this.#ws.removeAllListeners();
            if (this.#ws.readyState === WebSocket.OPEN) {
                this.#ws.close();
            }
            this.#ws = null;
        }

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
        this.aqua.nodes.delete(this.name);
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
    }
}

module.exports = Node;
