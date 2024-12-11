const { EventEmitter } = require("events");
const { Connection } = require("./Connection");
const { Queue } = require("./Queue");
const { Filters } = require("./Filters");
 
class Player extends EventEmitter {
    /**
     * @param {Object} aqua - The Aqua instance.
     * @param {Object} nodes - The node instances.
     * @param {Object} options - Configuration options for the player.
     * @param {string} options.guildId - The ID of the guild.
     * @param {string} options.textChannel - The ID of the text channel.
     * @param {string} options.voiceChannel - The ID of the voice channel.
     * @param {boolean} [options.mute=false] - Whether the player is muted.
     * @param {boolean} [options.deaf=false] - Whether the player is deafened.
     * @param {number} [options.defaultVolume=100] - The default volume level (0-200).
     * @param {string} [options.loop='none'] - The loop mode ('none', 'track', 'queue').
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
        this.data = {};
        this.queue = new Queue();
        this.position = 0;
        this.current = null;
        this.playing = false;
        this.paused = false;
        this.connected = false;
        this.timestamp = 0;
        this.ping = 0;
        this.nowPlayingMessage = null;
        this.previousTracks = new Array();
        this.shouldDeleteMessage = options.shouldDeleteMessage ?? true;

        this.setupEventListeners();
    }

    /**
     * Sets up event listeners for player events.
     */
    setupEventListeners() {
        this.on("playerUpdate", this.onPlayerUpdate.bind(this));
        this.on("event", this.handleEvent.bind(this));
    }

    /**
     * Handles player update events.
     * @param {Object} packet - The packet containing the player update data.
     */
    onPlayerUpdate(packet) {
        const { state } = packet;
        this.connected = state.connected;
        this.position = state.position;
        this.ping = state.ping;
        this.timestamp = state.time;
    this.aqua.emit("playerUpdate", this, packet);
    }


    /**
     * Gets the previous track.
     * @returns {Object|null} The previous track or null if none exists.
     */
    get previous() {
        return this.previousTracks[0] || null;
    }

    /**
     * Adds a track to the previous tracks list.
     * @param {Object} track - The track object to add.
     */
    addToPreviousTrack(track) {
        this.previousTracks.unshift(track);
    }

    /**
     * Plays the next track in the queue.
     * @param {Object} options - Options for playing the next track.
     * @param {string} options.query - The query to search for the next track.
     * @param {boolean} options.force - Whether to force play the next track even if the queue is empty.
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is not connected.
     * @throws {Error} If the queue is empty and force is not set to true.
     * @description This method plays the next track in the queue.
     * @event play
     */
    async play() {
    if (!this.connected) throw new Error("Bro go on and use the connection first");
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
     * @param {Object} options - Options for connecting the player.
     * @param {string} options.guildId - The guild ID to connect to.
     * @param {string} options.voiceChannel - The ID of the voice channel to connect to.
     * @param {boolean} [options.deaf=true] - Whether the player should be deafened.
     * @param {boolean} [options.mute=false] - Whether the player should be muted.
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the player is already connected.
     * @description This method connects the player to a voice channel.
     * @event ready
     */
    async connect(options) {
        if (this.connected) throw new Error("Player is already connected.");
        
        const { guildId, voiceChannel, deaf = true, mute = false } = options;
        await this.send({ guild_id: guildId, channel_id: voiceChannel, self_deaf: deaf, self_mute: mute });
        this.connected = true;
        this.aqua.emit("debug", this.guildId, `Player connected to voice channel: ${voiceChannel}.`);
        return this;
    }

    /**
     * Destroys the player instance.
     * @returns {Promise<void>} The result of the destroy method.
     * @description This method destroys the player instance and clears all data.
     * @event destroy
     */
    async destroy() {
        await this.disconnect();
        this.clearData();
        if (this.nowPlayingMessage) {
            try {
                await this.nowPlayingMessage.delete();
            } catch (error) {
                console.error("Failed to delete now playing message:", error);
            }
            this.nowPlayingMessage = null;
        }
        return this;
    }

    /**
     * Pauses the player.
     * @param {boolean} paused - Whether the player should be paused.
     * @returns {Promise<Player>} The player instance.
     * @description This method pauses the player.
     * @event pause
     */
    async pause(paused) {
        this.paused = paused;
        await this.updatePlayer({ paused });
        return this;
    }

    /**
     * Seeks the player to a specific position.
     * @param {number} position - The position to seek to in milliseconds.
     * @returns {Promise<Player>} The player instance.
     * @description This method seeks the player to a specific position.
     * @event seek
     */
    async seek(position) {
        if (position < 0) throw new Error("Seek position cannot be negative.");
        this.position = position;
        await this.updatePlayer({ position });
        return this;
    }

    /**
     * Stops the player.
     * @returns {Promise<Player>} The player instance.
     * @description This method stops the player.
     * @event stop
     */
    async stop() {
        if (!this.playing) return this;

        this.playing = false;
        this.current = null;
        this.position = 0;
        await this.updatePlayer({ track: { encoded: null } });
        return this;
    }


    /**
     * Sets the volume of the player.
     * @param {number} volume - The volume to set between 0 and 200.
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the volume is not between 0 and 200.
     * @description This method sets the volume of the player.
     * @event volumeChange
     */
    async setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("[Volume] Volume must be between 0 and 200.");
        this.volume = volume;
        await this.updatePlayer({ volume });
        return this;
    }

    /**
     * Sets the loop mode of the player.
     * @param {string} mode - The loop mode to set, either 'none', 'track', or 'queue'.
     * @returns {Promise<Player>} The player instance.
     * @throws {Error} If the loop mode is not 'none', 'track', or 'queue'.
     * @description This method sets the loop mode of the player.
     * @event loopChange
     */
    async setLoop(mode) {
        if (!["none", "track", "queue"].includes(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        await this.updatePlayer({ loop: mode });
        return this;
    }
    /**
     * Sets the text channel of the player.
     * @param {string} channel - The ID of the text channel to set.
     * @returns {Promise<Player>} The player instance.
     * @description This method sets the text channel of the player.
     * @event textChannelChange
     */
    async setTextChannel(channel) {
        await this.updatePlayer({ text_channel: channel });
        return this;
    }

    /**
     * Sets the voice channel of the player.
     * @param {string} channel - The ID of the voice channel to set.
     * @returns {Promise<Player>} The player instance.
     * @description This method sets the voice channel of the player.
     * @event voiceChannelChange
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
     * Disconnects the player from the voice channel.
     * @returns {Promise<void>} The result of the disconnect method.
     * @description This method disconnects the player from the voice channel.
     * @event disconnect
     */
    async disconnect() {
        await this.updatePlayer({ track: { encoded: null } });
        await this.send({ guild_id: this.guildId, channel_id: null });
        this.connected = false;
        this.aqua.emit("debug", this.guildId, "Player disconnected from voice channel.");
    }
    /**
     * Shuffles the queue of the player.
     * @returns {Promise<Player>} The player instance.
     * @description This method shuffles the queue of the player.
     * @event shuffle
     */
    async shuffle() {
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
        return this;
    }

    /**
     * Gets the queue of the player.
     * @returns {Array<Object>} The queue of the player.
     * @description This method gets the queue of the player.
     * @event getQueue
     */
    async getQueue() {
        return this.queue;
    }

    /**
     * Replays the current track from the start.
     * @returns {Promise<Player>} The player instance.
     * @description This method replays the current track from the start.
     * @event replay
     */
    async replay() {
        return this.seek(0);
    }


    /**
     * Skips the current track.
     * @returns {Promise<Player>} The player instance.
     * @description This method skips the current track.
     * @event skip
     */
    async skip() {
        await this.stop(); 
        return this.play(); 
    }
    async handleEvent(payload) {
        const player = this.aqua.players.get(payload.guildId);
        if (!player) return;

        const track = player.current; 

        const eventHandlers = {
            TrackStartEvent: this.trackStart.bind(this),
            TrackEndEvent: this.trackEnd.bind(this),
            TrackExceptionEvent: this.trackError.bind(this),
            TrackStuckEvent: this.trackStuck.bind(this),
            TrackChangeEvent: this.trackChange.bind(this),
            WebSocketClosedEvent: this.socketClosed.bind(this),
        };

        const handler = eventHandlers[payload.type] || this.handleUnknownEvent.bind(this);
        handler(player, track, payload);
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
        if (["loadfailed", "cleanup"].includes(reason)) {
            return player.queue.isEmpty() ? this.aqua.emit("queueEnd", player) : player.play();
        }

        this.addToPreviousTrack(track);

        if (this.loop === "track") {
            this.aqua.emit("trackRepeat", player, track, payload);
            player.queue.unshift(this.previous);
        } else if (this.loop === "queue") {
            this.aqua.emit("queueRepeat", player, track, payload);
            player.queue.push(this.previous);
        } else {
            this.aqua.emit("trackEnd", player, track, payload);
            await this.cleanup();
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
        this.data = {};
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
