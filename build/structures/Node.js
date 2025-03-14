"use strict";
const WebSocket = require('ws');
const Rest = require("./Rest");

class Node {
    static BACKOFF_MULTIPLIER = 1.5;
    static MAX_BACKOFF = 60000;
    static WS_OPEN = WebSocket.OPEN;

    constructor(aqua, connOptions, options = {}) {
        this.aqua = aqua;
        this.host = connOptions.host || "localhost";
        this.name = connOptions.name || this.host;
        this.port = connOptions.port || 2333;
        this.password = connOptions.password || "youshallnotpass";
        this.secure = !!connOptions.secure;
        this.sessionId = connOptions.sessionId || null;
        this.regions = connOptions.regions || [];
        
        this.wsUrl = `ws${this.secure ? "s" : ""}://${this.host}:${this.port}/v4/websocket`;
        this.rest = new Rest(aqua, this);
        this.resumeTimeout = options.resumeTimeout || 60;
        this.autoResume = !!options.autoResume;
        this.reconnectTimeout = options.reconnectTimeout || 2000;
        this.reconnectTries = options.reconnectTries || 3;
        this.infiniteReconnects = !!options.infiniteReconnects;
        
        this.connected = false;
        this.info = null;
        this.ws = null;
        this.reconnectAttempted = 0;
        this.reconnectTimeoutId = null;
        
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
            "Client-Name": `Aqua/${this.aqua.version}`
        };
        
        if (this.sessionId) {
            headers["Session-Id"] = this.sessionId;
        }
        
        return headers;
    }

    _onOpen() {
        this.connected = true;
        this.reconnectAttempted = 0;
        this.emitDebug(`Connected to ${this.wsUrl}`);

        this.rest.makeRequest("GET", "/v4/info")
            .then(info => {
                this.info = info;
                if (this.autoResume && this.sessionId) {
                    return this.resumePlayers();
                }
            })
            .catch(err => {
                this.info = null;
                if (!this.aqua.bypassChecks?.nodeFetchInfo) {
                    this.emitError(`Failed to fetch node info: ${err.message}`);
                }
            });
    }
    
    _onError(error) {
        this.aqua.emit("nodeError", this, error);
    }
    
    _onMessage(msg) {
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
                this._updateStats(payload);
                break;
            case "ready":
                this._handleReadyOp(payload);
                break;
            default:
                if (payload.guildId) {
                    const player = this.aqua.players.get(payload.guildId);
                    if (player) player.emit(op, payload);
                }
        }
    }
    
    _onClose(code, reason) {
        this.connected = false;
        
        this.aqua.emit("nodeDisconnect", this, { 
            code, 
            reason: reason?.toString() || "No reason provided" 
        });
        
        this.scheduleReconnect(code);
    }

    scheduleReconnect(code) {
        this.clearReconnectTimeout();
        
        if (code === 1000) {
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
        this.cleanupExistingConnection();
        
        this.ws = new WebSocket(this.wsUrl, {
            headers: this._constructHeaders(),
            perMessageDeflate: false,
        });
        
        this.ws.once("open", this._onOpen.bind(this));
        this.ws.once("error", this._onError.bind(this));
        this.ws.on("message", this._onMessage.bind(this));
        this.ws.once("close", this._onClose.bind(this));
    }

    cleanupExistingConnection() {
        if (this.ws) {
            this.ws.removeAllListeners();
            
            if (this.ws.readyState === Node.WS_OPEN) {
                try {
                    this.ws.close();
                } catch (err) {
                    this.emitDebug(`Error closing WebSocket: ${err.message}`);
                }
            }
            
            this.ws = null;
        }
    }
    
    destroy(clean = false) {
        this.clearReconnectTimeout();
        this.cleanupExistingConnection();

        if (clean) {
            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodes.delete(this.name);
            return;
        }

        if (this.connected) {
            for (const player of this.aqua.players.values()) {
                if (player.nodes === this) {
                    player.destroy();
                }
            }
        }

        this.connected = false;
        this.aqua.nodes.delete(this.name);
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
    }

    async getStats() {
        try {
            const newStats = await this.rest.getStats();
            Object.assign(this.stats, newStats);
            return this.stats;
        } catch (err) {
            this.emitError(`Failed to fetch node stats: ${err.message}`);
            return this.stats;
        }
    }

    _updateStats(payload) {
        if (!payload) return;

        this._updateBasicStats(payload);
        
        this._updateMemoryStats(payload.memory);
        
        this._updateCpuStats(payload.cpu);
        
        this._updateFrameStats(payload.frameStats);
    }
    
    _updateBasicStats(payload) {
        this.stats.players = payload.players || this.stats.players;
        this.stats.playingPlayers = payload.playingPlayers || this.stats.playingPlayers;
        this.stats.uptime = payload.uptime || this.stats.uptime;
        this.stats.ping = payload.ping || this.stats.ping;
    }
    
    _updateMemoryStats(memory = {}) {
        const allocated = memory.allocated || this.stats.memory.allocated;
        const free = memory.free || this.stats.memory.free;
        const used = memory.used || this.stats.memory.used;
        
        this.stats.memory.free = free;
        this.stats.memory.used = used;
        this.stats.memory.allocated = allocated;
        this.stats.memory.reservable = memory.reservable || this.stats.memory.reservable;
        
        if (allocated) {
            this.stats.memory.freePercentage = (free / allocated) * 100;
            this.stats.memory.usedPercentage = (used / allocated) * 100;
        }
    }
    
    _updateCpuStats(cpu = {}) {
        const cores = cpu.cores || this.stats.cpu.cores;
        
        this.stats.cpu.cores = cores;
        this.stats.cpu.systemLoad = cpu.systemLoad || this.stats.cpu.systemLoad;
        this.stats.cpu.lavalinkLoad = cpu.lavalinkLoad || this.stats.cpu.lavalinkLoad;
        
        if (cores) {
            this.stats.cpu.lavalinkLoadPercentage = (cpu.lavalinkLoad / cores) * 100;
        }
    }
    
    _updateFrameStats(frameStats = {}) {
        if (!frameStats) return;
        this.stats.frameStats.sent = frameStats.sent || this.stats.frameStats.sent;
        this.stats.frameStats.nulled = frameStats.nulled || this.stats.frameStats.nulled;
        this.stats.frameStats.deficit = frameStats.deficit || this.stats.frameStats.deficit;
    }

    _handleReadyOp(payload) {
        if (!payload.sessionId) {
            this.emitError("Ready payload missing sessionId");
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);
        this.aqua.emit("nodeConnect", this);
    }

    async resumePlayers() {
        try {
            await this.rest.makeRequest("PATCH", `/v4/sessions/${this.sessionId}`, {
                resuming: true,
                timeout: this.resumeTimeout
            });
            
            this.emitDebug(`Successfully resumed session ${this.sessionId}`);
        } catch (err) {
            this.emitError(`Failed to resume session: ${err.message}`);
        }
    }
    
    emitDebug(message) {
        if (this.aqua.listenerCount('debug') > 0) {
            this.aqua.emit("debug", this.name, message);
        }
    }
    
    emitError(error) {
        const errorObj = error instanceof Error ? error : new Error(error);
        
        console.error(`[Aqua] [${this.name}] Error:`, errorObj);
        
        if (this.aqua.listenerCount('error') > 0) {
            this.aqua.emit("error", this, errorObj);
        }
    }
}

module.exports = Node;
