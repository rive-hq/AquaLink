
const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    /**
     * @param {import("./Aqua").Aqua} aqua
     * @param {Object} nodes
     * @param {Object} options
     */
    constructor(aqua, nodes, options) {
        this.aqua = aqua;
        this.name = nodes.name || nodes.host;
        this.host = nodes.host || "localhost";
        this.port = nodes.port || 2333;
        this.password = nodes.password || "youshallnotpass";
        this.restVersion = "v4"; // Fixed to the specified version
        this.secure = nodes.secure || false;
        this.sessionId = nodes.sessionId || null;
        this.rest = new Rest(aqua, this);

        this.wsUrl = `ws${this.secure ? 's' : ''}://${this.host}:${this.port}/v4/websocket`;
        this.restUrl = `http${this.secure ? 's' : ''}://${this.host}:${this.port}`;
        
        this.ws = null;
        this.regions = nodes.regions;
        this.info = null;
        this.stats = this.initializeStats();
        this.connected = false;

        this.resumeKey = options.resumeKey || null;
        this.resumeTimeout = options.resumeTimeout || 60;
        this.autoResume = options.autoResume || false;

        this.reconnectTimeout = options.reconnectTimeout || 5000;
        this.reconnectTries = options.reconnectTries || 3;
        this.reconnectAttempted = 0;
    }

    initializeStats() {
        return {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: {
                free: 0,
                used: 0,
                allocated: 0,
                reservable: 0,
            },
            cpu: {
                cores: 0,
                systemLoad: 0,
                lavalinkLoad: 0,
            },
            frameStats: {
                sent: 0,
                nulled: 0,
                deficit: 0,
            },
        };
    }

    async fetchInfo(options = {}) {
        return await this.rest.makeRequest("GET", `/v4/info`, null, options.includeHeaders);
    }

    async connect() {
        if (this.ws) this.ws.close();
        this.aqua.emit('debug', this.name, `Attempting to connect...`);
        const headers = this.constructHeaders();
        this.ws = new WebSocket(this.wsUrl, { headers });
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

        this.info = await this.fetchInfo()
            .catch(err => {
                this.aqua.emit('debug', `Failed to fetch info: ${err.message}`);
                return null;
            });

        if (!this.info && !this.aqua.bypassChecks.nodeFetchInfo) {
            throw new Error(`Failed to fetch node info.`);
        }

        if (this.autoResume) {
            this.resumePlayers();
        }

        this.lastStats = 0;
    }

    async getStats() {
        if (Date.now() - this.lastStats < 5000) {
            return this.stats;
        }

        const stats = await this.rest.makeRequest("GET", `/v4/stats`)
            .catch(err => {
                this.aqua.emit('debug', `Error fetching stats: ${err.message}`);
                return null;
            });

        if (stats) {
            this.stats = stats;
            this.lastStats = Date.now();
        }

        return stats;
    }

    resumePlayers() {
        for (const player of this.aqua.players.values()) {
            if (player.node === this) {
                player.restart();
            }
        }
    }

    onError(event) {
        this.aqua.emit("nodeError", this, event);
    }

    onMessage(msg) {
        if (Array.isArray(msg)) msg = Buffer.concat(msg);
        if (msg instanceof ArrayBuffer) msg = Buffer.from(msg);

        const payload = JSON.parse(msg.toString());
        if (!payload.op) return;

        this.aqua.emit("raw", "Node", payload);
        this.aqua.emit("debug", this.name, `Received update: ${JSON.stringify(payload)}`);

        this.handlePayload(payload);
    }

    handlePayload(payload) {
        switch (payload.op) {
            case "stats":
                this.stats = { ...payload };
                this.lastStats = Date.now();
                break;
            case "ready":
                this.initializeSessionId(payload.sessionId);
                this.aqua.emit("nodeConnect", this);
                break;
            default:
                const player = this.aqua.players.get(payload.guildId);
                if (payload.guildId && player) {
                    player.emit(payload.op, payload);
                }
                break;
        }
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
        this.reconnectAttempted++;
        if (this.reconnectAttempted > this.reconnectTries) {
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
            this.ws?.removeAllListeners();
            this.ws = null;
            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodes.delete(this.name);
            return;
        }

        if (!this.connected) return;

        this.aqua.players.forEach((player) => {
            if (player.node === this) player.destroy();
        });

        if (this.ws) this.ws.close(1000, "destroy");
        this.ws?.removeAllListeners();
        this.ws = null;

        this.aqua.emit("nodeDestroy", this);
        this.aqua.nodeMap.delete(this.name);
        this.connected = false;
    }

    disconnect() {
        if (!this.connected) return;
        this.aqua.players.forEach((player) => { if (player.node === this) { player.move() } });
        this.ws.close(1000, "disconnect");
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
