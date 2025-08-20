"use strict";
import * as utils from "./utils.js";
import _ from "underscore";

const VOLUME = 0.25;

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

export class TapeNoise {
    constructor(context) {
        this.context = context;
        this.sounds = {};
        this.gain = context.createGain();
        this.gain.gain.value = VOLUME;
        this.gain.connect(context.destination);
        // workaround for older safaris that GC sounds when they're playing...
        this.playing = [];
    }

    async initialise() {
        const sounds = await loadSounds(this.context, {
            motorOn: "sounds/tape/motor_on.wav",
            motorOff: "sounds/tape/motor_off.wav",
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

    motorOn() {
        if (this.sounds.motorOn) {
            this.oneShot(this.sounds.motorOn);
        }
    }

    motorOff() {
        if (this.sounds.motorOff) {
            this.oneShot(this.sounds.motorOff);
        }
    }

    mute() {
        this.gain.gain.value = 0;
    }

    unmute() {
        this.gain.gain.value = VOLUME;
    }
}

export class FakeTapeNoise {
    constructor() {}
    initialise() {
        return Promise.resolve();
    }
    motorOn() {}
    motorOff() {}
    mute() {}
    unmute() {}
}
