const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json");

class Aqua extends EventEmitter {
    /**
     * @param {Object} client - The client instance.
     * @param {Array<Object>} nodes - An array of node configurations.
     * @param {Object} options - Configuration options for Aqua.
     * @param {Function} options.send - Function to send data.
     * @param {string} [options.defaultSearchPlatform="ytsearch"] - Default search platform.
     * @param {string} [options.restVersion="v4"] - Version of the REST API.
     * @param {Array<Object>} [options.plugins=[]] - Plugins to load.
     */
    constructor(client, nodes, options) {
        super();
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        if (typeof options.send !== "function") throw new Error("Send function is required to initialize Aqua");

        this.client = client;
        this.nodes = nodes;
        this.nodeMap = new Map();
        this.players = new Map();
        this.clientId = null;
        this.initiated = false;
        this.sessionId = null;
        this.defaultSearchPlatform = options.defaultSearchPlatform || "ytmsearch";
        this.restVersion = options.restVersion || "v3";
        this.plugins = options.plugins || [];
        this.version = pkgVersion;
        this.loadType = null;
        this.tracks = [];
        this.playlistInfo = null;
        this.pluginInfo = null;
        this.options = options;
        this.send = options.send || null;
    }

    /**
     * Gets the least used nodes based on call count.
     * @returns {Array<Node>} Array of least used nodes.
     */
    get leastUsedNodes() {
        return [...this.nodeMap.values()]
            .filter(node => node.connected)
            .sort((a, b) => a.rest.calls - b.rest.calls);
    }

    /**
     * Initializes Aqua with the provided client ID.
     * @param {string} clientId - The client ID.
     * @returns {Aqua} The Aqua instance.
     */
    init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;
        this.nodes.forEach(nodeConfig => this.createNode(nodeConfig));
        this.initiated = true;
        this.plugins.forEach(plugin => plugin.load(this));
        return this;
    }

    /**
     * Creates a new node with the specified options.
     * @param {Object} options - The configuration for the node.
     * @returns {Node} The created node instance.
     */
    createNode(options) {
        const node = new Node(this, options, this.options);
        this.nodeMap.set(options.name || options.host, node);
        node.connect();
        this.emit("nodeCreate", node);
        return node;
    }

    /**
     * Destroys a node identified by the given identifier.
     * @param {string} identifier - The identifier of the node to destroy.
     */
    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;
        node.disconnect();
        this.nodeMap.delete(identifier);
        this.emit("nodeDestroy", node);
    }

    /**
     * Updates the voice state based on the received packet.
     * @param {Object} packet - The packet containing voice state information.
     */
    updateVoiceState(packet) {
        const player = this.players.get(packet.d.guild_id);
        if (!player) return;
        if (packet.t === "VOICE_SERVER_UPDATE") player.connection.setServerUpdate(packet.d);
        else if (packet.t === "VOICE_STATE_UPDATE" && packet.d.user_id === this.clientId) player.connection.setStateUpdate(packet.d);
    }
    /**
     * Fetches nodes by the specified region.
     * @param {string} region - The region to filter nodes by.
     * @returns {Array<Node>} Array of nodes in the specified region.
     */
    fetchRegion(region) {
        const nodesByRegion = [...this.nodeMap.values()]
            .filter(node => node.connected && node.regions?.includes(region?.toLowerCase()))
            .sort((a, b) => {
                const aLoad = a.stats.cpu ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100 : 0;
                const bLoad = b.stats.cpu ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100 : 0;
                return aLoad - bLoad;
            });
        return nodesByRegion;
    }

    /**
     * Creates a connection for a player.
     * @param {Object} options - Connection options.
     * @param {string} options.guildId - The ID of the guild.
     * @param {string} [options.region] - The region to connect to.
     * @returns {Player} The created player instance.
     */
    createConnection(options) {
        if (!this.initiated) throw new Error("BRO! Get aqua on before !!!");
        if (!this.leastUsedNodes.length) throw new Error("No nodes are available");

        const node = (options.region ? this.fetchRegion(options.region) : this.leastUsedNodes)[0];
        if (!node) throw new Error("No nodes are available");

        return this.createPlayer(node, options);
    }
    /**
     * Creates a player using the specified node.
     * @param {Node} node - The node to create the player with.
     * @param {Object} options - The player options.
     * @returns {Player} The created player instance.
     */
    createPlayer(node, options) {
        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);
        player.connect(options);
        this.emit("playerCreate", player);
        return player;
    }
    /**
     * Destroys the player associated with the given guild ID.
     * @param {string} guildId - The ID of the guild.
     */
    destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (!player) return;
        player.destroy();
        this.players.delete(guildId);
        this.emit("playerDestroy", player);
    }

    /**
     * Removes the connection for the specified guild ID.
     * @param {string} guildId - The ID of the guild.
     */
    removeConnection(guildId) {
        const player = this.players.get(guildId);
        if (player) {
            player.destroy();
            this.players.delete(guildId);
        }
    }

    /**
     * Resolves a query to tracks using the available nodes.
     * @param {Object} options - The options for resolving tracks.
     * @param {string} options.query - The query string to resolve.
     * @param {string} [options.source] - The source of the query.
     * @param {Object} [options.requester] - The requester of the query.
     * @param {string|Node} [options.nodes] - Specific nodes to use for the request.
     * @returns {Promise<Object>} The resolved tracks and related information.
     */
    async resolve({ query, source, requester, nodes }) {
        if (!this.initiated) throw new Error("Aqua must be initialized before resolving");
        if (nodes && (typeof nodes !== "string" && !(nodes instanceof Node))) {
            throw new Error(`'nodes' must be a string or Node instance, but received: ${typeof nodes}`);
        }

        const searchSources = source || this.defaultSearchPlatform;
        const requestNode = (typeof nodes === 'string' ? this.nodeMap.get(nodes) : nodes) || this.leastUsedNodes[0];
        if (!requestNode) throw new Error("No nodes are available.");

        const formattedQuery = /^https?:\/\//.test(query) ? query : `${searchSources}:${query}`;
        let response = await requestNode.rest.makeRequest("GET", `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`);

        // Fallback attempts if response loadType indicates no matches
        if (["empty", "NO_MATCHES"].includes(response.loadType)) {
            response = await this.handleNoMatches(requestNode.rest, query);
        }

        this.loadTracks(response, requester, requestNode);
        return this.constructResponse();
    }

    /**
     * Handles cases where no matches were found for a query.
     * @param {Object} rest - The REST client for making requests.
     * @param {string} query - The original query string.
     * @returns {Promise<Object>} The response object from the request.
     */
    async handleNoMatches(rest, query) {
        let response = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`);
        if (["empty", "NO_MATCHES"].includes(response.loadType)) {
            response = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`);
        }
        return response;
    }

    /**
     * Loads tracks from the resolved response.
     * @param {Object} response - The response from the track resolution.
     * @param {Object} requester - The requester of the tracks.
     * @param {Node} requestNode - The node that handled the request.
     */
    loadTracks(response, requester, requestNode) {
        this.tracks = [];
        if (response.loadType === "track") {
            if (response.data) {
                this.tracks.push(new Track(response.data, requester, requestNode));
            }
        } else if (response.loadType === "playlist") {
            this.tracks = response.data?.tracks.map(track => new Track(track, requester, requestNode)) || [];
            this.playlistInfo = response.data?.info || null;
        } else if (response.loadType === "search") {
            this.tracks = response.data.map(track => new Track(track, requester, requestNode));
        }
        this.loadType = response.loadType;
        this.pluginInfo = response.pluginInfo || {};
    }

    /**
     * Constructs the response object for the resolved tracks.
     * @returns {Object} The constructed response.
     */
    constructResponse() {
        return {
            loadType: this.loadType,
            exception: this.loadType === "error" ? this.loadType.data : (this.loadType === "LOAD_FAILED" ? this.loadType.exception : null),
            playlistInfo: this.playlistInfo,
            pluginInfo: this.pluginInfo,
            tracks: this.tracks.length ? [this.tracks.shift()] : [],
        };
    }

    /**
     * Gets the player associated with the specified guild ID.
     * @param {string} guildId - The ID of the guild.
     * @returns {Player} The player instance.
     * @throws {Error} If the player is not found.
     */
    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }

    /**
     * Cleans up idle players and nodes to free up resources.
     */
    cleanupIdle() {
        for (const [guildId, player] of this.players) {
            if (!player.playing && !player.paused && player.queue.isEmpty()) {
                player.destroy();
                this.players.delete(guildId);
                this.emit("playerDestroy", player);
            }
        }
    }
}

module.exports = { Aqua };
