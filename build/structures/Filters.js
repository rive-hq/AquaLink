"use strict";

class Filters {
    constructor(player, options = {}) {
        this.player = player;
        this.volume = options.volume || 1;
        this.equalizer = options.equalizer || [];
        this.karaoke = options.karaoke || null;
        this.timescale = options.timescale || null;
        this.tremolo = options.tremolo || null;
        this.vibrato = options.vibrato || null;
        this.rotation = options.rotation || null;
        this.distortion = options.distortion || null;
        this.channelMix = options.channelMix || null;
        this.lowPass = options.lowPass || null;
        this.bassboost = options.bassboost || null;
        this.slowmode = options.slowmode || null;
        this.nightcore = options.nightcore || null;
        this.vaporwave = options.vaporwave || null;
        this._8d = options._8d || null;
        
        this._filterDataTemplate = {
            volume: this.volume,
            equalizer: this.equalizer,
            karaoke: null,
            timescale: null,
            tremolo: null,
            vibrato: null,
            rotation: null,
            distortion: null,
            channelMix: null,
            lowPass: null
        };
    }

    _setFilter(filterName, enabled, options, defaults) {
        if (!enabled) {
            this[filterName] = null;
            return this.updateFilters();
        }
        
        const filterObj = {};
        for (const [key, defaultValue] of Object.entries(defaults)) {
            filterObj[key] = options[key] !== undefined ? options[key] : defaultValue;
        }
        
        this[filterName] = filterObj;
        return this.updateFilters();
    }

    setEqualizer(bands) {
        this.equalizer = bands;
        return this.updateFilters();
    }

    setKaraoke(enabled, options = {}) {
        return this._setFilter('karaoke', enabled, options, {
            level: 1.0,
            monoLevel: 1.0,
            filterBand: 220.0,
            filterWidth: 100.0
        });
    }

    setTimescale(enabled, options = {}) {
        return this._setFilter('timescale', enabled, options, {
            speed: 1.0,
            pitch: 1.0,
            rate: 1.0
        });
    }

    setTremolo(enabled, options = {}) {
        return this._setFilter('tremolo', enabled, options, {
            frequency: 2.0,
            depth: 0.5
        });
    }

    setVibrato(enabled, options = {}) {
        return this._setFilter('vibrato', enabled, options, {
            frequency: 2.0,
            depth: 0.5
        });
    }

    setRotation(enabled, options = {}) {
        return this._setFilter('rotation', enabled, options, {
            rotationHz: 0.0
        });
    }

    setDistortion(enabled, options = {}) {
        return this._setFilter('distortion', enabled, options, {
            sinOffset: 0.0,
            sinScale: 1.0,
            cosOffset: 0.0,
            cosScale: 1.0,
            tanOffset: 0.0,
            tanScale: 1.0,
            offset: 0.0,
            scale: 1.0
        });
    }

    setChannelMix(enabled, options = {}) {
        return this._setFilter('channelMix', enabled, options, {
            leftToLeft: 1.0,
            leftToRight: 0.0,
            rightToLeft: 0.0,
            rightToRight: 1.0
        });
    }

    setLowPass(enabled, options = {}) {
        return this._setFilter('lowPass', enabled, options, {
            smoothing: 20.0
        });
    }

    setBassboost(enabled, options = {}) {
        if (!enabled) {
            this.bassboost = null;
            return this.setEqualizer([]);
        }
        
        const value = options.value || 5;
        if (value < 0 || value > 5) throw new Error("Bassboost value must be between 0 and 5");
        
        this.bassboost = value;
        const num = (value - 1) * (1.25 / 9) - 0.25;
        
        const eq = new Array(13);
        for (let i = 0; i < 13; i++) {
            eq[i] = { band: i, gain: num };
        }
        
        return this.setEqualizer(eq);
    }

    setSlowmode(enabled, options = {}) {
        this.slowmode = enabled;
        return this.setTimescale(enabled, { rate: enabled ? (options.rate || 0.8) : 1.0 });
    }

    setNightcore(enabled, options = {}) {
        this.nightcore = enabled;
        return this.setTimescale(enabled, { rate: enabled ? (options.rate || 1.5) : 1.0 });
    }

    setVaporwave(enabled, options = {}) {
        this.vaporwave = enabled;
        return this.setTimescale(enabled, { pitch: enabled ? (options.pitch || 0.5) : 1.0 });
    }

    set8D(enabled, options = {}) {
        this._8d = enabled;
        return this.setRotation(enabled, { rotationHz: enabled ? (options.rotationHz || 0.2) : 0.0 });
    }

    async clearFilters() {
        this.volume = 1;
        this.equalizer = [];
        this.karaoke = null;
        this.timescale = null;
        this.tremolo = null;
        this.vibrato = null;
        this.rotation = null;
        this.distortion = null;
        this.channelMix = null;
        this.lowPass = null;
        this.bassboost = null;
        this.slowmode = null;
        this.nightcore = null;
        this.vaporwave = null;
        this._8d = null;
        
        this._filterDataTemplate.volume = 1;
        this._filterDataTemplate.equalizer = [];
        
        await this.updateFilters();
        return this;
    }

    async updateFilters() {
        const filterData = {
            ...this._filterDataTemplate,
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

        this._filterDataTemplate = { ...filterData };

        await this.player.nodes.rest.updatePlayer({
            guildId: this.player.guildId,
            data: { filters: filterData }
        });

        return this;
    }
}

module.exports = Filters;
