class Connection {
    constructor(player) {
        this.playerRef = new WeakRef(player);
        const { voiceChannel, guildId, aqua, nodes } = player;
        this.voice = {
            sessionId: null,
            endpoint: null,
            token: null
        };
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = voiceChannel;
        this.guildId = guildId;
        this.aqua = aqua;
        this.nodes = nodes;
    }

    setServerUpdate(data) {
        const { endpoint, token } = data || {};
        if (!endpoint) {
            throw new Error("Missing 'endpoint' property");
        }
        const regionMatch = endpoint.match(/^([a-zA-Z]+)/);
        if (!regionMatch) return;
        const newRegion = regionMatch[1];

        if (this.region !== newRegion) {
            this.voice.endpoint = endpoint;
            this.voice.token = token;
            const prevRegion = this.region;
            this.region = newRegion;
            this.aqua.emit(
                "debug",
                `[Player ${this.guildId} - CONNECTION] ${
                    prevRegion
                        ? `Changed Voice Region from ${prevRegion} to ${newRegion}`
                        : `Voice Server: ${newRegion}`
                }`
            );
        }
        this._updatePlayerVoiceData();
    }

    setStateUpdate(data) {
        const { channel_id: channelId, session_id: sessionId, self_deaf: selfDeaf, self_mute: selfMute } = data || {};
        if (!channelId || !sessionId) return;

        if (this.voiceChannel !== channelId) {
            this.aqua.emit("playerMove", this.voiceChannel, channelId);
            this.voiceChannel = channelId;
        }
        this.selfDeaf = selfDeaf;
        this.selfMute = selfMute;
        this.voice.sessionId = sessionId;
    }

    async _updatePlayerVoiceData() {
        const player = this.playerRef.deref();
        if (!player) return;
        try {
            await this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: {
                    voice: this.voice,
                    volume: player.volume
                }
            });
        } catch (err) {
            this.aqua.emit("apiError", "updatePlayer", err);
        }
    }
}

module.exports = { Connection };
