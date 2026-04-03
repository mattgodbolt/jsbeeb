"use strict";
import { SamplePlayer } from "./sample-player.js";

const Idle = 0;
const SpinUp = 1;
const Spinning = 2;
const Volume = 0.25;

export class DdNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
        this.state = Idle;
        this.motor = null;
    }

    async initialise() {
        await this.loadSounds({
            motorOn: "sounds/disc525/motoron.wav",
            motorOff: "sounds/disc525/motoroff.wav",
            motor: "sounds/disc525/motor.wav",
            step: "sounds/disc525/step.wav",
            seek: "sounds/disc525/seek.wav",
            seek2: "sounds/disc525/seek2.wav",
            seek3: "sounds/disc525/seek3.wav",
        });
    }

    spinUp() {
        if (this.state === Spinning || this.state === SpinUp) return;
        this.state = SpinUp;
        this.play(this.sounds.motorOn).then(
            () => {
                // Handle race: we may have had spinDown() called on us before the
                // spinUp() initial sound finished playing.
                if (this.state === Idle) return;
                this.play(this.sounds.motor, true).then((source) => {
                    this.motor = source;
                    this.state = Spinning;
                });
            },
            () => {},
        );
    }

    spinDown() {
        if (this.state === Idle) return;
        this.state = Idle;
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
