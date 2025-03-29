"use strict";

class Connection {
    constructor(player) {
        this.playerRef = new WeakRef(player);
        
        this.sessionId = null;
        this.endpoint = null;
        this.token = null;
        
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = player.voiceChannel;
        this.guildId = player.guildId;
        
        this.aqua = player.aqua;
        this.nodes = player.nodes;
    }

    setServerUpdate(data) {
        if (!data?.endpoint) return;
        
        const { endpoint, token } = data;
        const dotIndex = endpoint.indexOf('.');
        
        if (dotIndex === -1) return;
        const newRegion = endpoint.substring(0, dotIndex);
        
        if (this.region !== newRegion) {
            const prevRegion = this.region;
            [this.endpoint, this.token, this.region] = [endpoint, token, newRegion];
            
            if (this.aqua.listenerCount('debug')) {
                this.aqua.emit(
                    "debug",
                    `[Player ${this.guildId} - CONNECTION] Voice Server: ${
                        prevRegion ? `Changed from ${prevRegion} to ${newRegion}` : newRegion
                    }`
                );
            }
            
            this._updatePlayerVoiceData();
        }
    }

    setStateUpdate(data) {
        const { channel_id, session_id, self_deaf, self_mute } = data || {};
        
        if (!channel_id || !session_id) {
            this.playerRef.deref()?.destroy();
            return;
        }
        
        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
        }
        
        this.selfDeaf = !!self_deaf;
        this.selfMute = !!self_mute;
        this.sessionId = session_id;
    }

    async _updatePlayerVoiceData() {
        const player = this.playerRef.deref();
        if (!player) return;

        try {
            await this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: { 
                    voice: {
                        sessionId: this.sessionId,
                        endpoint: this.endpoint,
                        token: this.token
                    }, 
                    volume: player.volume 
                }
            });
        } catch (error) {
            if (this.aqua.listenerCount('apiError')) {
                this.aqua.emit("apiError", "updatePlayer", { 
                    error,
                    guildId: this.guildId,
                    voiceData: { ...this }
                });
            }
        }
    }
}

module.exports = Connection;
