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
    LyricsFoundEvent: "lyricsFound" ,
    LyricsNotFoundEvent: "lyricsNotFound"
});


const VALID_MODES = new Set(Object.values(LOOP_MODES));
const FAILURE_REASONS = new Set(["LOAD_FAILED", "CLEANUP"]);
const RECONNECT_CODES = new Set([4015, 4009]);
const FAIL_LOAD_TYPES = new Set(["error", "empty", "LOAD_FAILED", "NO_MATCHES"]);

class UpdateBatcher {
    constructor(player) {
        this.player = player;
        this.pendingUpdates = {};
        this.timeout = null;
        this.hasUpdates = false;
    }

    batch(data, immediate = false) {
        Object.assign(this.pendingUpdates, data);
        this.hasUpdates = true;

        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }

        if (immediate || data.track) {
            const updates = this.pendingUpdates;
            this.pendingUpdates = {};
            this.hasUpdates = false;
            return this.player.updatePlayer(updates);
        }

        this.timeout = setTimeout(() => {
            if (this.hasUpdates) {
                const updates = this.pendingUpdates;
                this.pendingUpdates = {};
                this.hasUpdates = false;
                this.player.updatePlayer(updates);
            }
            this.timeout = null;
        }, 32);

        return Promise.resolve();
    }

    destroy() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        this.pendingUpdates = {};
        this.hasUpdates = false;
    }
}

class Player extends EventEmitter {
    static LOOP_MODES = LOOP_MODES;
    static EVENT_HANDLERS = EVENT_HANDLERS;
    static validModes = VALID_MODES;

    constructor(aqua, nodes, options = {}) {
        super();
        this.aqua = aqua;
        this.nodes = nodes;
        this.guildId = options.guildId;
        this.textChannel = options.textChannel;
        this.voiceChannel = options.voiceChannel;

        this.connection = new Connection(this);
        this.filters = new Filters(this);
        this.queue = new Queue();

        const vol = options.defaultVolume ?? 100;
        this.volume = vol < 0 ? 0 : vol > 200 ? 200 : vol;
        
        this.loop = VALID_MODES.has(options.loop) ? options.loop : LOOP_MODES.NONE;
        this.shouldDeleteMessage = Boolean(this.aqua.options.shouldDeleteMessage);
        this.leaveOnEnd = Boolean(this.aqua.options.leaveOnEnd);

        this.previousTracks = new Array(50);
        this.previousTracksIndex = 0;
        this.previousTracksCount = 0;

        this.playing = false;
        this.paused = false;
        this.connected = false;
        this.current = null;
        this.position = 0;
        this.timestamp = 0;
        this.ping = 0;
        this.nowPlayingMessage = null;
        this.isAutoplayEnabled = false;
        this.isAutoplay = false;

        this._updateBatcher = new UpdateBatcher(this);
        this._dataStore = new Map();

        this._handlePlayerUpdate = this._handlePlayerUpdate.bind(this);
        this._handleEvent = this._handleEvent.bind(this);

        this.on("playerUpdate", this._handlePlayerUpdate);
        this.on("event", this._handleEvent);
    }

    _handlePlayerUpdate(packet) {
        this.position = packet.state.position;
        this.connected = packet.state.connected;
        this.ping = packet.state.ping;
        this.timestamp = packet.state.time;
        this.aqua.emit("playerUpdate", this, packet);
    }

    async _handleEvent(payload) {
        try {
            const handlerName = EVENT_HANDLERS[payload.type];
            if (handlerName && typeof this[handlerName] === "function") {
                await this[handlerName](this, this.current, payload);
            } else {
                this.aqua.emit("nodeError", this, new Error(`Node encountered an unknown event: '${payload.type}'`));
            }
        } catch (error) {
            console.error(`Error handling event ${payload.type}:`, error);
            this.aqua.emit("error", error);
        }
    }

    get previous() {
        return this.previousTracksCount ? this.previousTracks[(this.previousTracksIndex - 1 + 50) % 50] : null;
    }

    get currenttrack() {
        return this.current;
    }

    batchUpdatePlayer(data, immediate = false) {
        return this._updateBatcher.batch(data, immediate);
    }

    async autoplay(player) {
        if (!player) throw new Error("Player is undefined. const player = aqua.players.get(guildId);");
        if (!this.isAutoplayEnabled) {
            this.aqua.emit("debug", this.guildId, "Autoplay is disabled.");
            return this;
        }

        this.isAutoplay = true;
        if (!this.previous) return this;

        try {
            const { sourceName, identifier, uri, requester } = this.previous.info;
            this.aqua.emit("debug", this.guildId, `Attempting autoplay for ${sourceName}`);

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
            if (!track?.info?.title) throw new Error("Invalid track object: missing title or info.");

            track.requester = this.previous.requester || { id: "Unknown" };
            this.queue.push(track);
            await this.play();

            return this;
        } catch (error) {
            console.error("Autoplay error:", error);
            return this.stop();
        }
    }

    setAutoplay(enabled) {
        this.isAutoplayEnabled = Boolean(enabled);
        this.aqua.emit("debug", this.guildId, `Autoplay has been ${enabled ? "enabled" : "disabled"}.`);
        return this;
    }

    async play() {
        if (!this.connected || !this.queue.length) return;

        const item = this.queue.shift();
        this.current = item.track ? item : await item.resolve(this.aqua);
        this.playing = true;
        this.position = 0;

        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);
        return this.batchUpdatePlayer({ track: { encoded: this.current.track } }, true);
    }

    connect(options = this) {
        const { guildId, voiceChannel, deaf = true, mute = false } = options;
        this.deaf = deaf;
        this.mute = mute;
        this.send({
            guild_id: guildId,
            channel_id: voiceChannel,
            self_deaf: deaf,
            self_mute: mute,
        });
        this.connected = true;
        this.aqua.emit("debug", guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }

  destroy() {
    if (!this.connected) return this;

    const voiceChannelId = this.voiceChannel ? this.voiceChannel.id || this.voiceChannel : null;
    this._updateBatcher.destroy();

    this.send({ guild_id: this.guildId, channel_id: null });
    this._lastVoiceChannel = voiceChannelId;
    this.voiceChannel = null;
    this.connected = false;
    this.send({ guild_id: this.guildId, channel_id: null });

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
                console.error('Error destroying player on node:', error);
            }
        }
    }
    
    this.previousTracksCount = 0;
    this._dataStore.clear();
    this.removeAllListeners();

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
        const { query = null, useCurrentTrack = true, skipTrackSource = false } = options;

        if (query) {
            this.aqua.emit("debug", `[Aqua/Player] Searching lyrics for query: "${query}"`);
            return this.nodes.rest.getLyrics({
                track: {
                    info: { title: query }
                },
                skipTrackSource
            });
        }

        if (useCurrentTrack && this.playing && this.current?.info) {
            this.aqua.emit("debug", `[Aqua/Player] Getting lyrics for current track: "${this.current.info.title}"`);
            return this.nodes.rest.getLyrics({
                track: {
                    info: this.current.info,
                    identifier: this.current.info.identifier,
                    guild_id: this.guildId,
                },
                skipTrackSource
            });
        }

        this.aqua.emit("debug", `[Aqua/Player] getLyrics called but no query was provided and no track is playing.`);
        return null;
    }

    async subscribeLiveLyrics() {
        return this.nodes.rest.subscribeLiveLyrics(this.guildId, false);
    }

    async unsubscribeLiveLyrics() {
        return this.nodes.rest.unsubscribeLiveLyrics(this.guildId);
    }

  seek(position) {
    if (!this.playing) return this;
    if (position < 0) position = 0;
    if (this.current?.info?.length && position > this.current.info.length) {
      position = this.current.info.length;
    }
    this.position = position;
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
        if (volume < 0 || volume > 200) throw new Error("Volume must be between 0 and 200.");
        this.volume = volume;
        this.batchUpdatePlayer({ volume });
        return this;
    }

    setLoop(mode) {
        if (!VALID_MODES.has(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
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
        if (!channel?.length) throw new TypeError("Channel must be a non-empty string.");
        if (this.connected && channel === this.voiceChannel) throw new ReferenceError(`Player already connected to ${channel}.`);
        this.voiceChannel = channel;
        this.connect({
            deaf: this.deaf,
            guildId: this.guildId,
            voiceChannel: this.voiceChannel,
            textChannel: this.textChannel,
            mute: this.mute,
        });
        return this;
    }

    disconnect() {
        if (!this.connected) return this;
        this.connected = false;
        this.send({ guild_id: this.guildId, channel_id: null });
        this.voiceChannel = null;
        this.aqua.emit("debug", this.guildId, "Player disconnected.");
        return this;
    }

    shuffle() {
        const queue = this.queue;
        const len = queue.length;
        
        if (len <= 1) return this;

        if (len < 200) {
            for (let i = len - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [queue[i], queue[j]] = [queue[j], queue[i]];
            }
        } else {
            this._shuffleAsync(queue, len - 1);
        }
        
        return this;
    }

    _shuffleAsync(queue, i, chunkSize = 100) {
        const end = Math.max(0, i - chunkSize);
        
        for (; i > end; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        
        if (i > 0) {
            setImmediate(() => this._shuffleAsync(queue, i, chunkSize));
        }
    }

    getQueue() {
        return this.queue;
    }

    replay() {
        return this.seek(-this.position);
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
            this.previousTracks[this.previousTracksIndex] = track;
            this.previousTracksIndex = (this.previousTracksIndex + 1) % 50;
            if (this.previousTracksCount < 50) this.previousTracksCount++;
        }

        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            try {
                await this.nowPlayingMessage.delete();
            } catch (error) {
                console.error("Error deleting now playing message:", error);
            } finally {
                this.nowPlayingMessage = null;
            }
        }

        const reason = payload.reason;
        if (FAILURE_REASONS.has(reason)) {
            if (!player.queue.length) {
                this.previousTracksCount = 0;
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
                    this.previousTracksCount = 0;
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

    async socketClosed(player, payload) {
        const { code, guildId } = payload || {};
        if (RECONNECT_CODES.has(code)) {
            this.send({
                guild_id: guildId,
                channel_id: this.voiceChannel,
                self_mute: this.mute,
                self_deaf: this.deaf
            });
        }
        this.aqua.emit("socketClosed", player, payload);
        this.pause(true);
        this.aqua.emit("debug", this.guildId, "Player paused due to socket closure.");
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
        this.previousTracksCount = 0;
        this._dataStore.clear();
        return this;
    }

    updatePlayer(data) {
        return this.nodes.rest.updatePlayer({ guildId: this.guildId, data });
    }

    async cleanup() {
        if (!this.playing && !this.paused && this.queue.isEmpty()) this.destroy();
    }
}

module.exports = Player;
