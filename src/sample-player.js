"use strict";
import * as utils from "./utils.js";

/**
 * Base class for audio components that load and play back sample buffers
 * (e.g. disc drive noise, cassette relay clicks).
 *
 * Provides: gain node setup, sample loading, one-shot playback, and
 * gain-based mute/unmute.  Subclasses add domain-specific behaviour.
 */
export class SamplePlayer {
    constructor(context, destination, volume) {
        this.context = context;
        this.volume = volume;
        this.sounds = {};
        this.gain = context.createGain();
        this.gain.gain.value = volume;
        this.gain.connect(destination);
        // Prevent older Safari from GC-ing in-flight AudioBufferSourceNodes.
        this.playing = [];
    }

    /**
     * Load a map of {name: path} into decoded AudioBuffers stored in this.sounds.
     */
    async loadSounds(pathMap) {
        const entries = Object.entries(pathMap);
        const decoded = await Promise.all(
            entries.map(async ([, path]) => {
                const data = await utils.loadData(path);
                // Safari doesn't support the promise form of decodeAudioData.
                return new Promise((resolve) => {
                    this.context.decodeAudioData(data.buffer, (buf) => resolve(buf));
                });
            }),
        );
        for (let i = 0; i < entries.length; i++) {
            this.sounds[entries[i][0]] = decoded[i];
        }
    }

    /**
     * Fire-and-forget: play a buffer once, return its duration.
     */
    oneShot(sound) {
        const duration = sound.duration;
        if (this.context.state !== "running") return duration;
        const source = this.context.createBufferSource();
        source.buffer = sound;
        source.connect(this.gain);
        source.onended = () => {
            this.playing = this.playing.filter((s) => s !== source);
        };
        source.start();
        this.playing.push(source);
        return duration;
    }

    /**
     * Play a buffer, optionally looping.  Returns a Promise that resolves
     * with the source node (if looping) or when playback ends (if not).
     */
    play(sound, loop) {
        if (this.context.state !== "running") return Promise.reject();
        return new Promise((resolve) => {
            const source = this.context.createBufferSource();
            source.loop = !!loop;
            source.buffer = sound;
            source.connect(this.gain);
            source.onended = () => {
                this.playing = this.playing.filter((s) => s !== source);
                if (!source.loop) resolve();
            };
            source.start();
            this.playing.push(source);
            if (source.loop) resolve(source);
        });
    }

    mute() {
        this.gain.gain.value = 0;
    }

    unmute() {
        this.gain.gain.value = this.volume;
    }
}
