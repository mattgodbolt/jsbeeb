"use strict";
import { loadSounds, BaseAudioNoise } from "./audio-utils.js";

export class RelayNoise extends BaseAudioNoise {
    constructor(context) {
        super(context, 0.25);
    }

    async initialise() {
        const sounds = await loadSounds(this.context, {
            motorOn: "sounds/tape/motor_on.wav",
            motorOff: "sounds/tape/motor_off.wav",
        });
        this.sounds = sounds;
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
}

export class FakeRelayNoise {
    constructor() {}
    initialise() {
        return Promise.resolve();
    }
    motorOn() {}
    motorOff() {}
    mute() {}
    unmute() {}
}
