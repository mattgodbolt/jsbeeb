import { SamplePlayer } from "./sample-player.js";

const Idle = 0;
const SpinUp = 1;
const Spinning = 2;
const Volume = 0.25;
/**
 * A step this long after the last is a movement of its own, not part of the same seek: past
 * the slowest rate a controller steps at (30 ms) with room for the emulator's 10 ms ticks.
 */
const SeekEndsAfterMs = 60;
/**
 * The run of steps in seek3.wav, recorded at the 8271's 24 ms a track: where the first click
 * begins and the interval between clicks, both measured from the file, so a loop of
 * SeekLoopSteps intervals from SeekLoopStartSeconds joins between clicks.
 */
const SeekLoopStartSeconds = 0.0055;
const SeekLoopStepSeconds = 0.024209;
const SeekLoopSteps = 73;
const SeekLoopEndSeconds = SeekLoopStartSeconds + SeekLoopSteps * SeekLoopStepSeconds;
/** Where step.wav's burst gives way to its ring: what a run's last click leaves behind. */
const SettleOffsetSeconds = 0.024;

export class DdNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
        this.state = Idle;
        this.motor = null;
        this.lastStepAt = -Infinity;
        this.click = null;
        this.run = null;
        this.seekEndTimer = null;
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

    /**
     * The head has stepped a track. One step is a click; a second within the
     * same movement hands over to a recording of the drive stepping at the
     * rate it was recorded at, which runs until the steps stop, then ends on
     * a click boundary with that click's ring as the head settles.
     */
    step() {
        const now = this.context.currentTime;
        const sameMovement = now - this.lastStepAt < SeekEndsAfterMs / 1000;
        this.lastStepAt = now;
        clearTimeout(this.seekEndTimer);
        this.seekEndTimer = setTimeout(() => this.endSeek(), SeekEndsAfterMs);
        if (this.run) return;
        if (sameMovement && this.click) {
            this.click.stop();
            this.click = null;
            const source = this.startSound(this.sounds.seek3, {
                offset: SeekLoopStartSeconds,
                loopStart: SeekLoopStartSeconds,
                loopEnd: SeekLoopEndSeconds,
            });
            if (source) this.run = { source, startedAt: now };
            return;
        }
        this.click = this.startSound(this.sounds.step);
    }

    endSeek() {
        this.seekEndTimer = null;
        this.click = null;
        if (!this.run) return;
        const { source, startedAt } = this.run;
        this.run = null;
        const now = this.context.currentTime;
        const intoStep = (now - startedAt) % SeekLoopStepSeconds;
        const boundary = now + SeekLoopStepSeconds - intoStep;
        source.stop(boundary);
        this.startSound(this.sounds.step, { when: boundary, offset: SettleOffsetSeconds });
    }
}

export class FakeDdNoise {
    step() {}
    initialise() {
        return Promise.resolve();
    }
    spinUp() {}
    spinDown() {}
    mute() {}
    unmute() {}
}
