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
        
        this._boundOnOpen = this._onOpen.bind(this);
        this._boundOnError = this._onError.bind(this);
        this._boundOnMessage = this._onMessage.bind(this);
        this._boundOnClose = this._onClose.bind(this);
        
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

    _updateHeaders() {
        this._headers = this._constructHeaders();
    }

    async _onOpen() {
        this.connected = true;
        this.reconnectAttempted = 0;
        this.emitDebug(`Connected to ${this.wsUrl}`);

        if (this.aqua.bypassChecks?.nodeFetchInfo) return;

        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            
            if (this.autoResume && this.sessionId) {
                await this.resumePlayers();
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
                break;
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
        
        if (code === Node.WS_CLOSE_NORMAL) {
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
        
        if (this.sessionId && !this._headers["Session-Id"]) {
            this._updateHeaders();
        }
        
        this.ws = new WebSocket(this.wsUrl, { 
            headers: this._headers, 
            perMessageDeflate: false
        });
        
        this.ws.once("open", this._boundOnOpen);
        this.ws.once("error", this._boundOnError);
        this.ws.on("message", this._boundOnMessage);
        this.ws.once("close", this._boundOnClose);
    }

    cleanupExistingConnection() {
        if (!this.ws) return;
        
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
    
    destroy(clean = false) {
        this.clearReconnectTimeout();
        
        this.cleanupExistingConnection();

        if (clean) {
            this.aqua.emit("nodeDestroy", this);
            this.aqua.destroyNode(this.name);
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

        this.stats.players = payload.players;
        this.stats.playingPlayers = payload.playingPlayers;
        this.stats.uptime = payload.uptime;
        this.stats.ping = payload.ping;
        
        this._updateMemoryStats(payload.memory || {});
        this._updateCpuStats(payload.cpu || {});
        this._updateFrameStats(payload.frameStats || {});
    }
    
    _updateMemoryStats(memory) {
        const memoryStats = this.stats.memory;
        
        memoryStats.free = memory.free;
        memoryStats.used = memory.used;
        memoryStats.allocated = memory.allocated;
        memoryStats.reservable = memory.reservable;
        
        memoryStats.freePercentage = (memoryStats.free / memoryStats.allocated) * 100;
        memoryStats.usedPercentage = (memoryStats.used / memoryStats.allocated) * 100;
    }
    
    _updateCpuStats(cpu) {
        const cpuStats = this.stats.cpu;
        
        cpuStats.cores = cpu.cores;
        cpuStats.systemLoad = cpu.systemLoad;
        cpuStats.lavalinkLoad = cpu.lavalinkLoad;
        
        cpuStats.lavalinkLoadPercentage = (cpuStats.lavalinkLoad / cpuStats.cores) * 100;
    }
    
    _updateFrameStats(frameStats) {
        const stats = this.stats.frameStats;

        if (!frameStats) return;
        
        stats.sent = frameStats.sent;
        stats.nulled = frameStats.nulled;
        stats.deficit = frameStats.deficit;
    }

    _handleReadyOp(payload) {
        if (!payload.sessionId) {
            this.emitError("Ready payload missing sessionId");
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);
        this._updateHeaders();
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
