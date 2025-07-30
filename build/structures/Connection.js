"use strict";

const REGION_REGEX = /^([a-z0-9-]+)/i;

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

    setServerUpdate(data) {
        if (!data?.endpoint || !data.token) {
            this.aqua.emit("debug", `[Player ${this.guildId}] Received incomplete server update.`);
            return;
        }

        const { endpoint, token } = data;
        const regionMatch = REGION_REGEX.exec(endpoint);


        if (!regionMatch) {
            this.aqua.emit("debug", `[Player ${this.guildId}] Failed to extract region from endpoint: ${endpoint}`);
            return;
        }
        const newRegion = regionMatch[1];

        if (this.endpoint === endpoint && this.token === token && this.region === newRegion) {
            return;
        }

        const oldRegion = this.region;
        this.endpoint = endpoint;
        this.token = token;
        this.region = newRegion;

        this.aqua.emit("debug",
            `[Player ${this.guildId}] Voice server updated: ${oldRegion ? `Changed from ${oldRegion} to ${newRegion}` : newRegion}`
        );

        if (this.player.paused) {
            this.player.paused = false;
        }

        this._updatePlayerVoiceData();
    }

    setStateUpdate(data) {
        if (!data || data.user_id !== this.aqua.clientId) {
            return;
        }

        const { session_id, channel_id, self_deaf, self_mute } = data;

        if (!channel_id || !session_id) {
            this._destroyPlayer();
            return;
        }

        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
            this.player.voiceChannel = channel_id;
        }

        this.player.selfDeaf = !!self_deaf;
        this.player.selfMute = !!self_mute;

        this.sessionId = session_id || this.sessionId || null;
    }

    _destroyPlayer() {
        if (this.player && !this.player.destroyed) {
            this.player.destroy();
            this.aqua.emit("playerDestroy", this.player);
        }
    }

    _updatePlayerVoiceData() {
        if (!this.player || !this.sessionId || !this.endpoint || !this.token) {
            this.aqua.emit("debug", `[Player ${this.guildId}] Incomplete voice data, waiting...`);
            return;
        }

        const voiceData = {
            token: this.token,
            endpoint: this.endpoint,
            sessionId: this.sessionId,
        };

        try {
            this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: { voice: voiceData, volume: this.player.volume },
            })
        } catch (error) {
            this.aqua.emit("debug", "updatePlayer", {
                error,
                guildId: this.guildId,
                voiceData
            });
        }
    }
}

module.exports = Connection;
