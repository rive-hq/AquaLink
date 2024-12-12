const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json");

class Aqua extends EventEmitter {
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
        this.restVersion = options.restVersion || "v3";
        this.plugins = options.plugins || [];
        this.version = pkgVersion;
        this.options = options;
        this.send = options.send;
    }

    validateInputs(client, nodes, options) {
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        if (typeof options.send !== "function") throw new Error("Send function is required to initialize Aqua");
    }

    get leastUsedNodes() {
        return [...this.nodeMap.values()]
            .filter(node => node.connected)
            .sort((a, b) => a.rest.calls - b.rest.calls);
    }

    init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;
        this.nodes.forEach(nodeConfig => this.createNode(nodeConfig));
        this.initiated = true;
        this.plugins.forEach(plugin => plugin.load(this));
        return this;
    }

    createNode(options) {
        const node = new Node(this, options, this.options);
        this.nodeMap.set(options.name || options.host, node);
        node.connect();
        this.emit("nodeCreate", node);
        return node;
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (node) {
            node.disconnect();
            this.nodeMap.delete(identifier);
            this.emit("nodeDestroy", node);
        }
    }

    updateVoiceState(packet) {
        const player = this.players.get(packet.d.guild_id);
        if (player) {
            if (packet.t === "VOICE_SERVER_UPDATE") {
                player.connection.setServerUpdate(packet.d);
            } else if (packet.t === "VOICE_STATE_UPDATE" && packet.d.user_id === this.clientId) {
                player.connection.setStateUpdate(packet.d);
            }
        }
    }

    fetchRegion(region) {
        const lowerRegion = region?.toLowerCase();
        return [...this.nodeMap.values()]
            .filter(node => node.connected && node.regions?.includes(lowerRegion))
            .sort((a, b) => this.calculateLoad(a) - this.calculateLoad(b));
    }

    calculateLoad(node) {
        return node.stats.cpu ? (node.stats.cpu.systemLoad / node.stats.cpu.cores) * 100 : 0;
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
        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);
        player.connect(options);
        this.emit("playerCreate", player);
        return player;
    }

    destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (player) {
            player.clearData();
            player.destroy();
            this.players.delete(guildId);
            this.emit("playerDestroy", player);
        }
    }

/** 
 * Resolves a track or playlist based on the provided query and returns the response. 
 * Ensures that Aqua is initialized before proceeding. 
 * 
 * @param {Object} params 
 * @param {string} params.query - The search query or URL to resolve. 
 * @param {string} [params.source] - The source platform for the search (e.g., "ytsearch"). 
 * @param {Object} params.requester - The user or entity requesting the track. 
 * @param {string|Node} [params.nodes] - Optional specific node or node identifier to use for the request. 
 * @returns {Promise<Object>} The response containing track or playlist information. 
 * @throws {Error} If Aqua is not initialized. 
 */ 
    async resolve({ query, source, requester, nodes }) {
        this.ensureInitialized();
        const requestNode = this.getRequestNode(nodes);
        const formattedQuery = this.formatQuery(query, source || this.defaultSearchPlatform);
        
        try {
            let response = await requestNode.rest.makeRequest("GET", `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`);
            if (["empty", "NO_MATCHES"].includes(response.loadType)) {
                response = await this.handleNoMatches(requestNode.rest, query);
            }
            return this.constructorResponse(response, requester, requestNode);
        } catch (error) {
            console.error("Error resolving track:", error);
            throw new Error("Failed to resolve track");
        }
    }

    ensureInitialized() {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");
    }

    getRequestNode(nodes) {
        if (nodes && (typeof nodes !== "string" && !(nodes instanceof Node))) {
            throw new Error(`'nodes' must be a string or Node instance, but received: ${typeof nodes}`);
        }
        return (typeof nodes === 'string' ? this.nodeMap.get(nodes) : nodes) || this.leastUsedNodes[0];
    }

    formatQuery(query, source) {
        return /^https?:\/\//.test(query) ? query : `${source}:${query}`;
    }

    async handleNoMatches(rest, query) {
        try {
            const spotifyResponse = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`);
            if (["empty", "NO_MATCHES"].includes(spotifyResponse.loadType)) {
                return await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`);
            }
            return spotifyResponse;
        } catch (error) {
            console.error("Error handling no matches:", error);
            throw new Error("Failed to handle no matches");
        }
    }

    constructorResponse(response, requester, requestNode) {
        const baseResponse = {
            loadType: response.loadType,
            exception: null,
            playlistInfo: null,
            pluginInfo: response.pluginInfo || {},
            tracks: [],
        };

        switch (response.loadType) {
            case "track":
                if (response.data) {
                    baseResponse.tracks.push(new Track(response.data, requester, requestNode));
                }
                break;
            case "playlist":
                baseResponse.playlistInfo = {
                    name: response.data?.info?.name || response.data?.info?.title,
                    ...response.data?.info,
                };
                baseResponse.tracks = response.data?.tracks?.map(track => new Track(track, requester, requestNode)) || [];
                break;
            case "search":
                baseResponse.tracks = response.data?.map(track => new Track(track, requester, requestNode)) || [];
                break;
        }

        if (response.loadType === "error" || response.loadType === "LOAD_FAILED") {
            baseResponse.exception = response.loadType.data || response.loadType.exception;
        }

        return baseResponse;
    }

    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }

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
