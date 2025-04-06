"use strict";

class Filters {
    constructor(player, options = {}) {
        this.player = player;
        
        this.defaults = {
            karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 },
            timescale: { speed: 1.0, pitch: 1.0, rate: 1.0 },
            tremolo: { frequency: 2.0, depth: 0.5 },
            vibrato: { frequency: 2.0, depth: 0.5 },
            rotation: { rotationHz: 0.0 },
            distortion: { sinOffset: 0.0, sinScale: 1.0, cosOffset: 0.0, cosScale: 1.0, tanOffset: 0.0, tanScale: 1.0, offset: 0.0, scale: 1.0 },
            channelMix: { leftToLeft: 1.0, leftToRight: 0.0, rightToLeft: 0.0, rightToRight: 1.0 },
            lowPass: { smoothing: 20.0 }
        };
        
        this.filters = {
            volume: options.volume || 1,
            equalizer: options.equalizer || [],
            karaoke: options.karaoke || null,
            timescale: options.timescale || null,
            tremolo: options.tremolo || null,
            vibrato: options.vibrato || null,
            rotation: options.rotation || null,
            distortion: options.distortion || null,
            channelMix: options.channelMix || null,
            lowPass: options.lowPass || null
        };
        
        this.presets = {
            bassboost: options.bassboost !== undefined ? options.bassboost : null,
            slowmode: options.slowmode !== undefined ? options.slowmode : null,
            nightcore: options.nightcore !== undefined ? options.nightcore : null,
            vaporwave: options.vaporwave !== undefined ? options.vaporwave : null,
            _8d: options._8d !== undefined ? options._8d : null
        };
        
        this._pendingUpdate = false;
        this._updateTimeout = null;
    }

    _setFilter(filterName, enabled, options = {}, defaultKey = filterName) {
        this.filters[filterName] = enabled ? { ...this.defaults[defaultKey], ...options } : null;
        return this._scheduleUpdate();
    }

    _scheduleUpdate() {
        this._pendingUpdate = true;
        
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
        }
        
        this._updateTimeout = setTimeout(() => this.updateFilters(), 0);
        return this;
    }

    setEqualizer(bands) {
        this.filters.equalizer = bands || [];
        return this._scheduleUpdate();
    }

    setKaraoke(enabled, options = {}) {
        return this._setFilter('karaoke', enabled, options);
    }

    setTimescale(enabled, options = {}) {
        return this._setFilter('timescale', enabled, options);
    }

    setTremolo(enabled, options = {}) {
        return this._setFilter('tremolo', enabled, options);
    }

    setVibrato(enabled, options = {}) {
        return this._setFilter('vibrato', enabled, options);
    }

    setRotation(enabled, options = {}) {
        return this._setFilter('rotation', enabled, options);
    }

    setDistortion(enabled, options = {}) {
        return this._setFilter('distortion', enabled, options);
    }

    setChannelMix(enabled, options = {}) {
        return this._setFilter('channelMix', enabled, options);
    }

    setLowPass(enabled, options = {}) {
        return this._setFilter('lowPass', enabled, options);
    }

    setBassboost(enabled, options = {}) {
        if (!enabled) {
            this.presets.bassboost = null;
            return this.setEqualizer([]);
        }
        
        const value = options.value || 5;
        if (value < 0 || value > 5) throw new Error("Bassboost value must be between 0 and 5");
        
        this.presets.bassboost = value;
        const gain = (value - 1) * (1.25 / 9) - 0.25;
        
        const eq = Array.from({ length: 13 }, (_, i) => ({ band: i, gain }));
        
        return this.setEqualizer(eq);
    }

    setSlowmode(enabled, options = {}) {
        this.presets.slowmode = enabled;
        return this.setTimescale(enabled, { rate: enabled ? (options.rate || 0.8) : 1.0 });
    }

    setNightcore(enabled, options = {}) {
        this.presets.nightcore = enabled;
        return this.setTimescale(enabled, { rate: enabled ? (options.rate || 1.5) : 1.0 });
    }

    setVaporwave(enabled, options = {}) {
        this.presets.vaporwave = enabled;
        return this.setTimescale(enabled, { pitch: enabled ? (options.pitch || 0.5) : 1.0 });
    }

    set8D(enabled, options = {}) {
        this.presets._8d = enabled;
        return this.setRotation(enabled, { rotationHz: enabled ? (options.rotationHz || 0.2) : 0.0 });
    }

    async clearFilters() {
        Object.keys(this.filters).forEach(key => {
            this.filters[key] = key === 'volume' ? 1 : (key === 'equalizer' ? [] : null);
        });
        
        Object.keys(this.presets).forEach(key => {
            this.presets[key] = null;
        });
        
        this._pendingUpdate = false;
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
            this._updateTimeout = null;
        }
        
        await this.updateFilters();
        return this;
    }

    async updateFilters() {
        if (!this._pendingUpdate && this._updateTimeout) {
            clearTimeout(this._updateTimeout);
            this._updateTimeout = null;
            return this;
        }
        
        this._pendingUpdate = false;
        this._updateTimeout = null;
        
        await this.player.nodes.rest.updatePlayer({
            guildId: this.player.guildId,
            data: { filters: { ...this.filters } }
        });

        return this;
    }
}

module.exports = Filters;
