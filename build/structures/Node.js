const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    #ws = null;
    #statsCache = {};
    #lastStatsRequest = 0;
    #reconnectAttempted = 0;
    #reconnectTimeoutId = null;
    #heartbeatInterval = null;
    #connectionState = "DISCONNECTED"; // DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING

    constructor(aqua, nodes, options) {
        const {
            name,
            host = "localhost",
            port = 2333,
            password = "youshallnotpass",
            secure = false,
            sessionId = null,
            regions = []
        } = nodes;

        this.aqua = aqua;
        this.name = name || host;
        this.host = host;
        this.port = port;
        this.password = password;
        this.secure = secure;
        this.sessionId = sessionId;
        this.regions = regions;
        this.wsUrl = new URL(`ws${secure ? 's' : ''}://${host}:${port}/v4/websocket`);
        this.rest = new Rest(aqua, this);
        this.resumeKey = options?.resumeKey ?? null;
        this.resumeTimeout = options?.resumeTimeout ?? 60;
        this.autoResume = options?.autoResume ?? false;
        this.reconnectTimeout = options?.reconnectTimeout ?? 2000;
        this.reconnectTries = options?.reconnectTries ?? 3;
        this.infiniteReconnects = options?.infiniteReconnects ?? false;
        this.heartbeatInterval = options?.heartbeatInterval ?? 45000;
        this.info = null;
        this.stats = Object.freeze(this.#createStats());
    }

    #createStats() {
        return {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { free: 0, used: 0, allocated: 0, reservable: 0, freePercentage: 0, usedPercentage: 0 },
            cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0, lavalinkLoadPercentage: 0 },
            frameStats: { sent: null, nulled: null, deficit: null },
            ping: 0
        };
    }

    get connected() {
        return this.#connectionState === "CONNECTED";
    }

    set connected(value) {
        this.#connectionState = value ? "CONNECTED" : "DISCONNECTED";
    }

    async connect() {
        if (this.#connectionState === "CONNECTING" || this.#connectionState === "CONNECTED") {
            return;
        }

        this.#cleanup();
        this.#connectionState = "CONNECTING";

        try {
            this.#ws = new WebSocket(this.wsUrl.href, {
                headers: this.#constructHeaders(),
                perMessageDeflate: false
            });
            this.#setupWebSocketListeners();
            this.aqua.emit('debug', this.name, 'Connecting...');
        } catch (err) {
            this.aqua.emit('debug', this.name, `Connection failed: ${err.message}`);
            this.#handleConnectionFailure();
        }
    }

    #cleanup() {
        clearInterval(this.#heartbeatInterval);
        clearTimeout(this.#reconnectTimeoutId);
        
        if (this.#ws) {
            this.#ws.removeAllListeners();
            if (this.#ws.readyState === WebSocket.OPEN) {
                this.#ws.close(1000, "Clean shutdown");
            } else {
                this.#ws.terminate();
            }
            
            this.#ws = null;
        }
    }

    #constructHeaders() {
        const headers = {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
        };
        if (this.sessionId) headers["Session-Id"] = this.sessionId;
        if (this.resumeKey) headers["Resume-Key"] = this.resumeKey;
        return Object.freeze(headers);
    }

    #setupWebSocketListeners() {
        if (!this.#ws) return;
        
        this.#ws.once("open", this.#onOpen.bind(this));
        this.#ws.once("error", this.#onError.bind(this));
        this.#ws.on("message", this.#onMessage.bind(this));
        this.#ws.once("close", this.#onClose.bind(this));
        
        const connectionTimeout = setTimeout(() => {
            if (this.#connectionState === "CONNECTING") {
                this.aqua.emit('debug', this.name, 'Connection timed out');
                this.#handleConnectionFailure();
            }
        }, 10000);

        this.#ws.once("open", () => clearTimeout(connectionTimeout));
    }


    async #onOpen() {
        this.#connectionState = "CONNECTED";
        this.#reconnectAttempted = 0;
        this.aqua.emit('debug', this.name, `Connected to ${this.wsUrl.href}`);

        this.#setupHeartbeat();

        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            if (this.autoResume) await this.resumePlayers();
        } catch (err) {
            this.info = null;
            if (!this.aqua.bypassChecks?.nodeFetchInfo) {
                this.aqua.emit('error', `Failed to fetch node info: ${err.message}`);
            }
        }
    }

    #setupHeartbeat() {
        clearInterval(this.#heartbeatInterval);
        this.#heartbeatInterval = setInterval(() => {
            if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
                this.#ws.ping().catch(() => {
                    this.aqua.emit('debug', this.name, 'Heartbeat failed');
                    this.#handleConnectionFailure();
                });
            }
        }, this.heartbeatInterval);
    }

    #handleConnectionFailure() {
        const wasConnected = this.#connectionState === "CONNECTED";
        this.#connectionState = "DISCONNECTED";
        this.#cleanup();

        if (wasConnected) {
            this.aqua.emit("nodeDisconnect", this, { code: 1006, reason: "Connection failed" });
        }

        this.#reconnect();
    }

    async getStats() {
        const now = Date.now();
        const STATS_COOLDOWN = 60000;
        if (now - this.#lastStatsRequest < STATS_COOLDOWN) {
            return this.#statsCache[this.name] ?? this.stats;
        }
        try {
            const stats = await this.rest.makeRequest("GET", "/v4/stats");
            this.#updateStats(stats);
            this.#lastStatsRequest = now;
            this.#statsCache[this.name] = this.stats;
            return this.stats;
        } catch (err) {
            this.aqua.emit('debug', `Stats fetch error: ${err.message}`);
            return this.stats;
        }
    }

    #updateStats(payload) {
        if (!payload) return;
        this.stats = Object.freeze({
            players: payload.players ?? 0,
            playingPlayers: payload.playingPlayers ?? 0,
            uptime: payload.uptime ?? 0,
            ping: payload.ping ?? 0,
            memory: this.#updateMemoryStats(payload.memory),
            cpu: this.#updateCpuStats(payload.cpu),
            frameStats: this.#updateFrameStats(payload.frameStats)
        });
    }

    #updateMemoryStats(memory = {}) {
        const allocated = memory.allocated ?? 0;
        const free = memory.free ?? 0;
        const used = memory.used ?? 0;
        return Object.freeze({
            free,
            used,
            allocated,
            reservable: memory.reservable ?? 0,
            freePercentage: allocated ? (free / allocated) * 100 : 0,
            usedPercentage: allocated ? (used / allocated) * 100 : 0
        });
    }

    #updateCpuStats(cpu = {}) {
        const cores = cpu.cores ?? 0;
        return Object.freeze({
            cores,
            systemLoad: cpu.systemLoad ?? 0,
            lavalinkLoad: cpu.lavalinkLoad ?? 0,
            lavalinkLoadPercentage: cores ? (cpu.lavalinkLoad / cores) * 100 : 0
        });
    }

    #updateFrameStats(frameStats = {}) {
        if (!frameStats) {
            return Object.freeze({
                sent: 0,
                nulled: 0,
                deficit: 0
            });
        }
    }

    #onMessage(msg) {
        try {
            const payload = JSON.parse(msg.toString());
            if (!payload?.op) return;
            switch (payload.op) {
                case "stats":
                    this.#updateStats(payload);
                    break;
                case "ready":
                    this.#handleReadyOp(payload);
                    break;
                default:
                    this.#handlePlayerOp(payload);
            }
        } catch (err) {
            this.aqua.emit('debug', `Message parse error: ${err.message}`);
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
        player?.emit(payload.op, payload);
    }

    #onError(error) {
        this.aqua.emit("nodeError", this, error);
        if (this.#connectionState === "CONNECTING") {
            this.#handleConnectionFailure();
        }
    }

    #onClose(code, reason) {
        const wasConnected = this.#connectionState === "CONNECTED";
        this.#connectionState = "DISCONNECTED";
        
        if (wasConnected) {
            this.aqua.emit("nodeDisconnect", this, { code, reason });
        }
        
        if (code !== 1000) {
            this.#reconnect();
        }
    }

    #reconnect() {
        if (this.#connectionState === "RECONNECTING") {
            return;
        }

        this.#connectionState = "RECONNECTING";

        if (this.infiniteReconnects) {
            this.aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, attempting reconnection...");
            this.#reconnectTimeoutId = setTimeout(() => this.connect(), 10000);
            return;
        }

        if (++this.#reconnectAttempted >= this.reconnectTries) {
            this.aqua.emit("nodeError", this, new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            return this.destroy();
        }

        const delay = this.reconnectTimeout * Math.pow(2, this.#reconnectAttempted - 1);
        this.aqua.emit("nodeReconnect", this, `Attempt ${this.#reconnectAttempted}/${this.reconnectTries} in ${delay}ms`);

        this.#reconnectTimeoutId = setTimeout(() => {
            this.connect();
        }, delay);
    }

    get penalties() {
        if (!this.connected) return Number.MAX_SAFE_INTEGER;
        let penalties = this.stats.players;
        if (this.stats.cpu?.systemLoad) {
            penalties += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10);
        }
        if (this.stats.frameStats) {
            penalties += this.stats.frameStats.deficit + this.stats.frameStats.nulled * 2;
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
        this.#cleanup();
        this.connected = false;
        this.aqua.nodeMap.delete(this.name);
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
        this.#statsCache = {};
        this.stats = Object.freeze(this.#createStats());
    }
}

module.exports = { Node };
