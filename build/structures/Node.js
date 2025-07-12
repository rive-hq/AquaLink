"use strict";
const WebSocket = require('ws');
const Rest = require("./Rest");

class Node {
    static BACKOFF_MULTIPLIER = 1.5;
    static MAX_BACKOFF = 60000;
    static WS_OPEN = WebSocket.OPEN;
    static WS_CLOSE_NORMAL = 1000;

    constructor(aqua, connOptions, options = {}) {
        this.aqua = aqua;

        const {
            host = "localhost",
            name = host,
            port = 2333,
            password = "youshallnotpass",
            secure = false,
            sessionId = null,
            regions = []
        } = connOptions;

        this.host = host;
        this.name = name;
        this.port = port;
        this.password = password;
        this.secure = !!secure;
        this.sessionId = sessionId;
        this.regions = regions;

        this.wsUrl = `ws${this.secure ? "s" : ""}://${this.host}:${this.port}/v4/websocket`;
        this.rest = new Rest(aqua, this);

        const {
            resumeTimeout = 60,
            autoResume = false,
            reconnectTimeout = 2000,
            reconnectTries = 3,
            infiniteReconnects = false
        } = options;

        this.resumeTimeout = resumeTimeout;
        this.autoResume = autoResume;
        this.reconnectTimeout = reconnectTimeout;
        this.reconnectTries = reconnectTries;
        this.infiniteReconnects = infiniteReconnects;

        this.connected = false;
        this.info = null;
        this.ws = null;
        this.reconnectAttempted = 0;
        this.reconnectTimeoutId = null;
        this.isDestroyed = false;
        this.lastHealthCheck = Date.now();

        this._headers = this._constructHeaders();
        this.initializeStats();
    }

    initializeStats() {
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { free: 0, used: 0, allocated: 0, reservable: 0, freePercentage: 0, usedPercentage: 0 },
            cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0, lavalinkLoadPercentage: 0 },
            frameStats: { sent: 0, nulled: 0, deficit: 0 },
            ping: 0
        };
    }

    _constructHeaders() {
        const headers = {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version} (https://github.com/ToddyTheNoobDud/AquaLink)`
        };

        if (this.sessionId) {
            headers["Session-Id"] = this.sessionId;
        }

        return headers;
    }

    async _onOpen() {
        this.connected = true;
        this.reconnectAttempted = 0;
        this.lastHealthCheck = Date.now();
        this.aqua.emit("debug", this.name, "WebSocket connection established");

        if (this.aqua.bypassChecks?.nodeFetchInfo) return;

        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            this.aqua.emit("nodeConnected", this);

            if (this.autoResume && this.sessionId) {
                await this.aqua.loadPlayers();
            }
        } catch (err) {
            this.info = null;
            this.emitError(`Failed to fetch node info: ${err.message}`);
        }
    }

    _onError(error) {
        this.aqua.emit("nodeError", this, error);
    }

    _onMessage(msg) {
        let payload;
        try {
            payload = JSON.parse(msg);
        } catch {
            this.aqua.emit("debug", this.name, `Received invalid JSON: ${msg}`);
            return;
        }

        const op = payload?.op;
        if (!op) return;

        this.lastHealthCheck = Date.now();

        if (op === "stats") {
            this._updateStats(payload);
            return;
        }
        if (op === "ready") {
            this._handleReadyOp(payload);
            return;
        }

        if (op.startsWith("Lyrics")) {
            const player = payload.guildId ? this.aqua.players.get(payload.guildId) : null;
            const track = payload.track || null;
            this.aqua.emit(op, player, track, payload);
            return;
        }

        if (payload.guildId) {
            const player = this.aqua.players.get(payload.guildId);
            if (player) player.emit(op, payload);
        }
    }

    _onClose(code, reason) {
        this.connected = false;
        const reasonStr = reason?.toString() || "No reason provided";

        this.aqua.emit("nodeDisconnect", this, { code, reason: reasonStr });

        this.aqua.handleNodeFailover(this);

        this.scheduleReconnect(code);
    }

    scheduleReconnect(code) {
        this.clearReconnectTimeout();

        if (code === Node.WS_CLOSE_NORMAL || this.isDestroyed) {
            this.aqua.emit("debug", this.name, "WebSocket closed normally, not reconnecting");
            return;
        }

        if (this.infiniteReconnects) {
            this.aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, trying again in 10 seconds");
            this.reconnectTimeoutId = setTimeout(() => this.connect(), 10000);
            return;
        }

        if (this.reconnectAttempted >= this.reconnectTries) {
            this.emitError(new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            this.destroy(true);
            return;
        }

        const backoffTime = this.calculateBackoff();
        this.reconnectAttempted++;

        this.aqua.emit("nodeReconnect", this, {
            attempt: this.reconnectAttempted,
            backoffTime
        });

        this.reconnectTimeoutId = setTimeout(() => this.connect(), backoffTime);
    }

    calculateBackoff() {
        const baseBackoff = this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, this.reconnectAttempted);
        const jitter = Math.random() * Math.min(2000, baseBackoff * 0.2);
        return Math.min(baseBackoff + jitter, Node.MAX_BACKOFF);
    }

    clearReconnectTimeout() {
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
    }

    async connect() {
        if (this.isDestroyed) return;
        
        if (this.ws && this.ws.readyState === Node.WS_OPEN) {
            this.aqua.emit("debug", this.name, "WebSocket already connected");
            return;
        }

        this.cleanupExistingConnection();

        this.ws = new WebSocket(this.wsUrl, {
            headers: this._headers,
            perMessageDeflate: false
        });

        this.ws.once("open", this._onOpen.bind(this));
        this.ws.once("error", this._onError.bind(this));
        this.ws.on("message", this._onMessage.bind(this));
        this.ws.once("close", this._onClose.bind(this));
    }

    cleanupExistingConnection() {
        if (!this.ws) return;

        this.ws.removeAllListeners();

        if (this.ws.readyState === Node.WS_OPEN) {
            try {
                this.ws.close();
            } catch (err) {
                this.emitError(`Failed to close WebSocket: ${err.message}`);
            }
        }

        this.ws = null;
    }

    destroy(clean = false) {
        this.isDestroyed = true;
        this.clearReconnectTimeout();
        this.cleanupExistingConnection();

        if (!clean) {
            this.aqua.handleNodeFailover(this);
        }

        this.connected = false;
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
    }

    async getStats() {
        if (this.connected && this.stats) {
            return this.stats;
        }

        try {
            const newStats = await this.rest.getStats();
            if (newStats && this.stats) {
                this.stats.players = newStats.players ?? this.stats.players;
                this.stats.playingPlayers = newStats.playingPlayers ?? this.stats.playingPlayers;
                this.stats.uptime = newStats.uptime ?? this.stats.uptime;
                this.stats.ping = newStats.ping ?? this.stats.ping;
                
                if (newStats.memory) {
                    Object.assign(this.stats.memory, newStats.memory);
                    this._calculateMemoryPercentages();
                }
                
                if (newStats.cpu) {
                    Object.assign(this.stats.cpu, newStats.cpu);
                    this._calculateCpuPercentages();
                }
                
                if (newStats.frameStats) {
                    Object.assign(this.stats.frameStats, newStats.frameStats);
                }
            }
            return this.stats;
        } catch (err) {
            this.emitError(`Failed to fetch node stats: ${err.message}`);
            return this.stats;
        }
    }

    _updateStats(payload) {
        if (!payload) return;

        this.stats.players = payload.players;
        this.stats.playingPlayers = payload.playingPlayers;
        this.stats.uptime = payload.uptime;
        this.stats.ping = payload.ping;

        if (payload.memory) {
            Object.assign(this.stats.memory, payload.memory);
            this._calculateMemoryPercentages();
        }

        if (payload.cpu) {
            Object.assign(this.stats.cpu, payload.cpu);
            this._calculateCpuPercentages();
        }

        if (payload.frameStats) {
            Object.assign(this.stats.frameStats, payload.frameStats);
        }
    }

    _calculateMemoryPercentages() {
        const { memory } = this.stats;
        if (memory.allocated > 0) {
            memory.freePercentage = (memory.free / memory.allocated) * 100;
            memory.usedPercentage = (memory.used / memory.allocated) * 100;
        }
    }

    _calculateCpuPercentages() {
        const { cpu } = this.stats;
        if (cpu.cores > 0) {
            cpu.lavalinkLoadPercentage = (cpu.lavalinkLoad / cpu.cores) * 100;
        }
    }

    _handleReadyOp(payload) {
        if (!payload.sessionId) {
            this.emitError("Ready payload missing sessionId");
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);
        this._headers = this._constructHeaders();
        this.aqua.emit("nodeConnect", this);
    }

    async resumePlayers() {
        try {
            await this.aqua.loadPlayers();
            this.aqua.emit("debug", this.name, "Session resumed successfully");
        } catch (err) {
            this.emitError(`Failed to resume session: ${err.message}`);
        }
    }
    emitError(error) {
        const errorObj = error instanceof Error ? error : new Error(error);
        console.error(`[Aqua] [${this.name}] Error:`, errorObj);
        this.aqua.emit("error", this, errorObj);
    }
}

module.exports = Node;
