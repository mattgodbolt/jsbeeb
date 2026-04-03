"use strict";
// Cassette motor relay click sound (issue #296).
// Audio samples recorded from a real BBC Master cassette motor relay.
import { SamplePlayer } from "./sample-player.js";

const Volume = 0.4;

export class RelayNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
    }

    async initialise() {
        await this.loadSounds({
            motorOn: "sounds/tape/motor_on.mp3",
            motorOff: "sounds/tape/motor_off.mp3",
        });
    }

    motorOn() {
        this.oneShot(this.sounds.motorOn);
    }

    motorOff() {
        this.oneShot(this.sounds.motorOff);
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
