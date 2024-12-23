const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    constructor(aqua, nodes, options) {
        this.aqua = aqua;
        this.name = nodes.name || nodes.host;
        this.host = nodes.host || "localhost";
        this.port = nodes.port || 2333;
        this.password = nodes.password || "youshallnotpass";
        this.stats = this.initializeStats();
        this.restVersion = "v4";
        this.secure = nodes.secure || false;
        this.sessionId = nodes.sessionId || null;
        this.rest = new Rest(aqua, this);
        this.wsUrl = `ws${this.secure ? 's' : ''}://${this.host}:${this.port}/v4/websocket`;
        this.ws = null;
        this.regions = nodes.regions || [];
        this.info = null;
        this.connected = false;
        this.resumeKey = options.resumeKey || null;
        this.resumeTimeout = options.resumeTimeout || 60;
        this.autoResume = options.autoResume || false;
        this.reconnectTimeout = options.reconnectTimeout || 2000;
        this.reconnectTries = options.reconnectTries || 3;
        this.reconnectAttempted = 0;
        this.lastStatsRequest = 0;
    }

    initializeStats() {
        return {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: this.initializeMemoryStats(),
            cpu: this.initializeCpuStats(),
            frameStats: this.initializeFrameStats(),
            ping: 0,
        };
    }

    initializeMemoryStats() {
        return {
            free: 0,
            used: 0,
            allocated: 0,
            reservable: 0,
            freePercentage: 0,
            usedPercentage: 0,
        };
    }

    initializeCpuStats() {
        return {
            cores: 0,
            systemLoad: 0,
            lavalinkLoad: 0,
            lavalinkLoadPercentage: 0,
        };
    }

    initializeFrameStats() {
        return {
            sent: 0,
            nulled: 0,
            deficit: 0,
        };
    }

    async fetchInfo(options = {}) {
        return await this.rest.makeRequest("GET", `/v4/info`, null, options.includeHeaders);
    }

    async connect() {
        if (this.ws) {
            this.ws.close();
        }
        this.aqua.emit('debug', this.name, `Attempting to connect...`);
        this.ws = new WebSocket(this.wsUrl, { headers: this.constructHeaders() });
        this.setupWebSocketListeners();
    }

    constructHeaders() {
        return {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
            "Session-Id": this.sessionId,
            "Resume-Key": this.resumeKey,
        };
    }

    setupWebSocketListeners() {
        this.ws.on("open", this.onOpen.bind(this));
        this.ws.on("error", this.onError.bind(this));
        this.ws.on("message", this.onMessage.bind(this));
        this.ws.on("close", this.onClose.bind(this));
    }

    async onOpen() {
        this.connected = true;
        this.aqua.emit('debug', this.name, `Connected to Lavalink at ${this.wsUrl}`);
        try {
            this.info = await this.fetchInfo();
        } catch (err) {
            this.aqua.emit('debug', `Failed to fetch info: ${err.message}`);
            this.info = null;
        }
        switch (true) {
            case !this.info && !this.aqua.bypassChecks.nodeFetchInfo:
                throw new Error(`Failed to fetch node info.`);
            case this.autoResume:
                this.resumePlayers();
                break;
        }
        this.lastStatsRequest = Date.now();
    }

    async getStats() {
        const now = Date.now();
        if (now - this.lastStatsRequest < 10000) { // Increase the interval to 10 seconds
            return this.stats; // Return cached stats if requested too soon
        }
        try {
            const response = await this.rest.makeRequest("GET", `/v4/stats`);
            const stats = await response.json();
            this.stats = { ...this.stats, ...stats };
            this.lastStatsRequest = now; // Update last request time
            return stats;
        } catch (err) {
            this.aqua.emit('debug', `Error fetching stats: ${err.message}`);
            return this.stats; // Return last known stats on error
        }
    }

    resumePlayers() {
        this.rest.makeRequest(`PATCH`, `/${this.rest.version}/sessions/${this.sessionId}`, { resuming: true, timeout: this.resumeTimeout });
    }

    onError(event) {
        this.aqua.emit("nodeError", this, event);
    }

    onMessage(msg) {
        if (Array.isArray(msg)) msg = Buffer.concat(msg);
        if (msg instanceof ArrayBuffer) msg = Buffer.from(msg);
        let payload;

        try {
            payload = JSON.parse(msg.toString());
        } catch (err) {
            this.aqua.emit('debug', `Failed to parse message: ${err.message}`);
            return;
        }

        if (!payload.op) return;
        this.aqua.emit("raw", "Node", payload);
        this.aqua.emit("debug", this.name, `Received update: ${JSON.stringify(payload)}`);
        this.handlePayload(payload);
    }

    handlePayload(payload) {
        switch (payload.op) {
            case "stats":
                this.updateStats(payload);
                break;
            case "ready":
                this.initializeSessionId(payload.sessionId);
                if (this.autoResume) this.resumePlayers();
                this.aqua.emit("nodeConnect", this);
                break;
            default:
                const player = this.aqua.players.get(payload.guildId);
                if (player) player.emit(payload.op, payload);
                break;
        }
    }

    updateStats(payload) {
        this.stats = {
            ...this.stats,
            players: payload.players || 0,
            playingPlayers: payload.playingPlayers || 0,
            uptime: payload.uptime || 0,
            memory: {
                free: payload.memory?.free || 0,
                used: payload.memory?.used || 0,
                allocated: payload.memory?.allocated || 0,
                reservable: payload.memory?.reservable || 0,
                freePercentage: payload.memory ? (payload.memory.free / payload.memory.allocated) * 100 : 0,
                usedPercentage: payload.memory ? (payload.memory.used / payload.memory.allocated) * 100 : 0,
            },
            cpu: {
                cores: payload.cpu?.cores || 0,
                systemLoad: payload.cpu?.systemLoad || 0,
                lavalinkLoad: payload.cpu?.lavalinkLoad || 0,
                lavalinkLoadPercentage: payload.cpu ? (payload.cpu.lavalinkLoad / payload.cpu.cores) * 100 : 0,
            },
            frameStats: {
                sent: payload.frameStats?.sent || 0,
                nulled: payload.frameStats?.nulled || 0,
                deficit: payload.frameStats?.deficit || 0,
            },
            ping: payload.ping || 0,
        };
    }

    initializeSessionId(sessionId) {
        if (this.sessionId !== sessionId) {
            this.rest.setSessionId(sessionId);
            this.sessionId = sessionId;
        }
    }

    onClose(event, reason) {
        this.aqua.emit("nodeDisconnect", this, { event, reason });
        this.connected = false;
        this.reconnect();
    }

    reconnect() {
        if (this.reconnectAttempted++ >= this.reconnectTries) {
            this.aqua.emit("nodeError", this, new Error(`Unable to connect after ${this.reconnectTries} attempts.`));
            return this.destroy();
        }
        setTimeout(() => {
            this.aqua.emit("nodeReconnect", this);
            this.connect();
        }, this.reconnectTimeout);
    }

    destroy(clean = false) {
        if (clean) {
            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodes.delete(this.name);
            return;
        }
        if (!this.connected) return;
        this.aqua.players.forEach((player) => {
            if (player.node === this) player.destroy();
        });
        this.aqua.emit("nodeDestroy", this);
        this.aqua.nodeMap.delete(this.name);
        this.connected = false;
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
    }

    disconnect() {
        if (!this.connected) return;
        this.aqua.players.forEach((player) => { if (player.node === this) { player.move(); } });
        this.aqua.emit("nodeDisconnect", this);
        this.connected = false;
    }

    get penalties() {
        let penalties = 0;
        if (!this.connected) return penalties;
        if (this.stats.players) penalties += this.stats.players;
        if (this.stats.cpu?.systemLoad) {
            penalties += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10);
        }
        if (this.stats.frameStats) {
            penalties += this.stats.frameStats.deficit || 0;
            penalties += (this.stats.frameStats.nulled || 0) * 2;
        }
        return penalties;
    }
}

module.exports = { Node };
