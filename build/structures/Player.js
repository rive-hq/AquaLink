const { EventEmitter } = require("events");
const { Connection } = require("./Connection");
const { Queue } = require("./Queue");
const { Filters } = require("./Filters");

class Player extends EventEmitter {
    static LOOP_MODES = Object.freeze({
        NONE: "none",
        TRACK: "track",
        QUEUE: "queue"
    });
    constructor(aqua, nodes, options = {}) {
        super();
        this.aqua = aqua;
        this.nodes = nodes;
        this.guildId = options.guildId;
        this.textChannel = options.textChannel;
        this.voiceChannel = options.voiceChannel;
        this.connection = new Connection(this);
        this.filters = new Filters(this);
        this.mute = options.mute ?? false;
        this.deaf = options.deaf ?? false;
        this.volume = options.defaultVolume ?? 100;
        this.loop = options.loop ?? "none";
        this.data = new Map();
        this.queue = new Queue();
        this.position = 0;
        this.current = null;
        this.playing = false;
        this.paused = false;
        this.connected = false;
        this.timestamp = 0;
        this.ping = 0;
        this.nowPlayingMessage = null;
        this.previousTracks = [];
        this.shouldDeleteMessage = options.shouldDeleteMessage; 
        this.leaveOnEnd = options.leaveOnEnd

        this.boundHandleEvent = this.handleEvent.bind(this);
        this.boundOnPlayerUpdate = this.onPlayerUpdate.bind(this);
        this.on("playerUpdate", this.boundOnPlayerUpdate);
        this.on("event", this.boundHandleEvent);
    }

    onPlayerUpdate({ state } = {}) {
        if (!state) return;
        
        const { connected, position, ping, time } = state;
        Object.assign(this, { connected, position, ping, timestamp: time });
        
        this.aqua.emit("playerUpdate", this, { state });
    }

    get previous() {
        return this.previousTracks[0] || null;
    }

    get currenttrack() {
        return this.current;
    }

    addToPreviousTrack(track) {
        if (this.previousTracks.length >= 50) {
            this.previousTracks.pop();
        }
        this.previousTracks.unshift(track);
    }

    async play() {
        if (!this.connected) {
            throw new Error("Player must be connected first.");
        }
        if (!this.queue.length) return;

        const track = this.queue.shift();
        this.current = track.track ? track : await track.resolve(this.aqua);
        
        Object.assign(this, {
            playing: true,
            position: 0
        });

        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);
        return this.updatePlayer({ track: { encoded: this.current.track } });
    }

    connect({ guildId, voiceChannel, deaf = true, mute = false }) {
        if (this.connected) {
            throw new Error("Player is already connected.");
        }
        this.send({
            guild_id: guildId,
            channel_id: voiceChannel,
            self_deaf: deaf,
            self_mute: mute
        });
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }

    destroy() {
        if (!this.connected) return this;
        this.disconnect();
        this.nowPlayingMessage?.delete().catch(() => { });
        this.aqua.destroyPlayer(this.guildId);
        this.nodes.rest.destroyPlayer(this.guildId);
        return this;
    }

    pause(paused) {
        this.paused = paused;
        this.updatePlayer({ paused });
        return this;
    }

    async searchLyrics(query) {
        if (!query) return null;
        const response = await this.nodes.rest.getLyrics({
            track: {
                encoded: { info: { title: query } },
                guild_id: this.guildId,
                search: true
            }
        });
        return response || null;
    }

    async lyrics() {
        if (!this.playing) return null;
        const response = await this.nodes.rest.getLyrics({
            track: {
                encoded: this.current.track,
                guild_id: this.guildId
            },
        });
        return response || null;
    }

    seek(position) {
        if (!this.playing) return this;
        const newPosition = this.position + position;
        if (newPosition < 0) {
            throw new Error("Seek position cannot be negative.");
        }
        this.position = newPosition;
        this.updatePlayer({ position: this.position });
        return this;
    }

    stop() {
        if (!this.playing) return this;
        this.updatePlayer({ track: { encoded: null } });
        this.playing = false;
        this.position = 0;
        return this;
    }

    setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("Volume must be between 0 and 200.");
        this.volume = volume;
        this.updatePlayer({ volume });
        return this;
    }

    static validModes = new Set(["none", "track", "queue"]);
    setLoop(mode) {
        if (!Player.validModes.has(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        this.updatePlayer({ loop: mode });
        return this;
    }

    setTextChannel(channel) {
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
        this.updatePlayer({ track: { encoded: null } });
        this.connected = false;
        this.send({ guild_id: this.guildId, channel_id: null });
        this.aqua.emit("debug", this.guildId, "Player disconnected.");
    }

    shuffle() {
        const arr = this.queue;
        for (let i = arr.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            [arr[i], arr[j]] = [arr[j], arr[i]];
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

    static EVENT_HANDLERS = Object.freeze({
        TrackStartEvent: "trackStart",
        TrackEndEvent: "trackEnd",
        TrackExceptionEvent: "trackError",
        TrackStuckEvent: "trackStuck",
        TrackChangeEvent: "trackChange",
        WebSocketClosedEvent: "socketClosed"
    });

    async handleEvent(payload) {
        const player = this.aqua.players.get(payload.guildId);
        if (!player) return;

        const handler = Player.EVENT_HANDLERS[payload.type];
        if (handler) {
            await this[handler](player, this.current, payload);
        } else {
            this.handleUnknownEvent(payload);
        }
    }

    trackStart(player, track) {
        Object.assign(this, { playing: true, paused: false });
        this.aqua.emit("trackStart", player, track);
    }

    trackChange(player, track) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackChange", player, track);
    }

    async trackEnd(player, track, payload) {
        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            await this.nowPlayingMessage?.delete().catch(() => { });
            this.nowPlayingMessage = null;
        }

        const reason = payload.reason.replace("_", "").toLowerCase();
        if (reason === "loadfailed" || reason === "cleanup") {
            return player.queue.isEmpty() ?
                this.aqua.emit("queueEnd", player) :
                player.play();
        }

        switch (this.loop) {
            case Player.LOOP_MODES.TRACK:
                this.aqua.emit("trackRepeat", player, track);
                player.queue.unshift(track);
                break;
            case Player.LOOP_MODES.QUEUE:
                this.aqua.emit("queueRepeat", player, track);
                player.queue.push(track);
                break;
        }

        if (player.queue.isEmpty()) {
            this.playing = false;
            if (this.leaveOnEnd) {
                await this.cleanup();
            }
            return this.aqua.emit("queueEnd", player);
        }
    

        return player.play();
    }

    trackError(player, track, payload) {
        this.aqua.emit("trackError", player, track, payload);
        return this.stop();
    }

    trackStuck(player, track, payload) {
        this.aqua.emit("trackStuck", player, track, payload);
        return this.stop();
    }

    socketClosed(player, payload) {
        if (payload?.code === 4015 || payload?.code === 4009) {
            this.send({
                guild_id: payload.guildId,
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

    #dataStore = new Map();
     set(key, value) {
        this.#dataStore.set(key, value);
    }

    get(key) {
        return this.#dataStore.get(key);
    }

    clearData() {
        this.#dataStore.clear();
        return this;
    }

    async updatePlayer(data) {
        return this.nodes.rest.updatePlayer({
            guildId: this.guildId,
            data,
        });
    }

    handleUnknownEvent(payload) {
        const error = new Error(`Node encountered an unknown event: '${payload.type}'`);
        this.aqua.emit("nodeError", this, error);
    }

    async cleanup() {
        if (!this.playing && !this.paused && this.queue.isEmpty()) {
            this.destroy();
        }
        this.clearData();
    }
}

module.exports = { Player };
