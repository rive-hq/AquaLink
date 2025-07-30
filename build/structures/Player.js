"use strict";

const { EventEmitter } = require('tseep');
const Connection = require("./Connection");
const Queue = require("./Queue");
const Filters = require("./Filters");
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay');

const LOOP_MODES = Object.freeze({
    NONE: "none", TRACK: "track", QUEUE: "queue"
});

const EVENT_HANDLERS = Object.freeze({
    TrackStartEvent: "trackStart",
    TrackEndEvent: "trackEnd",
    TrackExceptionEvent: "trackError",
    TrackStuckEvent: "trackStuck",
    TrackChangeEvent: "trackChange",
    WebSocketClosedEvent: "socketClosed",
    LyricsLineEvent: "lyricsLine",
    LyricsFoundEvent: "lyricsFound",
    LyricsNotFoundEvent: "lyricsNotFound"
});

// Use Sets for O(1) lookups
const VALID_MODES = new Set(Object.values(LOOP_MODES));
const FAILURE_REASONS = new Set(["LOAD_FAILED", "CLEANUP"]);
const RECONNECT_CODES = new Set([4015, 4009]);
const FAIL_LOAD_TYPES = new Set(["error", "empty", "LOAD_FAILED", "NO_MATCHES"]);

class OptimizedUpdateBatcher {
    constructor(player) {
        this.player = player;
        this.updates = Object.create(null); // Faster than {}
        this.timeoutId = 0;
        this.hasPending = false;
    }

    batch(data, immediate = false) {
        // Merge updates efficiently
        for (const key in data) {
            this.updates[key] = data[key];
        }
        this.hasPending = true;

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = 0;
        }

        if (immediate || data.track) {
            return this._flush();
        }

        this.timeoutId = setTimeout(() => this._flush(), 32);
        return Promise.resolve();
    }

    _flush() {
        if (!this.hasPending) return Promise.resolve();

        const updates = this.updates;
        this.updates = Object.create(null);
        this.hasPending = false;
        this.timeoutId = 0;

        return this.player.updatePlayer(updates);
    }

    destroy() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = 0;
        }
        this.updates = Object.create(null);
        this.hasPending = false;
    }
}

class Player extends EventEmitter {
    static LOOP_MODES = LOOP_MODES;
    static EVENT_HANDLERS = EVENT_HANDLERS;
    static validModes = VALID_MODES;

    constructor(aqua, nodes, options = {}) {
        super();

        // Core references
        this.aqua = aqua;
        this.nodes = nodes;
        this.guildId = options.guildId;
        this.textChannel = options.textChannel;
        this.voiceChannel = options.voiceChannel;

        // Initialize components
        this.connection = new Connection(this);
        this.filters = new Filters(this);
        this.queue = new Queue();

        // Optimized volume clamping
        const vol = options.defaultVolume ?? 100;
        this.volume = Math.max(0, Math.min(200, vol));

        // Direct assignment with validation
        this.loop = VALID_MODES.has(options.loop) ? options.loop : LOOP_MODES.NONE;
        this.shouldDeleteMessage = !!this.aqua.options.shouldDeleteMessage;
        this.leaveOnEnd = !!this.aqua.options.leaveOnEnd;

        // Circular buffer for previous tracks (more memory efficient)
        this.previousTracks = new Array(50);
        this.previousIndex = 0;
        this.previousCount = 0;

        // State flags - grouped for better cache locality
        this.playing = false;
        this.paused = false;
        this.connected = false;
        this.isAutoplayEnabled = false;
        this.isAutoplay = false;

        // Track state
        this.current = null;
        this.position = 0;
        this.timestamp = 0;
        this.ping = 0;
        this.nowPlayingMessage = null;

        // Optimized components
        this._updateBatcher = new OptimizedUpdateBatcher(this);
        this._dataStore = new Map();

        // Bind methods once
        this._boundPlayerUpdate = this._handlePlayerUpdate.bind(this);
        this._boundEvent = this._handleEvent.bind(this);

        this.on("playerUpdate", this._boundPlayerUpdate);
        this.on("event", this._boundEvent);
    }

    _handlePlayerUpdate(packet) {
        const state = packet.state;
        this.position = state.position;
        this.connected = state.connected;
        this.ping = state.ping;
        this.timestamp = state.time;
        this.aqua.emit("playerUpdate", this, packet);
    }

    async _handleEvent(payload) {
        const handlerName = EVENT_HANDLERS[payload.type];

        if (!handlerName || typeof this[handlerName] !== "function") {
            this.aqua.emit("nodeError", this, new Error(`Unknown event: ${payload.type}`));
            return;
        }

        try {
            await this[handlerName](this, this.current, payload);
        } catch (error) {
            this.aqua.emit("error", error);
        }
    }

    get previous() {
        return this.previousCount > 0
            ? this.previousTracks[(this.previousIndex - 1 + 50) % 50]
            : null;
    }

    get currenttrack() {
        return this.current;
    }

    batchUpdatePlayer(data, immediate = false) {
        return this._updateBatcher.batch(data, immediate);
    }

    async autoplay(player) {
        if (!this.isAutoplayEnabled || !this.previous) return this;

        this.isAutoplay = true;
        const prevInfo = this.previous.info;
        const { sourceName, identifier, uri, requester } = prevInfo;

        try {
            let query, source;

            switch (sourceName) {
                case "youtube":
                    query = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`;
                    source = "ytmsearch";
                    break;
                case "soundcloud":
                    const scResults = await scAutoPlay(uri);
                    if (!scResults?.length) return this;
                    query = scResults[0];
                    source = "scsearch";
                    break;
                case "spotify":
                    const spResult = await spAutoPlay(identifier);
                    if (!spResult) return this;
                    query = `https://open.spotify.com/track/${spResult}`;
                    source = "spotify";
                    break;
                default:
                    return this;
            }

            const response = await this.aqua.resolve({ query, source, requester });

            if (!response?.tracks?.length || FAIL_LOAD_TYPES.has(response.loadType)) {
                return this.stop();
            }

            const tracks = response.tracks;
            const track = tracks[Math.floor(Math.random() * tracks.length)];

            if (!track?.info?.title) {
                throw new Error("Invalid track object");
            }

            track.requester = this.previous.requester || { id: "Unknown" };
            this.queue.push(track);
            await this.play();

            return this;
        } catch (error) {
            return this.stop();
        }
    }

    setAutoplay(enabled) {
        this.isAutoplayEnabled = !!enabled;
        return this;
    }

    async play() {
        if (!this.connected || !this.queue.length) return;

        const item = this.queue.shift();
        this.current = item.track ? item : await item.resolve(this.aqua);
        this.playing = true;
        this.position = 0;

        return this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true);
    }

    connect(options = this) {
        const { guildId, voiceChannel, deaf = true, mute = false } = options;

        this.deaf = deaf;
        this.mute = mute;
        this.connected = true;

        this.send({
            guild_id: guildId,
            channel_id: voiceChannel,
            self_deaf: deaf,
            self_mute: mute,
        });

        return this;
    }

    destroy() {
        if (!this.connected) return this;

        this._updateBatcher.destroy();

        this.send({ guild_id: this.guildId, channel_id: null });
        this.connected = false;
        this.voiceChannel = null;

        if (this.nowPlayingMessage) {
            this.nowPlayingMessage.delete().catch(() => { });
            this.nowPlayingMessage = null;
        }

        this.isAutoplay = false;
        this.aqua.destroyPlayer(this.guildId);

        if (this.nodes?.connected) {
            try {
                this.nodes.rest.destroyPlayer(this.guildId);
            } catch (error) {
                if (!error.message.includes('ECONNREFUSED')) {
                    console.error('Error destroying player:', error);
                }
            }
        }

        // Clean up efficiently
        this.previousCount = 0;
        this._dataStore.clear();
        this.removeAllListeners();

        // Nullify references
        this.queue = null;
        this.previousTracks = null;
        this.connection = null;
        this.filters = null;

        return this;
    }

    pause(paused) {
        if (this.paused === paused) return this;
        this.paused = paused;
        this.batchUpdatePlayer({ paused });
        return this;
    }

    async getLyrics(options = {}) {
        const { query, useCurrentTrack = true, skipTrackSource = false } = options;

        if (query) {
            return this.nodes.rest.getLyrics({
                track: { info: { title: query } },
                skipTrackSource
            });
        }

        if (useCurrentTrack && this.playing && this.current?.info) {
            return this.nodes.rest.getLyrics({
                track: {
                    info: this.current.info,
                    identifier: this.current.info.identifier,
                    guild_id: this.guildId,
                },
                skipTrackSource
            });
        }

        return null;
    }

    subscribeLiveLyrics() {
        return this.nodes.rest.subscribeLiveLyrics(this.guildId, false);
    }

    unsubscribeLiveLyrics() {
        return this.nodes.rest.unsubscribeLiveLyrics(this.guildId);
    }

    seek(position) {
        if (!this.playing) return this;

        // Clamp position efficiently
        const maxPos = this.current?.info?.length;
        this.position = Math.max(0, maxPos ? Math.min(position, maxPos) : position);

        this.batchUpdatePlayer({ position: this.position });
        return this;
    }

    stop() {
        if (!this.playing) return this;
        this.playing = false;
        this.position = 0;
        this.batchUpdatePlayer({ track: { encoded: null } }, true);
        return this;
    }

    setVolume(volume) {
        const vol = Math.max(0, Math.min(200, volume));
        if (this.volume === vol) return this;

        this.volume = vol;
        this.batchUpdatePlayer({ volume: vol });
        return this;
    }

    setLoop(mode) {
        if (!VALID_MODES.has(mode)) {
            throw new Error("Invalid loop mode");
        }
        this.loop = mode;
        this.batchUpdatePlayer({ loop: mode });
        return this;
    }

    setTextChannel(channel) {
        this.textChannel = channel;
        this.batchUpdatePlayer({ text_channel: channel });
        return this;
    }

    setVoiceChannel(channel) {
        if (!channel) throw new TypeError("Channel required");
        if (this.connected && channel === this.voiceChannel) {
            throw new ReferenceError(`Already connected to ${channel}`);
        }

        this.voiceChannel = channel;
        this.connect({
            deaf: this.deaf,
            guildId: this.guildId,
            voiceChannel: channel,
            textChannel: this.textChannel,
            mute: this.mute,
        });
        return this;
    }

    disconnect() {
        if (!this.connected) return this;
        this.connected = false;
        this.voiceChannel = null;
        this.send({ guild_id: this.guildId, channel_id: null });
        return this;
    }

    // Optimized Fisher-Yates shuffle
    shuffle() {
        const queue = this.queue;
        const len = queue.length;

        if (len <= 1) return this;

        // Inline shuffle for better performance
        for (let i = len - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const temp = queue[i];
            queue[i] = queue[j];
            queue[j] = temp;
        }

        return this;
    }

    getQueue() {
        return this.queue;
    }

    replay() {
        return this.seek(0);
    }

    skip() {
        this.stop();
        return this.playing ? this.play() : undefined;
    }

    async trackStart(player, track) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackStart", player, track);
    }

    async trackEnd(player, track, payload) {
        if (track) {
            this.previousTracks[this.previousIndex] = track;
            this.previousIndex = (this.previousIndex + 1) % 50;
            if (this.previousCount < 50) this.previousCount++;
        }

        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            this.nowPlayingMessage.delete().catch(() => { });
            this.nowPlayingMessage = null;
        }

        const reason = payload.reason;
        if (FAILURE_REASONS.has(reason)) {
            if (this.queue.length === 0) {
                this.previousCount = 0;
                this._dataStore.clear();
                this.aqua.emit("queueEnd", player);
            } else {
                this.aqua.emit("trackEnd", player, track, reason);
                await player.play();
            }
            return;
        }

        if (this.loop === LOOP_MODES.TRACK) {
            player.queue.unshift(track);
        } else if (this.loop === LOOP_MODES.QUEUE) {
            player.queue.push(track);
        }

        if (player.queue.isEmpty()) {
            if (this.isAutoplayEnabled) {
                await player.autoplay(player);
            } else {
                this.playing = false;
                if (this.leaveOnEnd) {
                    this.previousCount = 0;
                    this._dataStore.clear();
                    this.destroy();
                }
                this.aqua.emit("queueEnd", player);
            }
        } else {
            this.aqua.emit("trackEnd", player, track, reason);
            await player.play();
        }
    }

    async trackError(player, track, payload) {
        this.aqua.emit("trackError", player, track, payload);
        return this.stop();
    }

    async trackStuck(player, track, payload) {
        this.aqua.emit("trackStuck", player, track, payload);
        return this.stop();
    }

    async socketClosed(player, track, payload) {
        const { code, guildId } = payload || {};

        if (RECONNECT_CODES.has(code)) {
            try {
                const voiceChannelId = this.voiceChannel?.id || this.voiceChannel;
                const textChannelId = this.textChannel?.id || this.textChannel;
                const currentTrack = this.current;

                if (!voiceChannelId) {
                    this.aqua.emit("socketClosed", player, payload);
                    return;
                }


                if (!player.destroyed) {
                    await player.destroy();
                    this.aqua.emit("playerDestroy", player);
                }

                const newPlayer = await this.aqua.createConnection({
                    guildId,
                    voiceChannel: voiceChannelId,
                    textChannel: textChannelId,
                    deaf: this.deaf,
                    mute: this.mute,
                    defaultVolume: this.volume
                });

                if (track) {
                    newPlayer.queue.add(track);
                    await newPlayer.play();
                }
                return;

            } catch (error) {
                console.error("Reconnection failed:", error);
                this.aqua.emit("socketClosed", player, payload);
            }
            return;
        }

        this.aqua.emit("socketClosed", player, payload);
    }


    async lyricsLine(player, track, payload) {
        this.aqua.emit("lyricsLine", player, track, payload);
    }

    async lyricsFound(player, track, payload) {
        this.aqua.emit("lyricsFound", player, track, payload);
    }

    async lyricsNotFound(player, track, payload) {
        this.aqua.emit("lyricsNotFound", player, track, payload);
    }

    send(data) {
        this.aqua.send({ op: 4, d: data });
    }

    set(key, value) {
        this._dataStore.set(key, value);
    }

    get(key) {
        return this._dataStore.get(key);
    }

    clearData() {
        this.previousCount = 0;
        this._dataStore.clear();
        return this;
    }

    updatePlayer(data) {
        return this.nodes.rest.updatePlayer({ guildId: this.guildId, data });
    }

    async cleanup() {
        if (!this.playing && !this.paused && this.queue.isEmpty()) {
            this.destroy();
        }
    }
}

module.exports = Player;
