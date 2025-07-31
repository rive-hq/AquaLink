'use strict'

const LEGACY_ENDPOINT_REGEX = /^([a-z\-]+)\d+/i;
const MODERN_ENDPOINT_REGEX = /^([a-z\-]+)-\d+\.discord\.media(?::\d+)?$/i;

class Connection {
  constructor(player) {
    this.player = player;
    this.voiceChannel = player.voiceChannel;
    this.guildId = player.guildId;
    this.aqua = player.aqua;
    this.nodes = player.nodes;

    this.sessionId = null;
    this.endpoint = null;
    this.token = null;
    this.region = null;
  }

  _extractRegionFromEndpoint(endpoint) {
    if (!endpoint) return null;

    const modernMatch = MODERN_ENDPOINT_REGEX.exec(endpoint);
    if (modernMatch) {
      return modernMatch[1];
    }

    const legacyMatch = LEGACY_ENDPOINT_REGEX.exec(endpoint);
    if (legacyMatch) {
      return legacyMatch[1];
    }

    this.aqua.emit('debug', `[Player ${this.guildId}] Failed to parse endpoint: ${endpoint}`);
    return 'unknown';
  }

  setServerUpdate(data) {
    const { endpoint, token } = data || {};

    if (!endpoint || !token) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Incomplete server update`);
      return;
    }

    const fullEndpoint = endpoint.trim();
    const newRegion = this._extractRegionFromEndpoint(fullEndpoint);


    if (!newRegion) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Could not extract region from endpoint: ${fullEndpoint}`);
    }

    if (this.endpoint === fullEndpoint && this.token === token && this.region === newRegion) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Voice server update - no changes detected`);
      return;
    }

    const oldRegion = this.region;
    this.endpoint = fullEndpoint;
    this.token = token;
    this.region = newRegion;


    this.aqua.emit('debug', `[Player ${this.guildId}] Voice server updated: ${oldRegion ? `${oldRegion} → ${newRegion}` : newRegion}, endpoint: ${fullEndpoint}`);

    if (this.player.paused) this.player.paused = false;
    this._updatePlayerVoiceData();
  }

  setStateUpdate(data) {
    if (!data || data.user_id !== this.aqua.clientId) return;

    const { session_id: sessionId, channel_id: channelId, self_deaf: selfDeaf, self_mute: selfMute } = data;

    if (data.channel_id) {
      if (this.voiceChannel !== channelId) {
        this.aqua.emit('playerMove', this.voiceChannel, channelId);
        this.voiceChannel = channelId;
        this.player.voiceChannel = channelId;
      }

      this.player.self_deaf = !!selfDeaf;
      this.player.self_mute = !!selfMute;
      this.sessionId = sessionId;
      this.voiceChannel = channelId;

      this.aqua.emit('debug', `[Player ${this.guildId}] Voice state updated - session: ${sessionId}, channel: ${channelId}`);
      this.player.connected = true;
    } else {
      this.aqua.emit('debug', `[Player ${this.guildId}] Voice state updated - disconnected`);
      this._destroyPlayer();

      this.voiceChannel = null;
      this.player.voiceChannel = null;
    }
  }

  _destroyPlayer() {
    this.aqua.emit('debug', `[Player ${this.guildId}] Destroying player due to voice disconnect`);
    this.player.destroy();
    this.aqua.emit('playerDestroy', this.player);
  }

  _updatePlayerVoiceData() {
    if (!this.sessionId || !this.endpoint || !this.token) {
      this.aqua.emit('debug', `[Player ${this.guildId}] Incomplete voice data, waiting... (session: ${!!this.sessionId}, endpoint: ${!!this.endpoint}, token: ${!!this.token})`);
      return;
    }

    const voiceData = {
      token: this.token,
      endpoint: this.endpoint,
      sessionId: this.sessionId
    };

    this.aqua.emit('debug', `[Player ${this.guildId}] Updating player voice data with endpoint: ${this.endpoint}`);

    try {
      this.nodes.rest.updatePlayer({
        guildId: this.guildId,
        data: {
          voice: voiceData,
          volume: this.player.volume
        }
      });
    } catch (error) {
      this.aqua.emit('debug', 'updatePlayer', {
        error: error.message,
        guildId: this.guildId,
        voiceData
      });
    }
  }
}

module.exports = Connection;
