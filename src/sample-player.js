import { loadData } from "./loader.js";

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
        this.startSound(sound);
        return sound.duration;
    }

    /**
     * Start `sound` at `when` on the audio clock (now if 0), `offset` seconds in, for
     * `duration` seconds (the rest of it if undefined), with `fadeSeconds` of fade at each
     * end so a cut into the middle of it does not click. Returns the source, or null when
     * the context is not running.
     */
    startSound(sound, { when = 0, offset = 0, duration, fadeSeconds = 0 } = {}) {
        if (this.context.state !== "running") return null;
        const source = this.context.createBufferSource();
        source.buffer = sound;
        let into = this.gain;
        if (fadeSeconds > 0 && duration !== undefined) {
            const fade = this.context.createGain();
            const start = when || this.context.currentTime;
            fade.gain.setValueAtTime(0, start);
            fade.gain.linearRampToValueAtTime(1, start + fadeSeconds);
            fade.gain.setValueAtTime(1, start + duration - fadeSeconds);
            fade.gain.linearRampToValueAtTime(0, start + duration);
            fade.connect(this.gain);
            into = fade;
        }
        source.connect(into);
        source.onended = () => {
            this.playing = this.playing.filter((s) => s !== source);
            if (into !== this.gain) into.disconnect();
        };
        if (duration === undefined) source.start(when, offset);
        else source.start(when, offset, duration);
        this.playing.push(source);
        return source;
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
