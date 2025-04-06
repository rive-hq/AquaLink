"use strict";

class Connection {
    constructor(player) {
        this.player = player;
        
        this.sessionId = null;
        this.endpoint = null;
        this.token = null;
        this.region = null;
        
        this.voiceChannel = player.voiceChannel;
        this.guildId = player.guildId;
        this.aqua = player.aqua;
        this.nodes = player.nodes;
        
        this.selfDeaf = false;
        this.selfMute = false;
        
        this.hasDebugListeners = this.aqua.listenerCount('debug') > 0;
    }

    setServerUpdate(data) {
        if (!data || !data.endpoint) return;
        
        const { endpoint, token } = data;
        
        const dotIndex = endpoint.indexOf('.');
        if (dotIndex === -1) return;
        
        const newRegion = endpoint.substring(0, dotIndex);
        
        if (this.region !== newRegion) {
            this.endpoint = endpoint;
            this.token = token;
            this.region = newRegion;
            
            if (this.hasDebugListeners) {
                this.aqua.emit(
                    "debug",
                    `[Player ${this.guildId} - CONNECTION] Voice Server: ${
                        this.region ? `Changed from ${this.region} to ${newRegion}` : newRegion
                    }`
                );
            }
            
            this._updatePlayerVoiceData();
        }
    }

    setStateUpdate(data) {
        if (!data) return this.player?.destroy();
        
        const { channel_id, session_id, self_deaf, self_mute } = data;
        
        if (!channel_id || !session_id) {
            this.player?.destroy();
            return;
        }
        
        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
        }
        
        this.selfDeaf = Boolean(self_deaf);
        this.selfMute = Boolean(self_mute);
        this.sessionId = session_id;
    }

    _updatePlayerVoiceData() {
        if (!this.player) return;

        const voiceData = {
            sessionId: this.sessionId,
            endpoint: this.endpoint,
            token: this.token
        };

        this.nodes.rest.updatePlayer({
            guildId: this.guildId,
            data: { 
                voice: voiceData, 
                volume: this.player.volume 
            }
        }).catch(error => {
            if (this.aqua.listenerCount('apiError') > 0) {
                this.aqua.emit("apiError", "updatePlayer", { 
                    error,
                    guildId: this.guildId,
                    voiceData
                });
            }
        });
    }
}

module.exports = Connection;
