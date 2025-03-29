"use strict";

const { EventEmitter } = require('eventemitter3');
const Connection = require("./Connection");
const Queue = require("./Queue");
const Filters = require("./Filters");
const { spAutoPlay, scAutoPlay } = require('../handlers/autoplay');

class Player extends EventEmitter {
    static LOOP_MODES = Object.freeze({
        NONE: "none", TRACK: "track", QUEUE: "queue"
    });

    static EVENT_HANDLERS = Object.freeze({
        TrackStartEvent: "trackStart",
        TrackEndEvent: "trackEnd",
        TrackExceptionEvent: "trackError",
        TrackStuckEvent: "trackStuck",
        TrackChangeEvent: "trackChange",
        WebSocketClosedEvent: "socketClosed"
    });

    static validModes = new Set(Object.values(Player.LOOP_MODES));

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
        
        this.volume = Math.max(0, Math.min(options.defaultVolume ?? 100, 200));
        this.loop = Player.validModes.has(options.loop) ? options.loop : Player.LOOP_MODES.NONE;
        this.shouldDeleteMessage = Boolean(options.shouldDeleteMessage);
        this.leaveOnEnd = Boolean(options.leaveOnEnd);
        
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
        
        this._boundHandlers = {
            playerUpdate: this._handlePlayerUpdate.bind(this),
            event: this._handleEvent.bind(this)
        };
        
        this.on("playerUpdate", this._boundHandlers.playerUpdate);
        this.on("event", this._boundHandlers.event);
        
        this._dataStore = null;
    }

    get previous() {
        if (!this.previousTracksCount) return null;
        return this.previousTracks[(this.previousTracksIndex - 1 + 50) % 50];
    }

    get currenttrack() {
        return this.current;
    }

    async autoplay(player) {
        if (!player) throw new Error("Quick Fix: player.autoplay(player)");
        if (!this.isAutoplayEnabled) {
            this.aqua.emit("debug", this.guildId, "Autoplay is disabled.");
            return this;
        }

        this.isAutoplay = true;
        if (!this.previous) return this;

        try {
            const { sourceName, identifier, uri, requester } = this.previous.info;
            this.aqua.emit("debug", this.guildId, `Attempting autoplay for ${sourceName}`);

            const sourceHandlers = {
                youtube: async () => ({
                    query: `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`,
                    source: "ytmsearch"
                }),
                soundcloud: async () => {
                    const scResults = await scAutoPlay(uri);
                    return scResults?.length ? { query: scResults[0], source: "scsearch" } : null;
                },
                spotify: async () => {
                    const spResult = await spAutoPlay(identifier);
                    return spResult ? { query: `https://open.spotify.com/track/${spResult}`, source: "spotify" } : null;
                }
            };

            const handler = sourceHandlers[sourceName];
            if (!handler) return this;

            const result = await handler();
            if (!result) return this;

            const { query, source } = result;
            const response = await this.aqua.resolve({ query, source, requester });

            if (!response?.tracks?.length || ["error", "empty", "LOAD_FAILED", "NO_MATCHES"].includes(response.loadType)) {
                return this.stop();
            }

            const track = response.tracks[Math.floor(Math.random() * response.tracks.length)];
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

    addToPreviousTrack(track) {
        if (!track) return;
        this.previousTracks[this.previousTracksIndex] = track;
        this.previousTracksIndex = (this.previousTracksIndex + 1) % 50;
        if (this.previousTracksCount < 50) this.previousTracksCount++;
    }

    _handlePlayerUpdate({ state }) {
        if (state) {
            const { position, timestamp, ping } = state;
            if (position !== undefined) this.position = position;
            if (timestamp !== undefined) this.timestamp = timestamp;
            if (ping !== undefined) this.ping = ping;
        }
        this.aqua.emit("playerUpdate", this, { state });
    }

    async _handleEvent(payload) {
        const handlerName = Player.EVENT_HANDLERS[payload.type];
        if (handlerName && typeof this[handlerName] === "function") {
            await this[handlerName](this, this.current, payload);
        } else {
            this.handleUnknownEvent(payload);
        }
    }

    async play() {
        if (!this.connected || !this.queue.length) return;
        
        const item = this.queue.shift();
        this.current = item.track ? item : await item.resolve(this.aqua);
        this.playing = true;
        this.position = 0;
        
        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);
        return this.updatePlayer({ track: { encoded: this.current.track } });
    }

    connect({ voiceChannel, deaf = true, mute = false } = {}) {
        const payload = {
            guild_id: this.guildId,
            channel_id: this.voiceChannel,
            self_deaf: deaf,
            self_mute: mute
        };
        
        this.send(payload);
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }

    destroy() {
        if (!this.connected) return this;
        
        this.disconnect();
        if (this.nowPlayingMessage) {
            this.nowPlayingMessage.delete().catch(() => {});
            this.nowPlayingMessage = null;
        }
        
        this.isAutoplay = false;
        this.off("playerUpdate", this._boundHandlers.playerUpdate);
        this.off("event", this._boundHandlers.event);
        
        this.aqua.destroyPlayer(this.guildId);
        this.nodes.rest.destroyPlayer(this.guildId);
        
        this.clearData();
        this.removeAllListeners();
        
        this._boundHandlers = null;
        this.queue = null;
        this.previousTracks = null;
        this.connection = null;
        this.filters = null;
        
        return this;
    }

    pause(paused) {
        if (this.paused === paused) return this;
        this.paused = paused;
        this.updatePlayer({ paused });
        return this;
    }

    async searchLyrics(query) {
        return query ? this.nodes.rest.getLyrics({ track: { info: { title: query }, search: true } }) || null : null;
    }

    async lyrics() {
        return this.playing ? this.nodes.rest.getLyrics({ track: { encoded: this.current.track, guild_id: this.guildId } }) || null : null;
    }

    seek(position) {
        if (!this.playing) return this;
        this.position += position;
        this.updatePlayer({ position: this.position });
        return this;
    }

    stop() {
        if (!this.playing) return this;
        this.playing = false;
        this.position = 0;
        this.updatePlayer({ track: { encoded: null } });
        return this;
    }

    setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("Volume must be between 0 and 200.");
        this.volume = volume;
        this.updatePlayer({ volume });
        return this;
    }

    setLoop(mode) {
        if (!Player.validModes.has(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        this.updatePlayer({ loop: mode });
        return this;
    }

    setTextChannel(channel) {
        this.textChannel = channel;
        this.updatePlayer({ text_channel: channel });
        return this;
    }

    setVoiceChannel(channel) {
        if (!channel?.length) throw new TypeError("Channel must be a non-empty string.");
        if (this.connected && channel === this.voiceChannel) {
            throw new ReferenceError(`Player already connected to ${channel}.`);
        }
        
        this.voiceChannel = channel;
        this.connect({
            deaf: this.deaf,
            guildId: this.guildId,
            voiceChannel: channel,
            mute: this.mute
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
        const { queue } = this;
        for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        return this;
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
        this.addToPreviousTrack(track);
        
        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            try {
                await this.nowPlayingMessage.delete();
                this.nowPlayingMessage = null;
            } catch (error) {
                console.error("Error deleting now playing message:", error);
            }
        }
        
        const reason = payload.reason;
        if (reason === "LOAD_FAILED" || reason === "CLEANUP") {
            if (!player.queue.length) {
                this.clearData();
                this.aqua.emit("queueEnd", player);
            } else {
                this.aqua.emit("trackEnd", player, track, reason);
                await player.play();
            }
            return;
        }
        
        if (this.loop === Player.LOOP_MODES.TRACK) {
            player.queue.unshift(track);
        } else if (this.loop === Player.LOOP_MODES.QUEUE) {
            player.queue.push(track);
        }
        
        if (player.queue.isEmpty()) {
            if (this.isAutoplayEnabled) {
                await player.autoplay(player);
            } else {
                this.playing = false;
                if (this.leaveOnEnd) {
                    this.clearData();
                    this.cleanup();
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
        
        if (code === 4015 || code === 4009) {
            this.send({
                guild_id: guildId,
                channel_id: this.voiceChannel,
                self_mute: this.mute,
                self_deaf: this.deaf,
            });
        }
        
        this.aqua.emit("socketClosed", player, payload);
        this.pause(true);
        this.aqua.emit("debug", this.guildId, "Player paused due to socket closure.");
    }

    send(data) {
        this.aqua.send({ op: 4, d: data });
    }

    set(key, value) {
        if (!this._dataStore) this._dataStore = new Map();
        this._dataStore.set(key, value);
    }

    get(key) {
        return this._dataStore ? this._dataStore.get(key) : undefined;
    }

    clearData() {
        if (this.previousTracks) this.previousTracksCount = 0;
        this._dataStore = null;
        return this;
    }

    updatePlayer(data) {
        return this.nodes.rest.updatePlayer({ guildId: this.guildId, data });
    }

    handleUnknownEvent(payload) {
        const error = new Error(`Node encountered an unknown event: '${payload.type}'`);
        this.aqua.emit("nodeError", this, error);
    }

    async cleanup() {
        if (!this.playing && !this.paused && this.queue.isEmpty()) {
            this.destroy();
        }
    }
}

module.exports = Player;
