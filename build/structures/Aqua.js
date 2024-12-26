const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json");

// Constants
const URL_REGEX = /^https?:\/\//;
const REQUEST_TIMEOUT = 10000;
const LOAD_TYPES = {
  EMPTY: "empty",
  NO_MATCHES: "NO_MATCHES",
  ERROR: "error",
  LOAD_FAILED: "LOAD_FAILED",
  TRACK: "track",
  PLAYLIST: "playlist",
  SEARCH: "search"
};

class Aqua extends EventEmitter {
    #weakPlayerRefs = new WeakMap(); // Store weak references to players
    #nodeLoadCache = new WeakMap(); // Cache node load calculations
    #requestNodeCache = new Map(); // Cache request nodes with TTL
    
    constructor(client, nodes, options) {
        super();
        this.validateInputs(client, nodes, options);

        // Initialize core properties
        Object.defineProperties(this, {
            client: { value: client, writable: true },
            nodes: { value: nodes },
            nodeMap: { value: new Map() },
            players: { value: new Map() },
            plugins: { value: options.plugins || [] },
            version: { value: pkgVersion },
            options: { value: options },
            send: { value: options.send }
        });

        // Initialize configurable properties
        this.clientId = null;
        this.initiated = false;
        this.shouldDeleteMessage = options.shouldDeleteMessage || false;
        this.defaultSearchPlatform = options.defaultSearchPlatform || "ytsearch";
        this.restVersion = options.restVersion || "v4";
        this.autoResume = options.autoResume || false;

        // Performance optimizations
        this.setMaxListeners(0);
        this.setupCleanupInterval();
    }

    setupCleanupInterval() {
        // Cleanup idle players and cache every 5 minutes
        const interval = setInterval(() => {
            this.cleanupIdle();
            this.#requestNodeCache.clear();
        }, 300000);
        
        // Prevent interval from keeping process alive
        interval.unref();
    }

    get leastUsedNodes() {
        return [...this.nodeMap.values()]
            .filter(node => node.connected)
            .sort((a, b) => (a.rest.calls + this.getNodeLoad(a)) - (b.rest.calls + this.getNodeLoad(b)));
    }

    getNodeLoad(node) {
        // Cache node load calculations
        let load = this.#nodeLoadCache.get(node);
        if (!load) {
            load = this.calculateLoad(node);
            this.#nodeLoadCache.set(node, load);
        }
        return load;
    }

    createPlayer(node, options) {
        // Cleanup existing player if any
        this.destroyPlayer(options.guildId);

        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);

        // Use WeakRef to allow garbage collection
        const weakRef = new WeakRef(player);
        this.#weakPlayerRefs.set(player, weakRef);

        // Cleanup handler using weak reference
        const cleanup = () => {
            const instance = weakRef.deref();
            if (instance) {
                this.cleanupPlayer(instance);
            }
        };

        // Auto cleanup on destroy
        player.once("destroy", cleanup);

        // Connect and emit event
        player.connect(options).catch(console.error);
        this.emit("playerCreate", player);

        return player;
    }

    async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
        this.ensureInitialized();

        // Get cached request node or create new one
        const cacheKey = `${nodes}-${Date.now()}`;
        let requestNode = this.#requestNodeCache.get(cacheKey);
        
        if (!requestNode) {
            requestNode = this.getRequestNode(nodes);
            this.#requestNodeCache.set(cacheKey, requestNode);
        }

        const formattedQuery = this.formatQuery(query, source);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

            const response = await requestNode.rest.makeRequest(
                "GET",
                `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`,
                { signal: controller.signal }
            );

            clearTimeout(timeoutId);

            if ([LOAD_TYPES.EMPTY, LOAD_TYPES.NO_MATCHES].includes(response.loadType)) {
                return this.handleNoMatches(requestNode.rest, query);
            }

            return this.constructResponse(response, requester, requestNode);
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
        }
    }

    cleanup() {
        // Clear all maps and caches
        this.players.clear();
        this.nodeMap.clear();
        this.#weakPlayerRefs = new WeakMap();
        this.#nodeLoadCache = new WeakMap();
        this.#requestNodeCache.clear();

        // Cleanup plugins
        this.plugins?.forEach(plugin => {
            try {
                plugin.unload?.(this);
            } catch (error) {
                console.error(`Error unloading plugin:`, error);
            }
        });

        // Clear references
        this.client = null;
        this.nodes = null;
        this.plugins = null;
        this.options = null;
        this.send = null;

        // Remove all listeners
        this.removeAllListeners();
    }

    validateInputs(client, nodes, options) {
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || !nodes.length) throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        if (typeof options?.send !== "function") throw new Error("Send function is required to initialize Aqua");
    }

    init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;

        try {
            this.nodes.forEach(nodeConfig => this.createNode(nodeConfig));
            this.initiated = true;
            this.plugins.forEach(plugin => plugin.load(this));
        } catch (error) {
            this.initiated = false;
            throw error;
        }

        return this;
    }

    createNode(options) {
        const nodeId = options.name || options.host;
        if (this.nodeMap.has(nodeId)) {
            this.destroyNode(nodeId);
        }

        const node = new Node(this, options, this.options);
        this.nodeMap.set(nodeId, node);

        try {
            node.connect();
            this.emit("nodeCreate", node);
            return node;
        } catch (error) {
            this.nodeMap.delete(nodeId);
            throw error;
        }
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;

        try {
            node.disconnect();
            node.removeAllListeners(); 
            this.nodeMap.delete(identifier);
            this.emit("nodeDestroy", node);
        } catch (error) {
            console.error(`Error destroying node ${identifier}:`, error);
        }
    }

    updateVoiceState(packet) {
        if (!packet?.d?.guild_id) return;

        const player = this.players.get(packet.d.guild_id);
        if (!player) return;

        if (packet.t === "VOICE_SERVER_UPDATE" ||
            (packet.t === "VOICE_STATE_UPDATE" && packet.d.user_id === this.clientId)) {

            const updateType = packet.t === "VOICE_SERVER_UPDATE" ? "setServerUpdate" : "setStateUpdate";
            player.connection[updateType](packet.d);

            if (packet.d.status === "disconnected") {
                this.cleanupPlayer(player);
            }
        }
    }

    fetchRegion(region) {
        if (!region) return this.leastUsedNodes;

        const lowerRegion = region.toLowerCase();
        const eligibleNodes = [...this.nodeMap.values()].filter(
            node => node.connected && node.regions?.includes(lowerRegion)
        );

        return eligibleNodes.sort((a, b) => this.calculateLoad(a) - this.calculateLoad(b));
    }

    calculateLoad(node) {
        if (!node?.stats?.cpu) return 0;
        const { systemLoad, cores } = node.stats.cpu;
        return (systemLoad / cores) * 100;
    }

    createConnection(options) {
        this.ensureInitialized();

        const existingPlayer = this.players.get(options.guildId);
        if (existingPlayer?.voiceChannel) return existingPlayer;

        const node = options.region ?
            this.fetchRegion(options.region)[0] :
            this.leastUsedNodes[0];

        if (!node) throw new Error("No nodes are available");
        return this.createPlayer(node, options);
    }

    destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (!player) return;

        try {
            player.clearData();
            player.removeAllListeners(); // Clear all event listeners
            player.destroy();
            this.players.delete(guildId);
            this.emit("playerDestroy", player);
        } catch (error) {
            console.error(`Error destroying player for guild ${guildId}:`, error);
        }
    }

    getRequestNode(nodes) {
        if (nodes && !(typeof nodes === "string" || nodes instanceof Node)) {
            throw new TypeError(`'nodes' must be a string or Node instance, received: ${typeof nodes}`);
        }
        return (typeof nodes === 'string' ? this.nodeMap.get(nodes) : nodes) ?? this.leastUsedNodes[0];
    }

    ensureInitialized() {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");
    }

    formatQuery(query, source) {
        return URL_REGEX.test(query) ? query : `${source}:${query}`;
    }

    async handleNoMatches(rest, query) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const youtubeResponse = await rest.makeRequest("GET",
                `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`,
                { signal: controller.signal }
            );

            if ([LOAD_TYPES.EMPTY, LOAD_TYPES.NO_MATCHES].includes(youtubeResponse.loadType)) {
                return await rest.makeRequest("GET",
                    `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`,
                    { signal: controller.signal }
                );
            }
            return youtubeResponse;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    constructResponse(response, requester, requestNode) {
        const baseResponse = {
            loadType: response.loadType,
            exception: null,
            playlistInfo: null,
            pluginInfo: response.pluginInfo ?? {},
            tracks: [],
        };

        if ([LOAD_TYPES.ERROR, LOAD_TYPES.LOAD_FAILED].includes(response.loadType)) {
            baseResponse.exception = response.data ?? response.exception;
            return baseResponse;
        }

        const trackFactory = (trackData) => new Track(trackData, requester, requestNode);

        switch (response.loadType) {
            case LOAD_TYPES.TRACK:
                if (response.data) {
                    baseResponse.tracks.push(trackFactory(response.data));
                }
                break;
            case LOAD_TYPES.PLAYLIST:
                if (response.data?.info) {
                    baseResponse.playlistInfo = {
                        name: response.data.info.name ?? response.data.info.title,
                        ...response.data.info,
                    };
                }
                baseResponse.tracks = (response.data?.tracks ?? []).map(trackFactory);
                break;
            case LOAD_TYPES.SEARCH:
                baseResponse.tracks = (response.data ?? []).map(trackFactory);
                break;
        }
        return baseResponse;
    }

    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }

    cleanupIdle() {
        const now = Date.now();
        for (const [guildId, player] of this.players) {
            if (!player.playing && !player.paused && player.queue.isEmpty() &&
                (now - player.lastActivity) > this.options.idleTimeout) {
                this.cleanupPlayer(player);
            }
        }
    }

    cleanupPlayer(player) {
        if (!player) return;

        try {
            player.clearData();
            player.removeAllListeners();
            player.destroy();
            this.players.delete(player.guildId);
            this.emit("playerDestroy", player);
        } catch (error) {
            console.error(`Error during player cleanup: ${error.message}`);
        }
    }
}
module.exports = { Aqua };
