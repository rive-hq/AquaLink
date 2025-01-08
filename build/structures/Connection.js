class Connection {
    constructor(player) {
      Object.assign(this, {
        player,
        voice: { sessionId: null, endpoint: null, token: null },
        region: null,
        selfDeaf: false,
        selfMute: false,
        voiceChannel: player.voiceChannel,
        _guildId: player.guildId,
        _aqua: player.aqua,
        _nodes: player.nodes
      });
    }
  
    setServerUpdate(data) {
      const endpoint = data.endpoint;
      if (!endpoint) throw new Error("Missing 'endpoint' property");
  
      const dotIndex = endpoint.indexOf('.');
      if (dotIndex === -1) return;
      
      const newRegion = endpoint.substring(0, dotIndex).replace(/[0-9]/g, '');
      
      if (this.region !== newRegion) {
        const prevRegion = this.region;
        
        Object.assign(this.voice, {
          endpoint,
          token: data.token
        });
        this.region = newRegion;
  
        this._aqua.emit(
          "debug",
          `[Player ${this._guildId} - CONNECTION] ${
            prevRegion 
              ? `Changed Voice Region from ${prevRegion} to ${newRegion}`
              : `Voice Server: ${newRegion}`
          }`
        );
      }
  
      this._updatePlayerVoiceData();
    }
  

    setStateUpdate(data) {
      const channelId = data.channel_id;
      const sessionId = data.session_id;
  
      if (!channelId || !sessionId) {
        this._cleanup();
        return;
      }

      if (this.voiceChannel !== channelId) {
        this._aqua.emit("playerMove", this.voiceChannel, channelId);
        this.voiceChannel = channelId;
      }
  
      Object.assign(this, {
        selfDeaf: data.self_deaf,
        selfMute: data.self_mute
      });
      this.voice.sessionId = sessionId;
    }
  
    _updatePlayerVoiceData() {
      this._nodes.rest.updatePlayer({
        guildId: this._guildId,
        data: {
          voice: this.voice,
          volume: this.player.volume
        }
      }).catch(err => {
        this._aqua.emit("apiError", "updatePlayer", err);
      });
    }
  
    _cleanup() {
      const aqua = this._aqua;
      const channel = this.player.voiceChannel;
      
      aqua.emit("playerLeave", channel);
      
      this.player.voiceChannel = null;
      this.voiceChannel = null;
      this.player.destroy();
      
      aqua.emit("playerDestroy", this.player);
  
      Object.assign(this, {
        player: null,
        voice: null,
        region: null,
        selfDeaf: null,
        selfMute: null,
        _guildId: null,
        _aqua: null,
        _nodes: null
      });
    }
  }
  
  module.exports = { Connection };
