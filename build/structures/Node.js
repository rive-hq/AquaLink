const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    constructor(aqua, nodes, options) {
        // Use object destructuring for cleaner initialization
        const { 
            name, host = "localhost", 
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
        
        // Initialize rest client
        this.rest = new Rest(aqua, this);
        this.wsUrl = `ws${secure ? 's' : ''}://${host}:${port}/v4/websocket`;
        
        // Options with defaults
        this.resumeKey = options?.resumeKey || null;
        this.resumeTimeout = options?.resumeTimeout || 60;
        this.autoResume = options?.autoResume || false;
        this.reconnectTimeout = options?.reconnectTimeout || 2000;
        this.reconnectTries = options?.reconnectTries || 3;
        
        // State variables
        this.ws = null;
        this.info = null;
        this.connected = false;
        this.reconnectAttempted = 0;
        this.lastStatsRequest = 0;
        
        this.stats = this.initializeStats();
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
        return await this.rest.makeRequest("GET", "/v4/info", null, options.includeHeaders);
    }

    async connect() {
        this.cleanup();
        this.aqua.emit('debug', this.name, `Attempting to connect...`);
        
        try {
            this.ws = new WebSocket(this.wsUrl, { headers: this.constructHeaders() });
            this.setupWebSocketListeners();
        } catch (err) {
            this.aqua.emit('debug', this.name, `Connection failed: ${err.message}`);
            this.reconnect();
        }
    }

    cleanup() {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (err) {
            } finally {
                this.ws = null;
            }
        }
    }

    constructHeaders() {
        const headers = {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
        };
        
        if (this.sessionId) headers["Session-Id"] = this.sessionId;
        if (this.resumeKey) headers["Resume-Key"] = this.resumeKey;
        
        return headers;
    }

    setupWebSocketListeners() {
        const ws = this.ws;
        if (!ws) return;

        ws.on("open", () => this.onOpen());
        ws.on("error", (error) => this.onError(error));
        ws.on("message", (data) => this.onMessage(data));
        ws.on("close", (event, reason) => this.onClose(event, reason));
    }

    async onOpen() {
        this.connected = true;
        this.aqua.emit('debug', this.name, `Connected to Lavalink at ${this.wsUrl}`);
        
        try {
            this.info = await this.fetchInfo();
            if (this.autoResume) {
                this.resumePlayers();
            }
        } catch (err) {
            this.aqua.emit('debug', `Failed to fetch info: ${err.message}`);
            this.info = null;
            if (!this.aqua.bypassChecks.nodeFetchInfo) {
                throw new Error(`Failed to fetch node info.`);
            }
        }
        
        this.lastStatsRequest = Date.now();
    }

  // Implement WeakMap for caching
  #statsCache = new WeakMap();

  async getStats() {
      const STATS_COOLDOWN = 10000;
      const now = Date.now();
      
      if (now - this.lastStatsRequest < STATS_COOLDOWN) {
          return this.stats;
      }

      try {
          const response = await this.rest.makeRequest("GET", "/v4/stats");
          const stats = await response.json();
          this.updateStats(stats);
          this.lastStatsRequest = now;
          this.#statsCache.set(this, stats);
      } catch (err) {
          this.aqua.emit('debug', `Error fetching stats: ${err.message}`);
      }
      
      return this.stats;
  }

    updateStats(payload) {
        if (!payload) return;

        const memory = payload.memory || {};
        const cpu = payload.cpu || {};
        const frameStats = payload.frameStats || {};

        this.stats.players = payload.players || 0;
        this.stats.playingPlayers = payload.playingPlayers || 0;
        this.stats.uptime = payload.uptime || 0;
        this.stats.ping = payload.ping || 0;

        Object.assign(this.stats.memory, {
            free: memory.free || 0,
            used: memory.used || 0,
            allocated: memory.allocated || 0,
            reservable: memory.reservable || 0,
            freePercentage: memory.allocated ? (memory.free / memory.allocated) * 100 : 0,
            usedPercentage: memory.allocated ? (memory.used / memory.allocated) * 100 : 0
        });

        Object.assign(this.stats.cpu, {
            cores: cpu.cores || 0,
            systemLoad: cpu.systemLoad || 0,
            lavalinkLoad: cpu.lavalinkLoad || 0,
            lavalinkLoadPercentage: cpu.cores ? (cpu.lavalinkLoad / cpu.cores) * 100 : 0
        });

        Object.assign(this.stats.frameStats, {
            sent: frameStats.sent || 0,
            nulled: frameStats.nulled || 0,
            deficit: frameStats.deficit || 0
        });
    }

    resumePlayers() {
        this.rest.makeRequest("PATCH", `/${this.rest.version}/sessions/${this.sessionId}`, { resuming: true, timeout: this.resumeTimeout });
    }

    onError(event) {
        this.aqua.emit("nodeError", this, event);
    }

    onMessage(msg) {
        let payload;
        try {
            const data = msg instanceof Buffer ? msg : Buffer.from(msg);
            payload = JSON.parse(data.toString());
        } catch (err) {
            this.aqua.emit('debug', `Failed to parse message: ${err.message}`);
            return;
        }

        if (!payload?.op) return;
        
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

        if (this.connected) {
            for (const player of this.aqua.players.values()) {
                if (player.node === this) player.destroy();
            }

            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodeMap.delete(this.name);
            this.connected = false;
            this.cleanup();
        }

        this.info = null;
        this.stats = Object.freeze(this.initializeStats());
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
