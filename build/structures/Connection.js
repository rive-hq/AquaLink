/**
 * Class representing a player connection.
 * @param {Player} player The player instance of this connection.
 */
class Connection {
    constructor(player) {
        this.player = player;
        this.voice = { sessionId: null, endpoint: null, token: null };
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = player.voiceChannel;
        this.lastUpdateTime = 0; // Track the last update time to throttle updates
        this.updateThrottle = 1000; // Throttle updates to every 1000 ms (1 second)
    }

    /**
     * Sets the server update data (endpoint and token) for the player.
     * @param {object} data The server update data from the VOICE_SERVER_UPDATE packet.
     * @param {string} data.endpoint The endpoint URL of the voice server.
     * @param {string} data.token The token for the voice server.
     */
    setServerUpdate({ endpoint, token }) {
        if (!endpoint) {
            throw new Error("Missing 'endpoint' property in VOICE_SERVER_UPDATE packet/payload. Please wait or disconnect the bot from the voice channel and try again.");
        }

        const previousVoiceRegion = this.region;
        this.voice.endpoint = endpoint;
        this.voice.token = token;
        this.region = endpoint.split(".")[0].replace(/[0-9]/g, "");

        this.player.aqua.emit("debug", `[Player ${this.player.guildId} - CONNECTION] ${previousVoiceRegion ? `Changed Voice Region from ${previousVoiceRegion} to ${this.region}` : `Voice Server: ${this.region}`}`);

        if (this.player.paused) {
            this.player.pause(false);
        }

        this.updatePlayerVoiceData();
    }

    /**
     * Sets the state update data (session_id, channel_id, self_deaf, and self_mute) for the player.
     * @param {object} data The state update data from the VOICE_STATE_UPDATE packet.
     * @param {string} data.session_id The session id of the voice server.
     * @param {string} data.channel_id The voice channel id of the player.
     * @param {boolean} data.self_deaf The self-deafened status of the player.
     * @param {boolean} data.self_mute The self-muted status of the player.
     */
    setStateUpdate({ session_id, channel_id, self_deaf, self_mute }) {
        if (channel_id == null || session_id == null) {
            this.player.aqua.emit("playerLeave", this.player.voiceChannel);
            this.player.voiceChannel = null;
            this.voiceChannel = null;
            this.player.destroy();
            this.player.aqua.emit("playerDestroy", this.player);
            return;
        }

        if (this.player.voiceChannel !== channel_id) {
            this.player.aqua.emit("playerMove", this.player.voiceChannel, channel_id);
            this.player.voiceChannel = channel_id;
            this.voiceChannel = channel_id;
        }

        this.selfDeaf = self_deaf;
        this.selfMute = self_mute;
        this.voice.sessionId = session_id;

        this.updatePlayerVoiceData();
    }

    /**
     * Updates the player voice data.
     */
    updatePlayerVoiceData() { 
        this.player.nodes.rest.updatePlayer({ 
            guildId: this.player.guildId, 
            data: { 
                voice: this.voice, 
                volume: this.player.volume 
            } 
        }); 
    } 
} 

module.exports = { Connection };