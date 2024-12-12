const { EventEmitter } = require("events");
const { Connection } = require("./Connection");
const { Queue } = require("./Queue");
const { Filters } = require("./Filters");

class Player extends EventEmitter {
    /**
     * Player constructor
     * @param {Aqua} aqua the Aqua client instance
     * @param {Array<Node>} nodes the nodes to connect to
     * @param {Object} options the options to use
     * @param {String} options.guildId the guild id to play in
     * @param {String} options.textChannel the text channel to send messages in
     * @param {String} options.voiceChannel the voice channel to join
     * @param {Boolean} options.mute if the player should be muted
     * @param {Boolean} options.deaf if the player should be deafened
     * @param {Number} options.defaultVolume the default volume to use
     * @param {String} options.loop the loop mode to use
     * @param {Map} options.data the data to use
     * @param {Boolean} options.shouldDeleteMessage if the player should delete the now playing message
     */
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
        this.data = new Map()
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
        this.on('destroy', this.destroy.bind(this));
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
     * Plays the next track in the queue.
     *
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     * @throws {Error} If the queue is empty.
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
     * Connects the player to a voice channel.
     * @param {Object} options the options to use
     * @param {String} options.guildId the guild id to connect to
     * @param {String} options.voiceChannel the voice channel to connect to
     * @param {Boolean} [options.deaf=true] if the player should be deafened
     * @param {Boolean} [options.mute=false] if the player should be muted
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is already connected.
     */
    async connect(options) {
        if (this.connected) throw new Error("Player is already connected.");
        const { guildId, voiceChannel, deaf = true, mute = false } = options;

        this.send({ guild_id: guildId, channel_id: voiceChannel, self_deaf: deaf, self_mute: mute });
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }


    /**
     * Destroys the player.
     *
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     */
    async destroy() {
        await this.disconnect();
        return this;
    }

    /**
     * Pauses or unpauses the player.
     *
     * @param {Boolean} paused whether to pause or not
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     */
    async pause(paused) {
        this.paused = paused;
        await this.updatePlayer({ paused });
        return this;
    }

    /**
     * Seeks the player to a given position.
     *
     * @param {Number} position the position to seek to in milliseconds
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the position is negative.
     */
    async seek(position) {
        if (position < 0) throw new Error("Seek position cannot be negative.");
        this.position = position;
        await this.updatePlayer({ position });
        return this;
    }

       /**
     * Stops the player and resets its state.
     *
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     */
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
     * @param {Number} volume the volume to set, must be between 0 and 200
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the volume is invalid.
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
     * @param {String} mode the loop mode to set, must be 'none', 'track', or 'queue'
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the loop mode is invalid.
     */
    async setLoop(mode) {
        if (!["none", "track", "queue"].includes(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        await this.updatePlayer({ loop: mode });
        return this;
    }

    /**
     * Sets the text channel that the player will send messages to.
     *
     * @param {String} channel the ID of the text channel to send messages to
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the channel is invalid.
     */
    async setTextChannel(channel) {
        await this.updatePlayer({ text_channel: channel });
        return this;
    }

    /**
     * Sets the voice channel that the player will connect to.
     *
     * @param {String} channel the ID of the voice channel to connect to
     * @returns {Promise<Player>} The player instance.
     * @throws {TypeError} If the channel is not a non-empty string.
     * @throws {ReferenceError} If the player is already connected to the given channel.
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

    /**
     * Disconnects the player from the voice channel and clears the current track.
     *
     * @returns {Promise<void>} Resolves when the player is disconnected.
     * @throws {Error} If the player is not connected to a voice channel.
     */
    async disconnect() {
        await this.updatePlayer({ track: { encoded: null } });
        this.send({ guild_id: this.guildId, channel_id: null });
        this.connected = false;
        this.aqua.emit("debug", this.guildId, "Player disconnected from voice channel.");
    }

    /**
     * Shuffles the queue using the Fisher-Yates shuffle algorithm.
     *
     * @returns {Promise<Player>} The player instance.
     */
    async shuffle() {
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        return this;
    }

    /**
     * Retrieves the current queue of tracks.
     *
     * @returns {Promise<Array<Track>>} The current queue of tracks.
     */
    async getQueue() {
        return this.queue;
    }

    /**
     * Replays the current track from the start.
     *
     * @returns {Promise<Player>} The player instance.
     */
    async replay() {
        return this.seek(0);
    }

    /**
     * Skips the current track and plays the next one in the queue.
     *
     * @returns {Promise<Player>} The player instance.
     */
    async skip() {
        await this.stop(); 
        return this.play(); 
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
        this.paused = false
        this.aqua.emit("trackChange", player, track, payload);
    }

    async trackEnd(player, track, payload) {
        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            this.nowPlayingMessage.delete().catch(console.error).finally(() => this.nowPlayingMessage = null);
        }

        const reason = payload.reason.replace("_", "").toLowerCase();
        switch (reason) {
            case "loadfailed":
            case "cleanup":
                return player.queue.isEmpty() ? this.aqua.emit("queueEnd", player) : player.play();

            case "track":
                this.aqua.emit("trackRepeat", player, track, payload);
                player.queue.unshift(this.previous);
                break;

            case "queue":
                this.aqua.emit("queueRepeat", player, track, payload);
                player.queue.push(this.previous);
                break;

            default:
                this.aqua.emit("trackEnd", player, track, payload);
                await this.cleanup();
        }

        if (player.queue.length === 0) {
            this.playing = false;
            this.aqua.emit("queueEnd", player);
        }

        if (!player.playing) {
            return this.cleanup();
        }

        return player.play();
    }

    trackError(player, track, payload) {
        this.aqua.emit("trackError", player, payload);
        this.stop();
    }

    trackStuck(player, track, payload) {
        this.aqua.emit("trackStuck", player, payload);
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
    }
}

module.exports = { Player };
