"use strict";
import { loadSounds, BaseAudioNoise } from "./audio-utils.js";
import _ from "underscore";

const IDLE = 0;
const SPIN_UP = 1;
const SPINNING = 2;

export class DdNoise extends BaseAudioNoise {
    constructor(context) {
        super(context, 0.25);
        this.state = IDLE;
        this.motor = null;
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
