const { EventEmitter } = require("events");
const { Connection } = require("./Connection");
const { Queue } = require("./Queue");
const { Filters } = require("./Filters");

class Player extends EventEmitter {
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
        this.shouldDeleteMessage = options.shouldDeleteMessage ?? true;
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.on("playerUpdate", this.onPlayerUpdate.bind(this));
        this.on("event", this.handleEvent.bind(this));
    }

    onPlayerUpdate(packet) {
        const { state } = packet;
        this.connected = state.connected;
        this.position = state.position;
        this.ping = state.ping;
        this.timestamp = state.time;
        this.aqua.emit("playerUpdate", this, packet);
    }

    get previous() {
        return this.previousTracks[0] || null;
    }

    addToPreviousTrack(track) {
        this.previousTracks.unshift(track);
    }

    /**
     * Play the next track in the queue.
     *
     * @throws {Error} If the player is not connected.
     * @returns {Promise<Player>} The player instance.
     */
    async play() {
        if (!this.connected) throw new Error("Player must be connected first.");
        if (!this.queue.length) return;
        this.current = this.queue.shift();
        this.current = this.current.track ? this.current : await this.current.resolve(this.aqua);
        this.playing = true;
        this.position = 0;
        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);
        await this.updatePlayer({ track: { encoded: this.current.track } });
        return this;
    }

    /**
     * Connects the player to a specified voice channel.
     *
     * @param {Object} options - Options for connecting the player.
     * @param {string} options.guildId - The ID of the guild.
     * @param {string} options.voiceChannel - The ID of the voice channel to connect to.
     * @param {boolean} [options.deaf=true] - Whether the player should be self-deafened.
     * @param {boolean} [options.mute=false] - Whether the player should be self-muted.
     * @throws {Error} If the player is already connected.
     * @returns {Promise<Player>} The player instance.
     */

    async connect(options) {
        if (this.connected) throw new Error("Player is already connected.");
        const { guildId, voiceChannel, deaf = true, mute = false } = options;
        this.send({ guild_id: guildId, channel_id: voiceChannel, self_deaf: deaf, self_mute: mute });
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }

    async destroy() {
        if (!this.connected) return this;
        await this.updatePlayer({ track: { encoded: null } });
        this.queue.clear();
        this.current = null;
        this.playing = false;
        this.position = 0;
        this.send({ guild_id: this.guildId, channel_id: null });
        this.connected = false;
        return this;
    }

/**
 * Pauses or resumes the player.
 *
 * @param {boolean} paused - If true, the player will be paused; if false, it will resume.
 * @returns {Promise<Player>} The player instance.
 */

    async pause(paused) {
        this.paused = paused;
        await this.updatePlayer({ paused });
        return this;
    }

    /**
     * Seeks to a position in the currently playing track.
     *
     * @param {number} position - The position in milliseconds to seek to.
     * @throws {Error} If the position is negative.
     * @returns {Promise<Player>} The player instance.
     */
    async seek(position) {
        if (position < 0) throw new Error("Seek position cannot be negative.");
        this.position = position;
        await this.updatePlayer({ position });
        return this;
    }

    async stop() {
        if (!this.playing) return this;
        await this.updatePlayer({ track: { encoded: null } });
        this.playing = false;
        this.position = 0;
        return this;
    }

    /**
     * Sets the volume of the player.
     *
     * @param {number} volume - The volume to set, between 0 and 200.
     * @throws {Error} If the volume is out of range.
     * @returns {Promise<Player>} The player instance.
     */
    async setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("Volume must be between 0 and 200.");
        this.volume = volume;
        await this.updatePlayer({ volume });
        return this;
    }

    /**
     * Sets the loop mode of the player.
     *
     * @param {string} mode - The loop mode to set, either "none", "track", or "queue".
     * @throws {Error} If the mode is not one of the above.
     * @returns {Promise<Player>} The player instance.
     */
    async setLoop(mode) {
        if (!["none", "track", "queue"].includes(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        await this.updatePlayer({ loop: mode });
        return this;
    }

    /**
     * Sets the text channel for the player.
     *
     * @param {string} channel - The ID of the text channel to set.
     * @returns {Promise<Player>} The player instance.
     */

    async setTextChannel(channel) {
        await this.updatePlayer({ text_channel: channel });
        return this;
    }

    /**
     * Sets the voice channel for the player.
     *
     * @param {string} channel - The ID of the voice channel to set.
     * @throws {TypeError} If the channel is not a non-empty string.
     * @throws {ReferenceError} If the player is already connected to the channel.
     * @returns {Promise<Player>} The player instance.
     */
    async setVoiceChannel(channel) {
        if (typeof channel !== "string") throw new TypeError("Channel must be a non-empty string.");
        if (this.connected && channel === this.voiceChannel) {
            throw new ReferenceError(`Player is already connected to ${channel}.`);
        }
        this.voiceChannel = channel;
        await this.connect({ deaf: this.deaf, guildId: this.guildId, voiceChannel: this.voiceChannel, mute: this.mute });
        return this;
    }

    async disconnect() {
        await this.updatePlayer({ track: { encoded: null } });
        this.connected = false;
        this.send({ guild_id: this.guildId, channel_id: null });
        this.aqua.emit("debug", this.guildId, "Player disconnected from voice channel.");
    }

    async shuffle() {
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        return this;
    }

    async getQueue() {
        return this.queue;
    }

    async replay() {
        return this.seek(0);
    }

    async skip() {
        await this.stop();
        if (this.playing) return this.play();
    }

    handleEvent = (payload) => {
        const player = this.aqua.players.get(payload.guildId);
        if (!player) return;
        const track = player.current;
        switch (payload.type) {
            case "TrackStartEvent":
                this.trackStart(player, track, payload);
                break;
            case "TrackEndEvent":
                this.trackEnd(player, track, payload);
                break;
            case "TrackExceptionEvent":
                this.trackError(player, track, payload);
                break;
            case "TrackStuckEvent":
                this.trackStuck(player, track, payload);
                break;
            case "TrackChangeEvent":
                this.trackChange(player, track, payload);
                break;
            case "WebSocketClosedEvent":
                this.socketClosed(player, track, payload);
                break;
            default:
                this.handleUnknownEvent(player, track, payload);
        }
    }

    trackStart(player, track, payload) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackStart", player, track, payload);
    }

    trackChange(player, track, payload) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackChange", player, track, payload);
    }

    async trackEnd(player, track, payload) {
        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            try {
                await this.nowPlayingMessage.delete();
            } catch (error) {
                console.error(error);
            } finally {
                this.nowPlayingMessage = null;
            }
        }

        const reason = payload.reason.replace("_", "").toLowerCase();
        const isLoadFailedOrCleanup = ["loadfailed", "cleanup"].includes(reason);

        if (isLoadFailedOrCleanup) {
            if (player.queue.isEmpty()) {
                this.aqua.emit("queueEnd", player);
            } else {
                await player.play();
            }
            return;
        }

        if (this.loop === "track") {
            this.aqua.emit("trackRepeat", player, track, payload);
            player.queue.unshift(track);
        } else if (this.loop === "queue") {
            this.aqua.emit("queueRepeat", player, track, payload);
            player.queue.push(track);
        }

        if (player.queue.isEmpty()) {
            this.playing = false;
            this.aqua.emit("queueEnd", player);
            return this.cleanup();
        }

        await player.play();
    }

     trackError(player, track, payload) {
        this.aqua.emit("trackError", player, track, payload);
        this.stop();
    }

    trackStuck(player, track, payload) {
        this.aqua.emit("trackStuck", player, track, payload);
        this.stop();
    }

    socketClosed(player, payload) {
        if (payload && [4015, 4009].includes(payload.code)) {
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

    set(key, value) {
        this.data.set(key, value);
    }

    get(key) {
        return this.data.get(key);
    }

    clearData() {
        this.data.clear();
        return this;
    }

    async updatePlayer(data) {
        await this.nodes.rest.updatePlayer({
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
            await this.destroy();
        }
        this.data.clear();
    }
}

module.exports = { Player };
