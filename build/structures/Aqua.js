const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json");
const URL_REGEX = /^https?:\/\//;

class Aqua extends EventEmitter {
        /**
     * @param {Object} client - The client instance.
     * @param {Array<Object>} nodes - An array of node configurations.
     * @param {Object} options - Configuration options for Aqua.
     * @param {Function} options.send - Function to send data.
     * @param {string} [options.defaultSearchPlatform="ytsearch"] - Default search platform. Options include:
     *     - "youtube music": "ytmsearch"
     *     - "youtube": "ytsearch"
     *     - "spotify": "spsearch"
     *     - "jiosaavn": "jssearch"
     *     - "soundcloud": "scsearch"
     *     - "deezer": "dzsearch"
     *     - "tidal": "tdsearch"
     *     - "applemusic": "amsearch"
     *     - "bandcamp": "bcsearch"
     * @param {string} [options.restVersion="v4"] - Version of the REST API.
     * @param {Array<Object>} [options.plugins=[]] - Plugins to load.
     * @param {string} [options.shouldDeleteMessage='none'] - Should delete your message? (true, false)
     * @param {boolean} [options.autoResume=false] - Automatically resume tracks on reconnect.
     * @param {boolean} [options.infiniteReconnects=false] - Reconnect infinitely (default: false).
     */
    constructor(client, nodes, options) {
        super();
        this.validateInputs(client, nodes, options);
        this.client = client;
        this.nodes = nodes;
        this.nodeMap = new Map();
        this.players = new Map();
        this.clientId = null;
        this.initiated = false;
        this.shouldDeleteMessage = options.shouldDeleteMessage || false;
        this.defaultSearchPlatform = options.defaultSearchPlatform || "ytsearch";
        this.restVersion = options.restVersion || "v4";
        this.plugins = options.plugins || [];
        this.version = pkgVersion;
        this.options = options;
        this.send = options.send;
        this.autoResume = options.autoResume || false;
        this.infiniteReconnects = options.infiniteReconnects || false;
        this.setMaxListeners(0);
    }

    validateInputs(client, nodes, options) {
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || !nodes.length) throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        if (typeof options?.send !== "function") throw new Error("Send function is required to initialize Aqua");
    }

    get leastUsedNodes() {
        return [...this.nodeMap.values()].filter(node => node.connected).sort((a, b) => a.rest.calls - b.rest.calls);
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
        this.destroyNode(nodeId); // Ensure no duplicate nodes
        const node = new Node(this, options, this.options);
        this.nodeMap.set(nodeId, node);
        node.connect()
            .then(() => this.emit("nodeCreate", node))
            .catch(error => {
                this.nodeMap.delete(nodeId);
                throw error;
            });
        return node;
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;

        node.disconnect()
            .then(() => {
                node.removeAllListeners();
                this.nodeMap.delete(identifier);
                this.emit("nodeDestroy", node);
            })
            .catch(error => console.error(`Error destroying node ${identifier}:`, error));
    }

    updateVoiceState({ d, t }) {
        const player = this.players.get(d.guild_id);
        if (player && (t === "VOICE_SERVER_UPDATE" || (t === "VOICE_STATE_UPDATE" && d.user_id === this.clientId))) {
            player.connection[t === "VOICE_SERVER_UPDATE" ? "setServerUpdate" : "setStateUpdate"](d);
            if (d.status === "disconnected") this.cleanupPlayer(player);
        }
    }

    fetchRegion(region) {
        if (!region) return this.leastUsedNodes;
        const lowerRegion = region.toLowerCase();
        return [...this.nodeMap.values()]
            .filter(node => node.connected && node.regions?.includes(lowerRegion))
            .sort((a, b) => this.calculateLoad(a) - this.calculateLoad(b));
    }

    calculateLoad(node) {
        if (!node?.stats?.cpu) return 0;
        const { systemLoad, cores } = node.stats.cpu;
        return (systemLoad / cores) * 100;
    }

    createConnection(options) {
        this.ensureInitialized();
        const player = this.players.get(options.guildId);
        if (player && player.voiceChannel) return player;

        const node = options.region ? this.fetchRegion(options.region)[0] : this.leastUsedNodes[0];
        if (!node) throw new Error("No nodes are available");
        return this.createPlayer(node, options);
    }

    createPlayer(node, options) {
        this.destroyPlayer(options.guildId);
        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);
        player.once("destroy", () => this.cleanupPlayer(player));
        player.connect(options);
        this.emit("playerCreate", player);
        return player;
    }

    async destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (!player) return;

        try {
            await player.clearData(); // Assuming clearData is an async function
            player.removeAllListeners();
            this.players.delete(guildId);
            this.emit("playerDestroy", player);
        } catch (error) {
            console.error(`Error destroying player for guild ${guildId}:`, error);
        }
    }

    async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
        this.ensureInitialized();
        const requestNode = this.getRequestNode(nodes);
        const formattedQuery = this.formatQuery(query, source);
        try {
            const response = await requestNode.rest.makeRequest("GET", `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`);
            if (["empty", "NO_MATCHES"].includes(response.loadType)) {
                return await this.handleNoMatches(requestNode.rest, query);
            }
            return this.constructorResponse(response, requester, requestNode);
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
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
        try {
            const youtubeResponse = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`);
            if (["empty", "NO_MATCHES"].includes(youtubeResponse.loadType)) {
                return await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`);
            }
            return youtubeResponse;
        } catch (error) {
            console.error(`Failed to resolve track: ${error.message}`);
        }
    }

    constructorResponse(response, requester, requestNode) {
        const baseResponse = {
            loadType: response.loadType,
            exception: null,
            playlistInfo: null,
            pluginInfo: response.pluginInfo ?? {},
            tracks: [],
        };

        if (response.loadType === "error" || response.loadType === "LOAD_FAILED") {
            baseResponse.exception = response.data ?? response.exception;
            return baseResponse;
        }

        const trackFactory = (trackData) => new Track(trackData, requester, requestNode);
        switch (response.loadType) {
            case "track":
                if (response.data) {
                    baseResponse.tracks.push(trackFactory(response.data));
                }
                break;
            case "playlist":
                if (response.data?.info) {
                    baseResponse.playlistInfo = {
                        name: response.data.info.name ?? response.data.info.title,
                        ...response.data.info,
                    };
                }
                baseResponse.tracks = (response.data?.tracks ?? []).map(trackFactory);
                break;
            case "search":
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
            if (!player.playing && !player.paused && player.queue.isEmpty() && (now - player.lastActivity) > this.options.idleTimeout) {
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

    cleanup() {
        for (const player of this.players.values()) {
            this.cleanupPlayer(player);
        }
        for (const node of this.nodeMap.values()) {
            this.destroyNode(node.name || node.host);
        }
        this.nodeMap.clear();
        this.players.clear();
        this.client = null;
        this.nodes = null;
        this.plugins?.forEach(plugin => plugin.unload?.(this));
        this.plugins = null;
        this.options = null;
        this.send = null;
        this.version = null;
        this.removeAllListeners();
    }
}

module.exports = { Aqua };
