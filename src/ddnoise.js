"use strict";
import * as utils from "./utils.js";
import _ from "underscore";

const IDLE = 0;
const SPIN_UP = 1;
const SPINNING = 2;
const VOLUME = 0.25;

export class DdNoise {
    constructor(context) {
        this.context = context;
        this.sounds = {};
        this.state = IDLE;
        this.motor = null;
        this.gain = context.createGain();
        this.gain.gain.value = VOLUME;
        this.gain.connect(context.destination);
        // workaround for older safaris that GC sounds when they're playing...
        this.playing = [];
    }
    async initialise() {
        const sounds = await loadSounds(this.context, {
            motorOn: "sounds/disc525/motoron.wav",
            motorOff: "sounds/disc525/motoroff.wav",
            motor: "sounds/disc525/motor.wav",
            step: "sounds/disc525/step.wav",
            seek: "sounds/disc525/seek.wav",
            seek2: "sounds/disc525/seek2.wav",
            seek3: "sounds/disc525/seek3.wav",
        });
        this.sounds = sounds;
    }
    oneShot(sound) {
        const duration = sound.duration;
        const context = this.context;
        if (context.state !== "running") return duration;
        const source = context.createBufferSource();
        source.buffer = sound;
        source.connect(this.gain);
        source.start();
        return duration;
    }
    play(sound, loop) {
        if (this.context.state !== "running") return Promise.reject();
        return new Promise((resolve) => {
            const source = this.context.createBufferSource();
            source.loop = !!loop;
            source.buffer = sound;
            source.connect(this.gain);
            source.onended = () => {
                this.playing = _.without(this.playing, source);
                if (!source.loop) resolve();
            };
            source.start();
            this.playing.push(source);
            if (source.loop) {
                resolve(source);
            }
        });
    }
    spinUp() {
        if (this.state === SPINNING || this.state === SPIN_UP) return;
        this.state = SPIN_UP;
        this.play(this.sounds.motorOn).then(
            () => {
                // Handle race: we may have had spinDown() called on us before the
                // spinUp() initial sound finished playing.
                if (this.state === IDLE) {
                    return;
                }
                this.play(this.sounds.motor, true).then((source) => {
                    this.motor = source;
                    this.state = SPINNING;
                });
            },
            () => {},
        );
    }
    spinDown() {
        if (this.state === IDLE) return;
        this.state = IDLE;
        if (this.motor) {
            this.motor.stop();
            this.motor = null;
            this.oneShot(this.sounds.motorOff);
        }
    }
    seek(diff) {
        if (diff < 0) diff = -diff;
        if (diff === 0) return 0;
        else if (diff <= 2) return this.oneShot(this.sounds.step);
        else if (diff <= 20) return this.oneShot(this.sounds.seek);
        else if (diff <= 40) return this.oneShot(this.sounds.seek2);
        else return this.oneShot(this.sounds.seek3);
    }
    mute() {
        this.gain.gain.value = 0;
    }
    unmute() {
        this.gain.gain.value = VOLUME;
    }
}

async function loadSounds(context, sounds) {
    const loaded = await Promise.all(
        _.map(sounds, async (sound) => {
            // Safari doesn't support the Promise stuff directly, so we create
            // our own Promise here.
            const data = await utils.loadData(sound);
            return await new Promise((resolve) => {
                context.decodeAudioData(data.buffer, (decodedData) => {
                    resolve(decodedData);
                });
            });
        }),
    );
    const keys = _.keys(sounds);
    const result = {};
    for (let i = 0; i < keys.length; ++i) {
        result[keys[i]] = loaded[i];
    }
    return result;
}

export class FakeDdNoise {
    constructor() {}
    seek() {
        return 0;
    }
    initialise() {
        return Promise.resolve();
    }
    spinUp() {}
    spinDown() {}
    mute() {}
    unmute() {}
}
