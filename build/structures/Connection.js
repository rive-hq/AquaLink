class Connection {
  constructor(player) {
    this.player = player;
    this.voice = {
      sessionId: null,
      endpoint: null,
      token: null
    };
    this.region = null;
    this.selfDeaf = false;
    this.selfMute = false;
    this.voiceChannel = player.voiceChannel;
    this.guildId = player.guildId;
    this.aqua = player.aqua;
    this.nodes = player.nodes;
  }

  setServerUpdate(data) {
    if (!data?.endpoint) {
      throw new Error("Missing 'endpoint' property");
    }

    const endpoint = data.endpoint;
    const regionMatch = endpoint.match(/^([a-zA-Z]+)/);
    if (!regionMatch) return;

    const newRegion = regionMatch[1];
    if (this.region !== newRegion) {
      this.voice.endpoint = endpoint;
      this.voice.token = data.token;
      
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
    const { channel_id: channelId, session_id: sessionId, self_deaf: selfDeaf, self_mute: selfMute } = data;

    if (!channelId || !sessionId) {
      this._cleanup();
      return;
    }

    if (this.voiceChannel !== channelId) {
      this.aqua.emit("playerMove", this.voiceChannel, channelId);
      this.voiceChannel = channelId;
    }

    this.selfDeaf = selfDeaf;
    this.selfMute = selfMute;
    this.voice.sessionId = sessionId;
  }

  async _updatePlayerVoiceData() {
    try {
      await this.nodes.rest.updatePlayer({
        guildId: this.guildId,
        data: {
          voice: this.voice,
          volume: this.player.volume
        }
      });
    } catch (err) {
      this.aqua.emit("apiError", "updatePlayer", err);
    }
  }

  _cleanup() {
    const { aqua, player, voiceChannel } = this;
    
    aqua.emit("playerLeave", voiceChannel);
    
    player.voiceChannel = null;
    this.voiceChannel = null;
    player.destroy();
    
    aqua.emit("playerDestroy", player);
    this.player = null;
    this.voice = null;
    this.region = null;
    this.selfDeaf = null;
    this.selfMute = null;
    this.guildId = null;
    this.aqua = null;
    this.nodes = null;
  }
}

module.exports = { Connection };
