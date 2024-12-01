const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json");

class Aqua extends EventEmitter {
    constructor(client, nodes, options) {
      super()
        // Input validation
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
        if (!node) return;

        node.disconnect();
        this.nodeMap.delete(identifier);
        this.emit("nodeDestroy", node);
    }

    updateVoiceState(packet) {
        if (!["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(packet.t)) return;

        const player = this.players.get(packet.d.guild_id);
        if (!player) return;

        if (packet.t === "VOICE_SERVER_UPDATE") {
            player.connection.setServerUpdate(packet.d);
        } else if (packet.t === "VOICE_STATE_UPDATE") {
            if (packet.d.user_id !== this.clientId) return;
            player.connection.setStateUpdate(packet.d);
        }
    }

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

    createConnection(options) {
        if (!this.initiated) throw new Error("BRO! Get aqua on before !!!");
        if (this.leastUsedNodes.length === 0) throw new Error("No nodes are available");
        const node = options.region 
            ? this.fetchRegion(options.region)[0] || this.leastUsedNodes[0]
            : this.leastUsedNodes[0];
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
        if (!player) return;

        player.destroy();
        this.players.delete(guildId);
        this.emit("playerDestroy", player);
    }

    removeConnection(guildId) {
        const player = this.players.get(guildId);
        if (player) {
            player.destroy();
            this.players.delete(guildId);
        }
    }

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

    async handleNoMatches(rest, query) {
        let response = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://open.spotify.com/track/${query}`);
        if (["empty", "NO_MATCHES"].includes(response.loadType)) {
            response = await rest.makeRequest("GET", `/v4/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`);
        }
        return response;
    }

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

    constructResponse() {
        return {
            loadType: this.loadType,
            exception: this.loadType === "error" ? this.loadType.data : (this.loadType === "LOAD_FAILED" ? this.loadType.exception : null),
            playlistInfo: this.playlistInfo,
            pluginInfo: this.pluginInfo,
            tracks: this.tracks.length ? [this.tracks.shift()] : [],
        };
    }

    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }
}

module.exports = { Aqua };


