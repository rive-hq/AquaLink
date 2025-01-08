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

        this._boundPlayerUpdate = this.onPlayerUpdate.bind(this);
        this._boundHandleEvent = this.handleEvent.bind(this);

        this.on("playerUpdate", this._boundPlayerUpdate);
        this.on("event", this._boundHandleEvent);
    }

    onPlayerUpdate(packet) {
        if (!packet?.state) return;
        const { state } = packet;
        const { connected, position, ping, time } = state;
        this.connected = connected;
        this.position = position;
        this.ping = ping;
        this.timestamp = time;
        this.aqua.emit("playerUpdate", this, packet);
    }

    get previous() {
        return this.previousTracks.length ? this.previousTracks[0] : null;
    }

    addToPreviousTrack(track) {
        if (this.previousTracks.length >= 50) {
            this.previousTracks.pop();
        }
        this.previousTracks.unshift(track);
    }
    /**
     * Play the next track in the queue.
     *
     * @throws {Error} If the player is not connected.
     * @returns {Promise<Player>} The player instance.
     */
    play() {
        if (!this.connected) throw new Error("Player must be connected first.");
        if (!this.queue.length) return;

        const track = this.queue.shift();
        this.current = track.track ? track : track.resolve(this.aqua);

        this.playing = true;
        this.position = 0;

        this.aqua.emit("debug", this.guildId, `Playing track: ${this.current.track}`);
        this.updatePlayer({ track: { encoded: this.current.track } });
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
    connect(options) {
        if (this.connected) throw new Error("Player is already connected.");

        const {
            guildId,
            voiceChannel,
            deaf = true,
            mute = false
        } = options;

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
    /**
     * Pauses or resumes the player.
     *
     * @param {boolean} paused - If true, the player will be paused; if false, it will resume.
     * @returns {Promise<Player>} The player instance.
     */

    pause(paused) {
        this.paused = paused;
        this.updatePlayer({ paused });
        return this;
    }
    /**
     * Seeks to a position in the currently playing track.
     *
     * @param {number} position - The position in milliseconds to seek to.
     * @throws {Error} If the position is negative.
     * @returns {Promise<Player>} The player instance.
     */
    seek(position) {
        if (position < 0) throw new Error("Seek position cannot be negative.");
        if (!this.playing) return this;

        this.position = position;
        this.updatePlayer({ position });
        return this;
    }
    stop() {
        if (!this.playing) return this;
        this.updatePlayer({ track: { encoded: null } });
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
    setVolume(volume) {
        if (volume < 0 || volume > 200) throw new Error("Volume must be between 0 and 200.");
        this.volume = volume;
        this.updatePlayer({ volume });
        return this;
    }
    /**
     * Sets the loop mode of the player.
     *
     * @param {string} mode - The loop mode to set, either "none", "track", or "queue".
     * @throws {Error} If the mode is not one of the above.
     * @returns {Promise<Player>} The player instance.
     */
    setLoop(mode) {
        const validModes = new Set(["none", "track", "queue"]);
        if (!validModes.has(mode)) throw new Error("Loop mode must be 'none', 'track', or 'queue'.");
        this.loop = mode;
        this.updatePlayer({ loop: mode });
        return this;
    }
    /**
       * Sets the text channel for the player.
       *
       * @param {string} channel - The ID of the text channel to set.
       * @returns {Promise<Player>} The player instance.
       */

    setTextChannel(channel) {
        this.updatePlayer({ text_channel: channel });
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
        const len = this.queue.length;
        for (let i = len - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
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

    static EVENT_HANDLERS = new Map([
        ["TrackStartEvent", "trackStart"],
        ["TrackEndEvent", "trackEnd"],
        ["TrackExceptionEvent", "trackError"],
        ["TrackStuckEvent", "trackStuck"],
        ["TrackChangeEvent", "trackChange"],
        ["WebSocketClosedEvent", "socketClosed"]
    ]);

    handleEvent = (payload) => {
        const player = this.aqua.players.get(payload.guildId);
        if (!player) return;

        const track = player.current;
        const handlerName = Player.EVENT_HANDLERS.get(payload.type);

        if (handlerName) {
            this[handlerName](player, track, payload);
        } else {
            this.handleUnknownEvent(player, track, payload);
        }
    }

    trackStart(player, track) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackStart", player, track);
    }

    trackChange(player, track) {
        this.playing = true;
        this.paused = false;
        this.aqua.emit("trackChange", player, track);
    }

    async trackEnd(player, track, payload) {
        if (this.shouldDeleteMessage && this.nowPlayingMessage) {
            try {
                await this.nowPlayingMessage.delete();
            } catch {
                // Ignore errors
            } finally {
                this.nowPlayingMessage = null;
            }
        }

        const reason = payload.reason.replace("_", "").toLowerCase();

        if (reason === "loadfailed" || reason === "cleanup") {
            if (player.queue.isEmpty()) {
                this.aqua.emit("queueEnd", player);
                return;
            }
            return player.play();
        }

        switch (this.loop) {
            case "track":
                this.aqua.emit("trackRepeat", player, track);
                player.queue.unshift(track);
                break;
            case "queue":
                this.aqua.emit("queueRepeat", player, track);
                player.queue.push(track);
                break;
        }

        if (player.queue.isEmpty()) {
            this.playing = false;
            this.aqua.emit("queueEnd", player);
            return this.cleanup();
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

    #dataStore = new WeakMap();

    set(key, value) {
        this.#dataStore.set(key, value);
    }

    get(key) {
        return this.#dataStore.get(key);
    }

    clearData() {
        this.#dataStore = new WeakMap();
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
