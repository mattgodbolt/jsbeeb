import { loadData } from "./loader.js";

const CutShortSeconds = 0.005;

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
                const data = await loadData(path);
                // Safari doesn't support the promise form of decodeAudioData.
                return new Promise((resolve, reject) => {
                    this.context.decodeAudioData(
                        data.buffer,
                        (buf) => resolve(buf),
                        (err) => reject(err),
                    );
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
        this.startOneShot(sound);
        return sound.duration;
    }

    /**
     * Play a buffer once through a gain of its own, so it can be cut short
     * without a pop. Returns what `cutShort` needs, or null when the context
     * is not running.
     */
    startOneShot(sound) {
        if (this.context.state !== "running") return null;
        const fade = this.context.createGain();
        fade.connect(this.gain);
        const source = this.context.createBufferSource();
        source.buffer = sound;
        source.connect(fade);
        const playing = { source, fade, startedAt: this.context.currentTime, ended: false };
        source.onended = () => {
            playing.ended = true;
            this.playing = this.playing.filter((s) => s !== source);
            fade.disconnect();
        };
        source.start();
        this.playing.push(source);
        return playing;
    }

    /** Fade a one-shot out over a few milliseconds and stop it. */
    cutShort({ source, fade }) {
        const now = this.context.currentTime;
        fade.gain.setValueAtTime(fade.gain.value, now);
        fade.gain.linearRampToValueAtTime(0, now + CutShortSeconds);
        source.stop(now + CutShortSeconds);
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
