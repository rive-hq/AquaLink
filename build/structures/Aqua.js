"use strict";

const { EventEmitter } = require("node:events");
const Node = require("./Node");
const Player = require("./Player");
const Track = require("./Track");
const { version: pkgVersion } = require("../../package.json");
const URL_REGEX = /^https?:\/\//;

class Aqua extends EventEmitter {
    constructor(client, nodes, options = {}) {
        super();
        this.validateInputs(client, nodes, options);
        this.client = client;
        this.nodes = nodes;
        this.nodeMap = new Map();
        this.players = new Map();
        this.clientId = null;
        this.initiated = false;
        this.options = options;
        this.shouldDeleteMessage = this.getOption(options, 'shouldDeleteMessage', false);
        this.defaultSearchPlatform = this.getOption(options, 'defaultSearchPlatform', 'ytsearch');
        this.leaveOnEnd = this.getOption(options, 'leaveOnEnd', true);
        this.restVersion = this.getOption(options, 'restVersion', 'v4');
        this.plugins = this.getOption(options, 'plugins', []);
        this.version = pkgVersion;
        this.send = options.send || this.defaultSendFunction;
        this.autoResume = this.getOption(options, 'autoResume', false);
        this.infiniteReconnects = this.getOption(options, 'infiniteReconnects', false);
        this.setMaxListeners(0);
        this._leastUsedCache = { nodes: [], timestamp: 0 };
    }

    getOption(options, key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : defaultValue;
    }

    defaultSendFunction(payload) {
        const guild = this.client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    }

    validateInputs(client, nodes) {
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || !nodes.length) {
            throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        }
    }

    get leastUsedNodes() {
        const now = Date.now();
        if (now - this._leastUsedCache.timestamp < 50) return this._leastUsedCache.nodes;

        const nodes = [];
        for (const node of this.nodeMap.values()) {
            if (node.connected) nodes.push(node);
        }
        nodes.sort((a, b) => a.rest.calls - b.rest.calls);

        this._leastUsedCache = { nodes, timestamp: now };
        return nodes;
    }

    init(clientId) {
        if (this.initiated) return this;

        this.clientId = clientId;
        try {
            this.nodes.forEach(nodeConfig => this.createNode(nodeConfig));
            this.plugins.forEach(plugin => plugin.load(this));
            this.initiated = true;
        } catch (error) {
            this.initiated = false;
            throw error;
        }

        return this;
    }

    createNode(options) {
        const nodeId = options.name || options.host;
        this.destroyNode(nodeId);

        const node = new Node(this, options, this.options);
        this.nodeMap.set(nodeId, node);
        this._leastUsedCache.timestamp = 0;

        node.connect()
            .then(() => this.emit("nodeCreate", node))
            .catch(error => {
                this.nodeMap.delete(nodeId);
                console.error("Failed to connect node:", error);
                throw error;
            });

        return node;
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;

        node.destroy();
        this.nodeMap.delete(identifier);
        this.emit("nodeDestroy", node);
    }


    updateVoiceState({ d, t }) {
        const player = this.players.get(d.guild_id);
        if (!player) return;

        const updateMethod = t === "VOICE_SERVER_UPDATE" ? "setServerUpdate" : "setStateUpdate";
        if (t === "VOICE_SERVER_UPDATE" || (t === "VOICE_STATE_UPDATE" && d.user_id === this.clientId)) {
            if (player.connection && typeof player.connection[updateMethod] === "function") {
                player.connection[updateMethod](d);
            }
            if (d.channel_id === null) {
                this.cleanupPlayer(player);
            }
        }
    }

    fetchRegion(region) {
        if (!region) return this.leastUsedNodes;

        const lowerRegion = region.toLowerCase();
        const regionNodes = Array.from(this.nodeMap.values()).filter(node => 
            node.connected && node.regions?.includes(lowerRegion)
        );
        regionNodes.sort((a, b) => this.calculateLoad(a) - this.calculateLoad(b));

        return regionNodes;
    }

    calculateLoad(node) {
        if (!node?.stats?.cpu) return 0;
        const { systemLoad, cores } = node.stats.cpu;
        return (systemLoad / cores) * 100;
    }

    createConnection(options) {
        this.ensureInitialized();
        const existingPlayer = this.players.get(options.guildId);
        if (existingPlayer && existingPlayer.voiceChannel) return existingPlayer;

        const availableNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes;
        const node = availableNodes[0];
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
            await player.clearData();
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
            if (error.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
        }
    }

    getRequestNode(nodes) {
        if (nodes && !(typeof nodes === "string" || nodes instanceof Node)) {
            throw new TypeError(`'nodes' must be a string or Node instance, received: ${typeof nodes}`);
        }
        return (typeof nodes === "string" ? this.nodeMap.get(nodes) : nodes) ?? this.leastUsedNodes[0];
    }

    ensureInitialized() {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");
    }

    formatQuery(query, source) {
        return URL_REGEX.test(query) ? query : `${source}:${query}`;
    }

    async handleNoMatches(rest, query) {
        try {
            const ytIdentifier = `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`;
            const youtubeResponse = await rest.makeRequest("GET", ytIdentifier);
            if (["empty", "NO_MATCHES"].includes(youtubeResponse.loadType)) {
                const spotifyIdentifier = `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`;
                return await rest.makeRequest("GET", spotifyIdentifier);
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
            tracks: []
        };

        if (response.loadType === "error" || response.loadType === "LOAD_FAILED") {
            baseResponse.exception = response.data ?? response.exception;
            return baseResponse;
        }

        const trackFactory = trackData => new Track(trackData, requester, requestNode);

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
                        ...response.data.info
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

    cleanupPlayer(player) {
        if (player && this.players.has(player.guildId)) {
            this.players.delete(player.guildId);
        }
    }
}

module.exports = Aqua;
