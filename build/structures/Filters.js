"use strict";

class Filters {
    constructor(player, options = {}) {
        this.player = player;
        this.volume = options.volume ?? 1;
        this.equalizer = options.equalizer ?? [];
        this.karaoke = options.karaoke ?? null;
        this.timescale = options.timescale ?? null;
        this.tremolo = options.tremolo ?? null;
        this.vibrato = options.vibrato ?? null;
        this.rotation = options.rotation ?? null;
        this.distortion = options.distortion ?? null;
        this.channelMix = options.channelMix ?? null;
        this.lowPass = options.lowPass ?? null;
        this.bassboost = options.bassboost ?? null;
        this.slowmode = options.slowmode ?? null;
        this.nightcore = options.nightcore ?? null;
        this.vaporwave = options.vaporwave ?? null;
        this._8d = options._8d ?? null;
    }

    setEqualizer(bands) {
        this.equalizer = bands;
        return this.updateFilters();
    }

    setKaraoke(enabled, options = {}) {
        this.karaoke = enabled ? {
            level: options.level ?? 1.0,
            monoLevel: options.monoLevel ?? 1.0,
            filterBand: options.filterBand ?? 220.0,
            filterWidth: options.filterWidth ?? 100.0
        } : null;
        return this.updateFilters();
    }

    setTimescale(enabled, options = {}) {
        this.timescale = enabled ? {
            speed: options.speed ?? 1.0,
            pitch: options.pitch ?? 1.0,
            rate: options.rate ?? 1.0
        } : null;
        return this.updateFilters();
    }

    setTremolo(enabled, options = {}) {
        this.tremolo = enabled ? {
            frequency: options.frequency ?? 2.0,
            depth: options.depth ?? 0.5
        } : null;
        return this.updateFilters();
    }

    setVibrato(enabled, options = {}) {
        this.vibrato = enabled ? {
            frequency: options.frequency ?? 2.0,
            depth: options.depth ?? 0.5
        } : null;
        return this.updateFilters();
    }

    setRotation(enabled, options = {}) {
        this.rotation = enabled ? {
            rotationHz: options.rotationHz ?? 0.0
        } : null;
        return this.updateFilters();
    }

    setDistortion(enabled, options = {}) {
        this.distortion = enabled ? {
            sinOffset: options.sinOffset ?? 0.0,
            sinScale: options.sinScale ?? 1.0,
            cosOffset: options.cosOffset ?? 0.0,
            cosScale: options.cosScale ?? 1.0,
            tanOffset: options.tanOffset ?? 0.0,
            tanScale: options.tanScale ?? 1.0,
            offset: options.offset ?? 0.0,
            scale: options.scale ?? 1.0
        } : null;
        return this.updateFilters();
    }

    setChannelMix(enabled, options = {}) {
        this.channelMix = enabled ? {
            leftToLeft: options.leftToLeft ?? 1.0,
            leftToRight: options.leftToRight ?? 0.0,
            rightToLeft: options.rightToLeft ?? 0.0,
            rightToRight: options.rightToRight ?? 1.0
        } : null;
        return this.updateFilters();
    }

    setLowPass(enabled, options = {}) {
        this.lowPass = enabled ? {
            smoothing: options.smoothing ?? 20.0
        } : null;
        return this.updateFilters();
    }

    setBassboost(enabled, options = {}) {
        if (enabled) {
            const value = options.value ?? 5;
            if (value < 0 || value > 5) throw new Error("Bassboost value must be between 0 and 5");
            this.bassboost = value;
            const num = (value - 1) * (1.25 / 9) - 0.25;
            return this.setEqualizer(Array(13).fill(0).map((_, i) => ({
                band: i,
                gain: num
            })));
        }
        this.bassboost = null;
        return this.setEqualizer([]);
    }

    setSlowmode(enabled, options = {}) {
        this.slowmode = enabled;
        return this.setTimescale(enabled, { rate: enabled ? options.rate ?? 0.8 : 1.0 });
    }

    setNightcore(enabled, options = {}) {
        this.nightcore = enabled;
        if (enabled) {
            return this.setTimescale(true, { rate: options.rate ?? 1.5 });
        }
        return this.setTimescale(false);
    }

    setVaporwave(enabled, options = {}) {
        this.vaporwave = enabled;
        if (enabled) {
            return this.setTimescale(true, { pitch: options.pitch ?? 0.5 });
        }
        return this.setTimescale(false);
    }

    set8D(enabled, options = {}) {
        this._8d = enabled;
        return this.setRotation(enabled, { rotationHz: enabled ? options.rotationHz ?? 0.2 : 0.0 });
    }

    async clearFilters() {
        Object.assign(this, new Filters(this.player));
        await this.updateFilters();
        return this;
    }

    async updateFilters() {
        const filterData = {
            volume: this.volume,
            equalizer: this.equalizer,
            karaoke: this.karaoke,
            timescale: this.timescale,
            tremolo: this.tremolo,
            vibrato: this.vibrato,
            rotation: this.rotation,
            distortion: this.distortion,
            channelMix: this.channelMix,
            lowPass: this.lowPass
        };

        await this.player.nodes.rest.updatePlayer({
            guildId: this.player.guildId,
            data: { filters: filterData }
        });

        return this;
    }
}

module.exports = Filters