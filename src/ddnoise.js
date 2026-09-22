import { SamplePlayer } from "./sample-player.js";

const Idle = 0;
const SpinUp = 1;
const Spinning = 2;
const Volume = 0.25;
/** Up to this many steps is one click of the head; more is a run. */
const ClickSteps = 2;
/**
 * seek3.wav is a drive stepping at the DFS's 24 ms a step. Where its first click begins and
 * how far apart they come were fitted across the file's clicks, so a grain cut on that grid
 * holds one click; a run is such grains at the controller's own step rate.
 */
const RunFirstClickSeconds = 0.0085;
const RunClickSeconds = 0.024209;
const RunClicks = 73;
const GrainLeadSeconds = 0.002;
const GrainFadeSeconds = 0.002;
/** Where step.wav's burst gives way to its ring: what a run's last click leaves behind. */
const SettleOffsetSeconds = 0.024;

export class DdNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
        this.state = Idle;
        this.motor = null;
        this.run = null;
    }

    async initialise() {
        await this.loadSounds({
            motorOn: "sounds/disc525/motoron.wav",
            motorOff: "sounds/disc525/motoroff.wav",
            motor: "sounds/disc525/motor.wav",
            step: "sounds/disc525/step.wav",
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

    /**
     * The head is about to take `steps` steps, one every `stepMs`: a click for a step or two,
     * otherwise a run of clicks scheduled on the audio clock at that rate, with the click's
     * ring as the settle after the last.
     */
    seekStart(steps, stepMs) {
        if (steps < 0) steps = -steps;
        if (steps === 0) return;
        this.cancelRun();
        if (steps <= ClickSteps) {
            this.oneShot(this.sounds.step);
            return;
        }
        const now = this.context.currentTime;
        const stepSeconds = stepMs / 1000;
        const grains = [];
        for (let step = 0; step < steps; ++step) {
            const at = now + step * stepSeconds;
            const click = Math.floor(Math.random() * RunClicks);
            const source = this.startSound(this.sounds.seek3, {
                when: at,
                offset: RunFirstClickSeconds + click * RunClickSeconds - GrainLeadSeconds,
                duration: RunClickSeconds,
                fadeSeconds: GrainFadeSeconds,
            });
            grains.push({ source, at });
        }
        const settle = this.startSound(this.sounds.step, {
            when: now + steps * stepSeconds,
            offset: SettleOffsetSeconds,
        });
        this.run = { grains, settle, start: now, stepSeconds };
    }

    /**
     * The head has stopped after `steps` steps, fewer than announced if the controller found
     * track 0 or the surface's end first: the clicks past that are dropped and the ring
     * brought forward to where the last of them was to sound.
     */
    seekEnd(steps) {
        const run = this.run;
        this.run = null;
        if (!run || steps >= run.grains.length) return;
        for (const grain of run.grains.slice(steps)) grain.source?.stop();
        run.settle?.stop();
        this.startSound(this.sounds.step, {
            when: run.start + steps * run.stepSeconds,
            offset: SettleOffsetSeconds,
        });
    }

    /** Stops the grains of a run that have not yet sounded. */
    cancelRun() {
        if (!this.run) return;
        const { grains, settle } = this.run;
        this.run = null;
        const now = this.context.currentTime;
        for (const grain of grains) if (grain.at > now) grain.source?.stop();
        settle?.stop();
    }
}

export class FakeDdNoise {
    seekStart() {}
    seekEnd() {}
    initialise() {
        return Promise.resolve();
    }
    spinUp() {}
    spinDown() {}
    mute() {}
    unmute() {}
}
