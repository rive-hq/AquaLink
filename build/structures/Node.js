"use strict";
const WebSocket = require('ws');
const Rest = require("./Rest");

class Node {
    static BACKOFF_MULTIPLIER = 1.5;
    static MAX_BACKOFF = 60000;
    static WS_OPEN = WebSocket.OPEN;

    constructor(aqua, connOptions, options = {}) {
        const host = connOptions.host || "localhost";
        
        this.aqua = aqua;
        this.name = connOptions.name || host;
        this.host = host;
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
        
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { free: 0, used: 0, allocated: 0, reservable: 0, freePercentage: 0, usedPercentage: 0 },
            cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0, lavalinkLoadPercentage: 0 },
            frameStats: { sent: 0, nulled: 0, deficit: 0 },
            ping: 0
        };
        
        let ws = null;
        let reconnectAttempted = 0;
        let reconnectTimeoutId = null;
        
        this._onOpen = () => {
            this.connected = true;
            reconnectAttempted = 0;
            if (aqua.listenerCount('debug') > 0) {
                aqua.emit("debug", this.name, `Connected to ${this.wsUrl}`);
            }

            this.rest.makeRequest("GET", "/v4/info")
                .then(info => {
                    this.info = info;
                    if (this.autoResume && this.sessionId) {
                        return this.resumePlayers();
                    }
                })
                .catch(err => {
                    this.info = null;
                    if (!aqua.bypassChecks?.nodeFetchInfo && aqua.listenerCount('error') > 0) {
                        aqua.emit("error", this, `Failed to fetch node info: ${err.message}`);
                    }
                });
        };
        
         this._onError = (error) => {
            if (aqua.listenerCount('nodeError') > 0) {
                aqua.emit("nodeError", this, error);
            }
        };
        
        this._onMessage = (msg) => {
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
                        const player = aqua.players.get(payload.guildId);
                        if (player) player.emit(op, payload);
                    }
            }
        };
        
        this._onClose = (code, reason) => {
            this.connected = false;
            
            if (aqua.listenerCount('nodeDisconnect') > 0) {
                aqua.emit("nodeDisconnect", this, { 
                    code, 
                    reason: reason?.toString() || "No reason provided" 
                });
            }
            
            clearTimeout(reconnectTimeoutId);
            
            if (this.infiniteReconnects) {
                if (aqua.listenerCount('nodeReconnect') > 0) {
                    aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, trying again in 10 seconds");
                }
                reconnectTimeoutId = setTimeout(() => this.connect(), 10000);
                return;
            }

            if (reconnectAttempted >= this.reconnectTries) {
                if (aqua.listenerCount('nodeError') > 0) {
                    aqua.emit("nodeError", this, 
                        new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
                }
                this.destroy(true);
                return;
            }

            const baseBackoff = this.reconnectTimeout * Math.pow(Node.BACKOFF_MULTIPLIER, reconnectAttempted);
            const jitter = Math.random() * Math.min(2000, baseBackoff * 0.2);
            const backoffTime = Math.min(baseBackoff + jitter, Node.MAX_BACKOFF);

            reconnectAttempted++;
            
            if (aqua.listenerCount('nodeReconnect') > 0) {
                aqua.emit("nodeReconnect", this, {
                    attempt: reconnectAttempted,
                    backoffTime
                });
            }
            
            reconnectTimeoutId = setTimeout(() => this.connect(), backoffTime);
        };
        
        this.connect = async () => {
            ws = new WebSocket(this.wsUrl, {
                headers: this._constructHeaders(),
                perMessageDeflate: false,
            });
            
            ws.once("open", this._onOpen);
            ws.once("error", this._onError);
            ws.on("message", this._onMessage);
            ws.once("close", this._onClose);
        };
        
        this.destroy = (clean = false) => {
            clearTimeout(reconnectTimeoutId);

            if (ws) {
                ws.removeAllListeners();
                if (ws.readyState === Node.WS_OPEN) {
                    ws.close();
                }
                ws = null;
            }

            if (clean) {
                if (aqua.listenerCount('nodeDestroy') > 0) {
                    aqua.emit("nodeDestroy", this);
                }
                aqua.nodes.delete(this.name);
                return;
            }

            if (this.connected) {
                for (const player of aqua.players.values()) {
                    if (player.node === this) {
                        player.destroy();
                    }
                }
            }

            this.connected = false;
            aqua.nodes.delete(this.name);
            
            if (aqua.listenerCount('nodeDestroy') > 0) {
                aqua.emit("nodeDestroy", this);
            }
            
            this.info = null;
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

    async getStats() {
        const newStats = await this.rest.getStats();
        Object.assign(this.stats, newStats);
        return this.stats;
    }

    _updateStats(payload) {
        if (!payload) return;

        this.stats.players = payload.players || this.stats.players;
        this.stats.playingPlayers = payload.playingPlayers || this.stats.playingPlayers;
        this.stats.uptime = payload.uptime || this.stats.uptime;
        this.stats.ping = payload.ping || this.stats.ping;

        const memory = payload.memory || {};
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

        const cpu = payload.cpu || {};
        const cores = cpu.cores || this.stats.cpu.cores;
        
        this.stats.cpu.cores = cores;
        this.stats.cpu.systemLoad = cpu.systemLoad || this.stats.cpu.systemLoad;
        this.stats.cpu.lavalinkLoad = cpu.lavalinkLoad || this.stats.cpu.lavalinkLoad;
        
        if (cores) {
            this.stats.cpu.lavalinkLoadPercentage = (cpu.lavalinkLoad / cores) * 100;
        }

        const frameStats = payload.frameStats || {};
        
        this.stats.frameStats.sent = frameStats.sent || this.stats.frameStats.sent;
        this.stats.frameStats.nulled = frameStats.nulled || this.stats.frameStats.nulled;
        this.stats.frameStats.deficit = frameStats.deficit || this.stats.frameStats.deficit;
    }

    _handleReadyOp(payload) {
        if (!payload.sessionId) {
            if (this.aqua.listenerCount('error') > 0) {
                this.aqua.emit("error", this, "Ready payload missing sessionId");
            }
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);

        if (this.aqua.listenerCount('nodeConnect') > 0) {
            this.aqua.emit("nodeConnect", this);
        }
    }

    async resumePlayers() {
        try {
            await this.rest.makeRequest("PATCH", `/v4/sessions/${this.sessionId}`, {
                resuming: true,
                timeout: this.resumeTimeout
            });
            
            if (this.aqua.listenerCount('debug') > 0) {
                this.aqua.emit("debug", this.name, `Successfully resumed session ${this.sessionId}`);
            }
        } catch (err) {
            if (this.aqua.listenerCount('error') > 0) {
                this.aqua.emit("error", this, `Failed to resume session: ${err.message}`);
            }
        }
    }
}

module.exports = Node;
