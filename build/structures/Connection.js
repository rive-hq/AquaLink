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
        if (!data || !data.endpoint) return;
        
        const endpoint = data.endpoint;
        const token = data.token;
        
        const dotIndex = endpoint.indexOf('.');
        if (dotIndex === -1) return;
        
        const newRegion = endpoint.substring(0, dotIndex);
        
        if (this.region !== newRegion) {
            this.endpoint = endpoint;
            this.token = token;
            
            const prevRegion = this.region;
            this.region = newRegion;
            
            if (this.aqua.listenerCount('debug') > 0) {
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
        if (!data) return;
        
        const channel_id = data.channel_id;
        const session_id = data.session_id;
        
        if (!channel_id || !session_id) {
            const player = this.playerRef.deref();
            if (player) player.destroy();
            return;
        }
        
        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
        }
        
        this.selfDeaf = !!data.self_deaf;
        this.selfMute = !!data.self_mute;
        this.sessionId = session_id;
    }

    async _updatePlayerVoiceData() {
        const player = this.playerRef.deref();
        if (!player) return;

        try {
            const voiceData = {
                sessionId: this.sessionId,
                endpoint: this.endpoint,
                token: this.token
            };
            
            await this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: { 
                    voice: voiceData, 
                    volume: player.volume 
                }
            });
        } catch (err) {
            if (this.aqua.listenerCount('apiError') > 0) {
                this.aqua.emit("apiError", "updatePlayer", { 
                    error: err, 
                    guildId: this.guildId, 
                    voiceData: { 
                        sessionId: this.sessionId, 
                        endpoint: this.endpoint, 
                        token: this.token 
                    } 
                });
            }
        }
    }
}

module.exports = Connection;
