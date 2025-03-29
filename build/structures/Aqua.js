"use strict";
const Node = require("./Node");
const Player = require("./Player");
const Track = require("./Track");
const { version: pkgVersion } = require("../../package.json");
const { EventEmitter } = require('eventemitter3');

const URL_REGEX = /^https?:\/\//;
const DEFAULT_OPTIONS = {
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: true,
  restVersion: 'v4',
  plugins: [],
  autoResume: false,
  infiniteReconnects: false
};
const LEAST_USED_CACHE_TTL = 50;

class Aqua extends EventEmitter {
    constructor(client, nodes, options = {}) {
        super();
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || !nodes.length) {
            throw new Error(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        }

        this.client = client;
        this.nodes = nodes;
        this.nodeMap = new Map();
        this.players = new Map();
        this.clientId = null;
        this.initiated = false;
        this.version = pkgVersion;
        
        this.options = { ...DEFAULT_OPTIONS, ...options };
        
        this.shouldDeleteMessage = this.options.shouldDeleteMessage;
        this.defaultSearchPlatform = this.options.defaultSearchPlatform;
        this.leaveOnEnd = this.options.leaveOnEnd;
        this.restVersion = this.options.restVersion;
        this.plugins = this.options.plugins;
        this.autoResume = this.options.autoResume;
        this.infiniteReconnects = this.options.infiniteReconnects;
        
        this.send = options.send || this.defaultSendFunction.bind(this);
        
        this._leastUsedCache = { nodes: [], timestamp: 0 };
    }

    defaultSendFunction(payload) {
        const guild = this.client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    }

    get leastUsedNodes() {
        const now = Date.now();
        if (now - this._leastUsedCache.timestamp < LEAST_USED_CACHE_TTL) {
            return this._leastUsedCache.nodes;
        }
        
        const connectedNodes = Array.from(this.nodeMap.values()).filter(node => node.connected);
        connectedNodes.sort((a, b) => a.rest.calls - b.rest.calls);
        
        this._leastUsedCache = { nodes: connectedNodes, timestamp: now };
        return connectedNodes;
    }

    async init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;
        
        try {
            const nodePromises = this.nodes.map(node => this.createNode(node));
            await Promise.all(nodePromises);
            
            this.plugins.forEach(plugin => plugin.load(this));
            
            this.initiated = true;
        } catch (error) {
            this.initiated = false;
            throw error;
        }
        
        return this;
    }

    async createNode(options) {
        const nodeId = options.name || options.host;
        this.destroyNode(nodeId);
        
        const node = new Node(this, options, this.options);
        this.nodeMap.set(nodeId, node);
        this._leastUsedCache.timestamp = 0;
        
        try {
            await node.connect();
            this.emit("nodeCreate", node);
            return node;
        } catch (error) {
            this.nodeMap.delete(nodeId);
            console.error("Failed to connect node:", error);
            throw error;
        }
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;
        
        node.destroy();
        this.nodeMap.delete(identifier);
        this._leastUsedCache.timestamp = 0;
        this.emit("nodeDestroy", node);
    }

    updateVoiceState({ d, t }) {
        const player = this.players.get(d.guild_id);
        if (!player) return;
        
        if (t === "VOICE_SERVER_UPDATE" || (t === "VOICE_STATE_UPDATE" && d.user_id === this.clientId)) {
            const updateMethod = t === "VOICE_SERVER_UPDATE" ? "setServerUpdate" : "setStateUpdate";
            
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
        
        player.once("destroy", () => {
            this.players.delete(options.guildId);
        });
        
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
            const endpoint = `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`;
            const response = await requestNode.rest.makeRequest("GET", endpoint);
            
            if (["empty", "NO_MATCHES"].includes(response.loadType)) {
                return await this.handleNoMatches(requestNode.rest, query);
            }
            
            return this.constructResponse(response, requester, requestNode);
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
        }
    }

    getRequestNode(nodes) {
        if (!nodes) return this.leastUsedNodes[0];
        
        if (!(typeof nodes === "string" || nodes instanceof Node)) {
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
            const ytEndpoint = `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`;
            const youtubeResponse = await rest.makeRequest("GET", ytEndpoint);
            
            if (!["empty", "NO_MATCHES"].includes(youtubeResponse.loadType)) {
                return youtubeResponse;
            }
            
            const spotifyEndpoint = `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`;
            return await rest.makeRequest("GET", spotifyEndpoint);
        } catch (error) {
            console.error(`Failed to resolve track: ${error.message}`);
            throw error;
        }
    }

    constructResponse(response, requester, requestNode) {
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
                        ...response.data.info
                    };
                }

                const tracks = response.data?.tracks;
                if (tracks?.length) {
                    baseResponse.tracks = tracks.map(trackFactory);
                }
                break;

            case "search":
                const searchData = response.data ?? [];
                if (searchData.length) {
                    baseResponse.tracks = searchData.map(trackFactory);
                }
                break;
        }
        
        return baseResponse;
    }

    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }

    async search(query, requester, source = this.defaultSearchPlatform) {
        if (!query || !requester) return null;
        
        try {
            const { tracks } = await this.resolve({ query, source, requester });
            return tracks || null;
        } catch (error) {
            console.error("Search error:", error);
            return null;
        }
    }

    async cleanupPlayer(player) {
        if (!player) return;
        
        try {
            if (player.connection) {
                try {
                    await player.connection.disconnect();
                    player.connection = null;
                } catch (error) {
                    console.error(`Error disconnecting player connection: ${error.message}`);
                }
            }
            
            if (player.queue) {
                player.queue.clear();
            }
            
            if (typeof player.stop === 'function') {
                try {
                    await player.stop();
                } catch (error) {
                    console.error(`Error stopping player: ${error.message}`);
                }
            }
            
            player.removeAllListeners();
            this.players.delete(player.guildId);
            this.emit("playerCleanup", player.guildId);
        } catch (error) {
            console.error(`Error during player cleanup: ${error.message}`);
        }
    }
}

module.exports = Aqua;
