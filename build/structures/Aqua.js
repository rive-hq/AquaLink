'use strict';

const { promises: fs } = require('node:fs');
const { EventEmitter } = require('tseep');

const Node = require('./Node');
const Player = require('./Player');
const Track = require('./Track');
const { version: pkgVersion } = require('../../package.json');

const URL_PATTERN = /^https?:\/\//;
const SEARCH_PREFIX = ':';
const REQUESTER_PATTERN = /^([^:]+):(.+)$/;

const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_TRACKS_RESPONSE = Object.freeze({
  loadType: 'empty',
  exception: null,
  playlistInfo: null,
  pluginInfo: {},
  tracks: EMPTY_ARRAY
});


const DEFAULT_OPTIONS = Object.freeze({
  shouldDeleteMessage: false,
  defaultSearchPlatform: 'ytsearch',
  leaveOnEnd: true,
  restVersion: 'v4',
  plugins: [],
  autoResume: false,
  infiniteReconnects: false,
  failoverOptions: Object.freeze({
    enabled: true,
    maxRetries: 3,
    retryDelay: 1000,
    preservePosition: true,
    resumePlayback: true,
    cooldownTime: 5000,
    maxFailoverAttempts: 5
  })
});

const CLEANUP_INTERVAL = 60000;
const MAX_CONCURRENT_OPS = 4;
const BROKEN_PLAYER_TTL = 300000;
const FAILOVER_CLEANUP_TTL = 600000;
const NODE_BATCH_SIZE = 3;
const PLAYER_BATCH_SIZE = 8;
const SEEK_DELAY = 150;
const RECONNECT_DELAY = 800;
const NODE_CHECK_INTERVAL = 100;
const CACHE_VALID_TIME = 5000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Aqua extends EventEmitter {
  constructor(client, nodes, options = {}) {
    super();
    if (!client) throw new Error('Client is required');
    if (!Array.isArray(nodes) || !nodes.length) throw new TypeError('Nodes must be non-empty Array');

    this.client = client;
    this.nodes = nodes;
    this.nodeMap = new Map();
    this.players = new Map();
    this.clientId = null;
    this.initiated = false;
    this.version = pkgVersion;

    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
    this.failoverOptions = Object.assign({}, DEFAULT_OPTIONS.failoverOptions, options.failoverOptions);

    Object.assign(this, {
      shouldDeleteMessage: this.options.shouldDeleteMessage,
      defaultSearchPlatform: this.options.defaultSearchPlatform,
      leaveOnEnd: this.options.leaveOnEnd,
      restVersion: this.options.restVersion,
      plugins: this.options.plugins,
      autoResume: this.options.autoResume,
      infiniteReconnects: this.options.infiniteReconnects,
      send: this.options.send || this._defaultSend
    });

    this._nodeStates = new Map();
    this._failoverQueue = new Map();
    this._lastFailoverAttempt = new Map();
    this._brokenPlayers = new Map();

    this._leastUsedNodesCache = null;
    this._leastUsedNodesCacheTime = 0;

    this._bindEventHandlers();
    this._startCleanupTimer();
  }

  _defaultSend = packet => {
    const guildId = packet.d.guild_id;
    const guild = this.client.cache?.guilds.get(guildId) ?? this.client.guilds?.cache?.get(guildId);
    if (!guild) return;

    const gateway = this.client.gateway;
    if (gateway) {
      gateway.send(gateway.calculateShardId(guildId), packet);
    } else if (guild.shard) {
      guild.shard.send(packet);
    }
  };

  _bindEventHandlers() {
    this.on('nodeConnect', node => this.autoResume && queueMicrotask(() => this._rebuildBrokenPlayers(node)));
    this.on('nodeDisconnect', node => this.autoResume && queueMicrotask(() => this._storeBrokenPlayers(node)));
  }

  _startCleanupTimer() {
    this._cleanupTimer = setInterval(() => this._performCleanup(), CLEANUP_INTERVAL);
    this._cleanupTimer.unref();
  }

  get leastUsedNodes() {
    const now = Date.now();
    if (this._leastUsedNodesCache && (now - this._leastUsedNodesCacheTime) < CACHE_VALID_TIME) {
      return this._leastUsedNodesCache;
    }

    const connectedNodes = [];
    for (const node of this.nodeMap.values()) {
      if (node.connected) connectedNodes.push(node);
    }

    if (connectedNodes.length > 1) {
      for (let i = 1; i < connectedNodes.length; i++) {
        const current = connectedNodes[i];
        const calls = current.rest?.calls || 0;
        let j = i - 1;

        while (j >= 0 && (connectedNodes[j].rest?.calls || 0) > calls) {
          connectedNodes[j + 1] = connectedNodes[j];
          j--;
        }
        connectedNodes[j + 1] = current;
      }
    }

    this._leastUsedNodesCache = connectedNodes;
    this._leastUsedNodesCacheTime = now;
    return connectedNodes;
  }

  async init(clientId) {
    if (this.initiated) return this;
    this.clientId = clientId;
    let successCount = 0;

    for (let i = 0; i < this.nodes.length; i += NODE_BATCH_SIZE) {
      const batch = this.nodes.slice(i, i + NODE_BATCH_SIZE);
      successCount += await this._processNodeBatch(batch);
    }

    if (!successCount) throw new Error('No nodes connected');

    await this._loadPlugins();
    this.initiated = true;
    return this;
  }

  async _processNodeBatch(batch) {
    const results = await Promise.allSettled(batch.map(n => this._createNode(n)));
    return results.filter(r => r.status === 'fulfilled').length;
  }

  async _loadPlugins() {
    const pluginPromises = this.plugins.map(plugin => {
      return plugin.load(this).catch(err => {
        this.emit('error', null, new Error(`Plugin error: ${err.message}`));
      });
    });
    await Promise.all(pluginPromises);
  }

  async _createNode(options) {
    const nodeId = options.name || options.host;
    this._destroyNode(nodeId);

    const node = new Node(this, options, this.options);
    node.players = new Set();

    this.nodeMap.set(nodeId, node);
    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });

    try {
      await node.connect();
      this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false });
      this.emit('nodeCreate', node);
      return node;
    } catch (error) {
      this._cleanupNode(nodeId);
      throw error;
    }
  }

  _storeBrokenPlayers(node) {
    const nodeId = node.name || node.host;
    const now = Date.now();

    for (const player of this.players.values()) {
      if (player.nodes !== node) continue;

      const state = this._capturePlayerState(player);
      if (state) {
        state.originalNodeId = nodeId;
        state.brokenAt = now;
        this._brokenPlayers.set(player.guildId, state);
      }
    }
  }

  _rebuildBrokenPlayers(node) {
    const nodeId = node.name || node.host;
    let rebuiltCount = 0;
    const toDelete = [];

    for (const [guildId, brokenState] of this._brokenPlayers) {
      if (brokenState.originalNodeId !== nodeId) continue;

      this._rebuildPlayer(brokenState, node)
        .then(() => {
          toDelete.push(guildId);
          rebuiltCount++;
        })
        .catch(() => {
          if (Date.now() - brokenState.brokenAt > BROKEN_PLAYER_TTL) {
            toDelete.push(guildId);
          }
        });
    }

    for (const guildId of toDelete) {
      this._brokenPlayers.delete(guildId);
    }

    if (rebuiltCount) this.emit('playersRebuilt', node, rebuiltCount);
  }

  async _rebuildPlayer(brokenState, targetNode) {
    const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState;
    const existingPlayer = this.players.get(guildId);
    if (existingPlayer) await existingPlayer.destroy();

    await delay(RECONNECT_DELAY);

    try {
      const player = await this.createConnection({
        guildId,
        textChannel,
        voiceChannel,
        defaultVolume: volume,
        deaf
      });

      if (current) {
        await player.queue.add(current);
        await player.play();
        if (brokenState.position > 0) {
          setTimeout(() => player.seek(brokenState.position), SEEK_DELAY);
        }
        if (brokenState.paused) player.pause();
        this.emit('trackStart', player, current);
      }
    } catch {
      this._brokenPlayers.delete(guildId);
    }
  }

  _destroyNode(identifier) {
    const node = this.nodeMap.get(identifier);
    if (node) {
      this._cleanupNode(identifier);
      this.emit('nodeDestroy', node);
    }
  }

  _cleanupNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (node) {
      node.removeAllListeners();
      this.nodeMap.delete(nodeId);
    }

    this._nodeStates.delete(nodeId);
    this._failoverQueue.delete(nodeId);
    this._lastFailoverAttempt.delete(nodeId);
    this._invalidateCache();
  }

  _invalidateCache() {
    this._leastUsedNodesCache = null;
    this._leastUsedNodesCacheTime = 0;
  }

  async handleNodeFailover(failedNode) {
    if (!this.failoverOptions.enabled) return;

    const nodeId = failedNode.name || failedNode.host;
    const now = Date.now();
    const nodeState = this._nodeStates.get(nodeId);

    if (nodeState?.failoverInProgress) return;

    const lastAttempt = this._lastFailoverAttempt.get(nodeId);
    if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return;

    const attempts = this._failoverQueue.get(nodeId) || 0;
    if (attempts >= this.failoverOptions.maxFailoverAttempts) return;

    this._nodeStates.set(nodeId, { connected: false, failoverInProgress: true });
    this._lastFailoverAttempt.set(nodeId, now);
    this._failoverQueue.set(nodeId, attempts + 1);

    try {
      this.emit('nodeFailover', failedNode);
      const affectedPlayers = Array.from(failedNode.players);

      if (!affectedPlayers.length) {
        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });
        return;
      }

      const availableNodes = this._getAvailableNodes(failedNode);
      if (!availableNodes.length) {
        this.emit('error', null, new Error('No failover nodes available'));
        return;
      }

      const results = await this._migratePlayersOptimized(affectedPlayers, availableNodes);
      const successful = results.filter(r => r.success).length;

      if (successful) {
        this.emit('nodeFailoverComplete', failedNode, successful, results.length - successful);
      }
    } catch (error) {
      this.emit('error', null, new Error(`Failover failed: ${error.message}`));
    } finally {
      this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });
    }
  }

  async _migratePlayersOptimized(players, availableNodes) {
    const results = [];
    for (let i = 0; i < players.length; i += MAX_CONCURRENT_OPS) {
      const batch = players.slice(i, i + MAX_CONCURRENT_OPS);
      const batchResults = await Promise.allSettled(
        batch.map(p => this._migratePlayer(p, availableNodes))
      );
      results.push(...batchResults.map(r => ({
        success: r.status === 'fulfilled',
        error: r.reason
      })));
    }
    return results;
  }

  async _migratePlayer(player, availableNodes) {
    let retryCount = 0;
    while (retryCount < this.failoverOptions.maxRetries) {
      try {
        const targetNode = availableNodes[0];
        const playerState = this._capturePlayerState(player);
        if (!playerState) throw new Error('Failed to capture state');

        const newPlayer = await this._createPlayerOnNode(targetNode, playerState);
        await this._restorePlayerState(newPlayer, playerState);
        this.emit('playerMigrated', player, newPlayer, targetNode);
        return newPlayer;
      } catch (error) {
        retryCount++;
        if (retryCount >= this.failoverOptions.maxRetries) throw error;
        await delay(this.failoverOptions.retryDelay);
      }
    }
  }

  _capturePlayerState(player) {
    try {
      return {
        guildId: player.guildId,
        textChannel: player.textChannel,
        voiceChannel: player.voiceChannel,
        volume: player.volume || 100,
        paused: player.paused || false,
        position: player.position || 0,
        current: player.current || null,
        queue: player.queue?.tracks?.slice(0, 10) || EMPTY_ARRAY,
        repeat: player.loop,
        shuffle: player.shuffle,
        deaf: player.deaf || false,
        connected: player.connected || false
      };
    } catch {
      return null;
    }
  }

  async _createPlayerOnNode(targetNode, playerState) {
    return this.createPlayer(targetNode, {
      guildId: playerState.guildId,
      textChannel: playerState.textChannel,
      voiceChannel: playerState.voiceChannel,
      defaultVolume: playerState.volume || 100,
      deaf: playerState.deaf || false
    });
  }

  async _restorePlayerState(newPlayer, playerState) {
    if (playerState.volume !== undefined) newPlayer.setVolume(playerState.volume);
    if (playerState.queue?.length) newPlayer.queue.add(...playerState.queue);

    if (playerState.current && this.failoverOptions.preservePosition) {
      newPlayer.queue.unshift(playerState.current);
      if (this.failoverOptions.resumePlayback) {
        await newPlayer.play();
        if (playerState.position > 0) {
          setTimeout(() => newPlayer.seek(playerState.position), SEEK_DELAY);
        }
        if (playerState.paused) newPlayer.pause();
      }
    }

    newPlayer.repeat = playerState.repeat;
    newPlayer.shuffle = playerState.shuffle;
  }

  _cleanupPlayer(player) {
    if (!player) return;
    player.destroy();
    player.voiceChannel = null;
    this.emit('playerDestroy', player);
  }

  updateVoiceState({ d, t }) {
    if (!d.guild_id || (t !== 'VOICE_STATE_UPDATE' && t !== 'VOICE_SERVER_UPDATE')) return;

    const player = this.players.get(d.guild_id);
    if (!player) return;

    if (t === 'VOICE_STATE_UPDATE') {
      if (d.user_id !== this.clientId) return;
      if (!d.channel_id) return this._cleanupPlayer(player);

      if (!player.connection?.sessionId && d.session_id) {
        player.connection.sessionId = d.session_id;
        return;
      }

      if (d.session_id && player.connection && player.connection.sessionId !== d.session_id) {
        player.connection.sessionId = d.session_id;
        this.emit('debug', `[Player ${player.guildId}] Session updated to ${d.session_id}`);
      }

      player.connection.setStateUpdate(d);
    } else {
      player.connection.setServerUpdate(d);
    }
  }

  fetchRegion(region) {
    if (!region) return this.leastUsedNodes;

    const lowerRegion = region.toLowerCase();
    const filtered = [];

    for (const node of this.nodeMap.values()) {
      if (node.connected && node.regions?.includes(lowerRegion)) {
        filtered.push(node);
      }
    }

    return filtered.sort((a, b) => this._getNodeLoad(a) - this._getNodeLoad(b));
  }

  _getNodeLoad(node) {
    const stats = node?.stats?.cpu;
    return stats ? (stats.systemLoad / stats.cores) * 100 : 0;
  }

  createConnection(options) {
    if (!this.initiated) throw new Error('Aqua not initialized');

    const existingPlayer = this.players.get(options.guildId);
    if (existingPlayer?.voiceChannel) return existingPlayer;

    const availableNodes = options.region ?
      this.fetchRegion(options.region) :
      this.leastUsedNodes;

    if (!availableNodes.length) throw new Error('No nodes available');

    return this.createPlayer(availableNodes[0], options);
  }

  createPlayer(node, options) {
    this.destroyPlayer(options.guildId);
    const player = new Player(this, node, options);
    this.players.set(options.guildId, player);
    player.once('destroy', this._handlePlayerDestroy.bind(this));
    player.connect(options);
    this.emit('playerCreate', player);
    return player;
  }

  _handlePlayerDestroy(player) {
    const node = player.nodes;
    node?.players?.delete(player);
    this.players.delete(player.guildId);
    this.emit('playerDestroy', player);
  }

  async destroyPlayer(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;

    try {
      await player.clearData();
      player.removeAllListeners();
      this.players.delete(guildId);
      this.nodes.rest.destroyPlayer(guildId);
      this.emit('playerDestroy', player);
    } catch { }
  }

  async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
    if (!this.initiated) throw new Error('Aqua not initialized');

    const requestNode = this._getRequestNode(nodes);
    const formattedQuery = URL_PATTERN.test(query) ?
      query :
      `${source}${SEARCH_PREFIX}${query}`;

    try {
      const endpoint = `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`;
      const response = await requestNode.rest.makeRequest('GET', endpoint);

      if (['empty', 'NO_MATCHES'].includes(response.loadType)) {
        return EMPTY_TRACKS_RESPONSE;
      }

      return this._constructResponse(response, requester, requestNode);
    } catch (error) {
      throw new Error(error.name === 'AbortError' ?
        'Request timeout' :
        `Resolve failed: ${error.message}`
      );
    }
  }

  _getRequestNode(nodes) {
    if (!nodes) return this.leastUsedNodes[0];
    if (nodes instanceof Node) return nodes;
    if (typeof nodes === 'string') return this.nodeMap.get(nodes) || this.leastUsedNodes[0];
    throw new TypeError(`Invalid nodes parameter: ${typeof nodes}`);
  }

  _constructResponse(response, requester, requestNode) {
    const baseResponse = {
      loadType: response.loadType,
      exception: null,
      playlistInfo: null,
      pluginInfo: response.pluginInfo || {},
      tracks: []
    };

    if (response.loadType === 'error' || response.loadType === 'LOAD_FAILED') {
      baseResponse.exception = response.data || response.exception;
      return baseResponse;
    }

    switch (response.loadType) {
      case 'track':
        if (response.data) {
          baseResponse.tracks.push(new Track(response.data, requester, requestNode));
        }
        break;

      case 'playlist': {
        const info = response.data?.info;
        if (info) {
          baseResponse.playlistInfo = {
            name: info.name || info.title,
            thumbnail: response.data.pluginInfo?.artworkUrl ||
              response.data.tracks?.[0]?.info?.artworkUrl ||
              null,
            ...info
          };
        }

        const tracks = response.data?.tracks;
        if (tracks?.length) {
          baseResponse.tracks = tracks.map(t => new Track(t, requester, requestNode));
        }
        break;
      }

      case 'search': {
        const searchData = response.data || EMPTY_ARRAY;
        if (searchData.length) {
          baseResponse.tracks = searchData.map(t => new Track(t, requester, requestNode));
        }
        break;
      }
    }

    return baseResponse;
  }

  get(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error(`Player not found: ${guildId}`);
    return player;
  }

  async search(query, requester, source = this.defaultSearchPlatform) {
    if (!query || !requester) return null;
    try {
      const { tracks } = await this.resolve({ query, source, requester });
      return tracks || null;
    } catch {
      return null;
    }
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    try {
      await fs.access(filePath);
      await this._waitForFirstNode();
      const rawData = await fs.readFile(filePath, 'utf8');
      const lines = rawData.trim().split('\n').filter(Boolean);

      for (let i = 0; i < lines.length; i += PLAYER_BATCH_SIZE) {
        const batch = lines.slice(i, i + PLAYER_BATCH_SIZE)
          .map(line => JSON.parse(line));

        await Promise.all(batch.map(p => this._restorePlayer(p)));
      }

      await fs.writeFile(filePath, '', 'utf8');
    } catch { }
  }

  async savePlayer(filePath = './AquaPlayers.jsonl') {
    const lines = [];

    for (const player of this.players.values()) {
      const requester = player.requester || player.current?.requester;

      const compactData = {
        g: player.guildId,
        t: player.textChannel,
        v: player.voiceChannel,
        u: player.current?.uri || null,
        p: player.position || 0,
        ts: player.timestamp || 0,
        q: player.queue?.tracks?.slice(0, 5).map(tr => tr.uri) || EMPTY_ARRAY,
        r: requester ? `${requester.id}:${requester.username}` : null,
        vol: player.volume,
        pa: player.paused,
        pl: player.playing,
        nw: player.nowPlayingMessage?.id || null
      };
      lines.push(JSON.stringify(compactData));
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
    this.emit('debug', 'Aqua', `Saved ${lines.length} players to ${filePath}`);
  }

async _restorePlayer(p) {
  try {
    let player = this.players.get(p.g);
    if (!player) {
      const targetNode = this.leastUsedNodes[0];
      if (!targetNode) return;

      player = await this.createConnection({
        guildId: p.g,
        textChannel: p.t,
        voiceChannel: p.v,
        defaultVolume: p.vol || 65,
        deaf: true
      });
    }

    if (p.u && player) {
      const resolved = await this.resolve({
        query: p.u,
        requester: this._parseRequester(p.r)
      });
      if (resolved.tracks?.[0]) {
        player.queue.add(resolved.tracks[0]);
        player.position = p.p || 0;
        player.paused = !!p.pa;
      }
    }

    if (p.nw && player) {
      let message = this.client.cache.messages.get(p.nw);
      if (!message) {
        const channel = this.client.cache.channels.get(p.t);
        if (channel) {
          try {
           if (channel.client.messages) {
              message = await channel.client.messages.fetch(p.nw, channel.id).catch(() => null);
           } else {
              message = await this.client.messages.fetch(channel.id, p.nw).catch(() => null);
           }
          } catch (error) {
            this.emit('debug', 'Aqua', `Failed to fetch nowPlayingMessage ${p.nw} for guild ${p.g}: ${error.message}`);
          }
        }
      }
      player.nowPlayingMessage = message || null;
    }

    if (p.q?.length && player) {
      const tracks = await Promise.all(
        p.q.filter(uri => uri !== p.u).map(uri => this.resolve({ query: uri, requester: p.r }))
      ).then(resolved => resolved.flatMap(r => r.tracks));

      for (const track of tracks) {
        player.queue.add(track);
      }
    }

    if (player) {
      if (typeof p.vol === 'number') player.volume = p.vol;
      player.paused = !!p.pa;
      if (p.u && player.queue.size > 0) {
        player.play();
        player.seek(p.p || 0);
      }
    }

    this.emit("playerRestore", player);
  } catch (error) {
    this.emit('debug', 'Aqua', `Error restoring player for guild ${p.g}: ${error.message}`);
  }
}

  _parseRequester(requesterString) {
    if (!requesterString) return null;
    const match = REQUESTER_PATTERN.exec(requesterString);
    return match ? { id: match[1], username: match[2] } : null;
  }

  async _waitForFirstNode() {
    if (this.leastUsedNodes.length) return;

    return new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (this.leastUsedNodes.length) {
          clearInterval(checkInterval);
          resolve();
        }
      }, NODE_CHECK_INTERVAL);
    });
  }

  _performCleanup() {
    const now = Date.now();

    for (const [guildId, state] of this._brokenPlayers) {
      if (now - state.brokenAt > BROKEN_PLAYER_TTL) {
        this._brokenPlayers.delete(guildId);
      }
    }

    for (const [nodeId, timestamp] of this._lastFailoverAttempt) {
      if (now - timestamp > FAILOVER_CLEANUP_TTL) {
        this._lastFailoverAttempt.delete(nodeId);
        this._failoverQueue.delete(nodeId);
      }
    }

    this._invalidateCache();
  }

  _getAvailableNodes(excludeNode) {
    const available = [];
    for (const node of this.nodeMap.values()) {
      if (node !== excludeNode && node.connected) {
        available.push(node);
      }
    }
    return available;
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    for (const player of this.players.values()) {
      player.destroy();
    }

    for (const node of this.nodeMap.values()) {
      node.removeAllListeners();
    }

    this.removeAllListeners();
    this.players.clear();
    this.nodeMap.clear();
    this._nodeStates.clear();
    this._failoverQueue.clear();
    this._lastFailoverAttempt.clear();
    this._brokenPlayers.clear();
  }
}

module.exports = Aqua;
