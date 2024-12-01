const { EventEmitter } = require("events");
const { Connection } = require("./Connection");
const { Queue } = require("./Queue");
const {Filters} = require("./Filters");

class Player extends EventEmitter {
    /**
     * @param {Object} aqua - The Aqua instance.
     * @param {Object} node - The node instance.
     * @param {Object} options - Configuration options for the player.
     * @param {string} options.guildId - The ID of the guild.
     * @param {string} options.textChannel - The ID of the text channel.
     * @param {string} options.voiceChannel - The ID of the voice channel.
     * @param {boolean} [options.mute=false] - Whether the player is muted.
     * @param {boolean} [options.deaf=false] - Whether the player is deafened.
     * @param {number} [options.defaultVolume=100] - The default volume level (0-200).
     * @param {string} [options.loop='none'] - The loop mode ('none', 'track', 'queue').
     */
    constructor(aqua, nodes, options) {
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
        this.data = {};
        this.queue = new Queue();
        this.position = 0;
        this.current = null;
        this.previousTracks = [];
        this.playing = false;
        this.paused = false;
        this.connected = false;
        this.timestamp = 0;
        this.ping = 0;
        this.isAutoplay = false;
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.on("playerUpdate", this.onPlayerUpdate);
        this.on("event", this.handleEvent.bind(this));
    }

    onPlayerUpdate(packet) {
        const { state } = packet;
        this.connected = state.connected;
        this.position = state.position;
        this.ping = state.ping;
        this.timestamp = state.time;
    }

    /**
     * Get the previous track.
     * @returns {Object|null} The previous track or null if none exists.
     */
    get previous() {
        return this.previousTracks[0] || null;
    }

    /**
     * Add a track to the previous tracks list.
     * @param {Object} track - The track object to add.
     */
    addToPreviousTrack(track) {
        this.previousTracks.unshift(track);
    }

    /**
     * Play the next track in the queue.
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     */
    async play() {
        if (!this.connected) throw new Error("Player connection is not established. Please connect first.");

        this.current = this.queue.shift();
        if (!this.current) return this;

        if (!this.current.track) {
            this.current = await this.current.resolve(this.aqua);
        }

        this.playing = true;
        this.position = 0;

        // Log info for debugging
        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);

        await this.nodes.rest.updatePlayer({
            guildId: this.guildId,
            data: {
                track: { encoded: this.current.track },
            },
        });
        return this;
    }
    /**
     * Connect to the voice channel.
     * @param {Object} [options=this] - Connection options.
     * @param {string} options.guildId - The ID of the guild.
     * @param {string} options.voiceChannel - The ID of the voice channel.
     * @param {boolean} [options.deaf=true] - Whether to deaf the player.
     * @param {boolean} [options.mute=false] - Whether to mute the player.
     * @returns {Promise<Player>} The player instance.
     */
    async connect(options = this) {
        const { guildId, voiceChannel, deaf = true, mute = false } = options;
        await this.send({
            guild_id: guildId,
            channel_id: voiceChannel,
            self_deaf: deaf,
            self_mute: mute,
        });
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player has connected to voice channel: ${voiceChannel}.`);
    }
    /**
     * Disconnect the player from the voice channel.
     * @returns {Promise<Player>} The player instance.
     */
    async destroy() {
        await this.updatePlayer({ track: null });
        this.connected = false;
        this.aqua.emit("debug", this.guildId, "Player has disconnected from voice channel.");
    }

    /**
     * Pause or resume the player.
     * @param {boolean} paused - Whether to pause the player.
     * @returns {Promise<Player>} The player instance.
     */
    async pause(paused) {
        this.paused = paused;
        await this.updatePlayer({ paused });
        return this;
    }

    /**
     * Seek to a specific position in the current track.
     * @param {number} position - The position in milliseconds to seek to.
     * @returns {Promise<Player>} The player instance.
     */
    async seek(position) {
        this.position = position;
        await this.updatePlayer({ position });
        return this;
    }

    /**
     * Stop playback and clear the current track.
     * @returns {Promise<Player>} The player instance.
     */
    async stop() {
        await this.updatePlayer({ track: null });
        return this;
    }

    /**
     * Set the volume of the player.
     * @param {number} volume - The volume level (0-200).
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the volume is out of bounds.
     */
    async setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("[Volume] Volume must be between 0 and 200.");
        this.volume = volume;
        await this.updatePlayer({ volume });
        return this;
    }

    /**
     * Set the loop mode for the player.
     * @param {string} mode - The loop mode ('none', 'track', 'queue').
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
     * Send data to the player.
     * @param {Object} data - The data to send.
     * @returns {Promise<Player>} The player instance.
     */
    async send(data) {
        await this.updatePlayer(data);
        return this;
    }

    /**
     * Set the text channel for the player.
     * @param {string} channel - The ID of the text channel.
     * @returns {Promise<Player>} The player instance.
     */
    async setTextChannel(channel) {
        await this.updatePlayer({ text_channel: channel });
        return this;
    }

    /**
     * Set the voice channel for the player.
     * @param {string} channel - The ID of the voice channel.
     * @returns {Promise<Player>} The player instance.
     * @throws {TypeError} If the channel is not a string.
     * @throws {ReferenceError} If the player is already connected to the channel.
     */
    async setVoiceChannel(channel) {
        if (typeof channel !== "string") throw new TypeError("Channel must be a non-empty string.");
        if (this.connected && channel === this.voiceChannel) {
            throw new ReferenceError(`Player is already connected to ${channel}.`);
        }
        this.voiceChannel = channel;
        await this.connect({
            deaf: this.deaf,
            guildId: this.guildId,
            voiceChannel: this.voiceChannel,
            textChannel: this.textChannel,
            mute: this.mute,
        });
        return this;
    }

    /**
     * Disconnect the player from the voice channel.
     * @returns {Promise<Player>} The player instance.
     */
    async disconnect() {
        await this.updatePlayer({ track: null });
        this.connected = false;
        this.aqua.emit("debug", this.guildId, "Player has disconnected from voice channel.");
    }

    /**
     * Handle events from the player.
     * @param {Object} payload - The event payload.
     */
    async handleEvent(payload) {
        const player = this.aqua.players.get(payload.guildId);
        if (!player) return;
        switch (payload.type) {
            case "TrackStartEvent":
                this.trackStart(player, payload);
                break;
            case "TrackEndEvent":
                this.trackEnd(player, payload);
                break;
            case "TrackExceptionEvent":
                this.trackError(player, payload);
                break;
            case "TrackStuckEvent":
                this.trackStuck(player, payload);
                break;
            case "WebSocketClosedEvent":
                this.socketClosed(player, payload);
                break;
            default:
                this.handleUnknownEvent(payload);
                break;
        }
    }

    /**
     * Handle track start events.
     * @param {Object} player - The player instance.
     * @param {Object} payload - The event payload.
     */
    trackStart(player, payload) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackStart", player, payload);
    }

    /**
     * Handle track end events.
     * @param {Object} player - The player instance.
     * @param {Object} payload - The event payload.
     */
    trackEnd(player, payload) {
        this.addToPreviousTrack(this.current);
        if (["loadfailed", "cleanup"].includes(payload.reason.replace("_", "").toLowerCase())) {
            if (player.queue.length === 0) {
                this.playing = false;
                return this.aqua.emit("queueEnd", player);
            }
            this.aqua.emit("trackEnd", player, payload);
            return player.play();
        }
        if (this.loop === "track") {
            player.queue.unshift(player.previous);
            this.aqua.emit("trackEnd", player, payload);
            return player.play();
        } else if (this.loop === "queue") {
            player.queue.push(player.previous);
            this.aqua.emit("trackEnd", player, payload);
            return player.play();
        }
        if (player.queue.length === 0) {
            this.playing = false;
            return this.aqua.emit("queueEnd", player);
        } else {
            this.aqua.emit("trackEnd", player, payload);
            return player.play();
        }
    }

    /**
     * Handle track error events.
     * @param {Object} player - The player instance.
     * @param {Object} payload - The event payload.
     */
    trackError(player, payload) {
        this.aqua.emit("trackError", player, payload);
        this.stop();
    }

    /**
     * Handle track stuck events.
     * @param {Object} player - The player instance.
     * @param {Object} payload - The event payload.
     */
    trackStuck(player, payload) {
        this.aqua.emit("trackStuck", player, payload);
        this.stop();
    }

    /**
     * Handle socket closed events.
     * @param {Object} player - The player instance.
     * @param {Object} payload - The event payload.
     */
    socketClosed(player, payload) {
        if ([4015, 4009].includes(payload.code)) {
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

    /**
     * Send data to the Aqua instance.
     * @param {Object} data - The data to send.
     */
    send(data) {
        this.aqua.send({ op: 4, d: data });
    }

    /**
     * Set a custom value in the player's data.
     * @param {string} key - The key of the data.
     * @param {any} value - The value to set.
     */
    set(key, value) {
        this.data[key] = value;
    }

    /**
     * Get a custom value from the player's data.
     * @param {string} key - The key of the data.
     * @returns {any} The value associated with the key.
     */
    get(key) {
        return this.data[key];
    }

    /**
     * Clear all custom data set on the player.
     * @returns {Player} The player instance.
     */
    clearData() {
        this.data = {}; // Clear all custom data efficiently
        return this;
    }

    /**
     * Update the player with new data.
     * @param {Object} data - The data to update the player with.
     * @returns {Promise<void>}
     */
    async updatePlayer(data) {
        await this.nodes.rest.updatePlayer({
            guildId: this.guildId,
            data,
        });
    }

    /**
     * Handle unknown events from the node.
     * @param {Object} payload - The event payload.
     */
    handleUnknownEvent(payload) {
        const error = new Error(`Node encountered an unknown event: '${payload.type}'`);
        this.aqua.emit("nodeError", this, error);
    }
}

module.exports = { Player };


