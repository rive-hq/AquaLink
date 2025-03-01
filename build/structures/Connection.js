"use strict";

class Connection {
    constructor(player) {
        this.playerRef = new WeakRef(player);
        this.voice = { sessionId: null, endpoint: null, token: null };
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = player.voiceChannel;
        this.guildId = player.guildId;
        this.aqua = player.aqua;
        this.nodes = player.nodes;
    }

    setServerUpdate({ endpoint, token } = {}) {
        if (!endpoint) throw new Error("Missing 'endpoint' property");
        const newRegion = endpoint.split('.')[0];
        if (this.region !== newRegion) {
            this.voice = { ...this.voice, endpoint, token };
            const prevRegion = this.region;
            this.region = newRegion;
            this.aqua.emit("debug", `[Player ${this.guildId} - CONNECTION] Voice Server: ${prevRegion ? `Changed from ${prevRegion} to ${newRegion}` : newRegion}`);
            this._updatePlayerVoiceData();
        }
    }

    setStateUpdate({ channel_id, session_id, self_deaf, self_mute } = {}) {
        if (!channel_id || !session_id) {
            this.playerRef.deref()?.destroy();
            return;
        }
        
        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
        }
        
        Object.assign(this, { selfDeaf: self_deaf, selfMute: self_mute });
        this.voice.sessionId = session_id;
    }

    async _updatePlayerVoiceData() {
        const player = this.playerRef.deref();
        if (!player) return;

        try {
            await this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: { voice: this.voice, volume: player.volume }
            });
        } catch (err) {
            this.aqua.emit("apiError", "updatePlayer", { error: err, guildId: this.guildId, voiceData: this.voice });
        }
    }
}

module.exports = Connection;
