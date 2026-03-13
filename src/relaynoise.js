"use strict";
// Cassette motor relay click sound (issue #296).
// The WAV files are placeholders — replace with recordings from a real BBC
// Micro relay (Takamisawa VB-5STB-E) when available.
import * as utils from "./utils.js";

const Volume = 0.4;

export class RelayNoise {
    constructor(context) {
        this.context = context;
        this.sounds = {};
        this.gain = context.createGain();
        this.gain.gain.value = Volume;
        this.gain.connect(context.destination);
    }

    async initialise() {
        const paths = {
            motorOn: "sounds/tape/motor_on.wav",
            motorOff: "sounds/tape/motor_off.wav",
        };
        for (const [key, path] of Object.entries(paths)) {
            const data = await utils.loadData(path);
            this.sounds[key] = await new Promise((resolve) => {
                // Safari doesn't support the promise form of decodeAudioData.
                this.context.decodeAudioData(data.buffer, (decoded) => resolve(decoded));
            });
        }
    }

    click(sound) {
        if (this.context.state !== "running") return;
        const source = this.context.createBufferSource();
        source.buffer = sound;
        source.connect(this.gain);
        source.start();
    }

    motorOn() {
        this.click(this.sounds.motorOn);
    }

    motorOff() {
        this.click(this.sounds.motorOff);
    }

    mute() {
        this.gain.gain.value = 0;
    }

    unmute() {
        this.gain.gain.value = Volume;
    }
}

export class FakeRelayNoise {
    initialise() {
        return Promise.resolve();
    }
    motorOn() {}
    motorOff() {}
    mute() {}
    unmute() {}
}
