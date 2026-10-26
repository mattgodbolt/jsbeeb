import { SamplePlayer } from "./sample-player.js";

const Idle = 0;
const SpinUp = 1;
const Spinning = 2;
const Volume = 0.25;
/**
 * Each seekNNin/seekNNout.wav is a real 40-track drive taking 35 steps at NN ms a step, inward
 * (to higher tracks) or outward, recorded with a Greaseweazle stepping it. Step k's click
 * follows its cut point, RunLeadSeconds + k * NN ms, in the quiet before it (at 6 ms the steps
 * run together and there is none), and the head's settle follows the last. A lone step is
 * stepin/stepout.wav, the same drive taking one step from rest, a little louder than its share
 * of a run so that it carries on its own.
 */
const RunRatesMs = [6, 12, 20, 24, 30];
const RunSteps = 35;
const RunLeadSeconds = 0.005;
/**
 * A run's first few steps start it from rest, so only the opening of a seek longer than a run
 * plays them; the steps it repeats to fill out the rest come from this one on.
 */
const RunFillFirstStep = 5;
/** Pieces of a run cross-fade over this long, ending at a step's cut point. */
const JoinFadeSeconds = 0.002;

const runName = (rateMs, inward) => `seek${String(rateMs).padStart(2, "0")}${inward ? "in" : "out"}`;

/** The recorded rate nearest the controller's; near enough beats a run of mismatched clicks. */
const nearestRunRate = (stepMs) =>
    RunRatesMs.reduce((best, rate) => (Math.abs(rate - stepMs) < Math.abs(best - stepMs) ? rate : best));

export class DdNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
        this.state = Idle;
        this.motor = null;
        this.run = null;
        this.clickEnds = 0;
    }

    async initialise() {
        const runs = {};
        for (const rate of RunRatesMs) {
            for (const inward of [true, false]) {
                const name = runName(rate, inward);
                runs[name] = `sounds/disc525/${name}.wav`;
            }
        }
        await this.loadSounds({
            motorOn: "sounds/disc525/motoron.wav",
            motorOff: "sounds/disc525/motoroff.wav",
            motor: "sounds/disc525/motor.wav",
            stepIn: "sounds/disc525/stepin.wav",
            stepOut: "sounds/disc525/stepout.wav",
            ...runs,
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
     * The head is about to take `steps` steps (positive inward), one every `stepMs`: the last
     * that many steps of the recorded run nearest that rate, through to its settle. A seek
     * longer than the recording starts with its opening steps, repeats steps from past them as
     * many times as it takes, and ends with its last steps and settle.
     * A single step is a lone step, held off while the last one still sounds.
     */
    seekStart(steps, stepMs) {
        const count = Math.abs(steps);
        if (count === 0) return;
        this.cancelRun();
        const now = this.context.currentTime;
        if (count === 1) {
            if (now >= this.clickEnds)
                this.clickEnds = now + this.oneShot(steps > 0 ? this.sounds.stepIn : this.sounds.stepOut);
            return;
        }
        const rateMs = nearestRunRate(stepMs);
        const stepSeconds = rateMs / 1000;
        const sound = this.sounds[runName(rateMs, steps > 0)];
        const start = now + JoinFadeSeconds;
        const parts = [];
        if (count <= RunSteps) {
            parts.push(this.playSteps(sound, start, RunSteps - count, null, stepSeconds));
        } else {
            const fill = RunSteps - RunFillFirstStep;
            let done = Math.min(RunSteps, count - fill);
            parts.push(this.playSteps(sound, start, 0, done, stepSeconds));
            while (count - done > fill) {
                const take = Math.min(fill, count - done - fill);
                parts.push(this.playSteps(sound, start + done * stepSeconds, RunFillFirstStep, take, stepSeconds));
                done += take;
            }
            parts.push(this.playSteps(sound, start + done * stepSeconds, RunFillFirstStep, null, stepSeconds));
        }
        this.run = { sound, parts, start, stepSeconds, steps: count };
    }

    /**
     * Plays `take` of the recording's steps from step `first`, its cut point landing at
     * `cutAt`; a null `take` plays everything from `first` on, settle and all.
     */
    playSteps(sound, cutAt, first, take, stepSeconds) {
        const offset = RunLeadSeconds + first * stepSeconds - JoinFadeSeconds;
        const duration = take === null ? sound.duration - offset : take * stepSeconds + JoinFadeSeconds;
        const stepping = take === null ? RunSteps - first : take;
        const at = cutAt - JoinFadeSeconds;
        const source = this.startSound(sound, { when: at, offset, duration, fadeSeconds: JoinFadeSeconds });
        return { source, at, cutAt, stepsEnd: cutAt + stepping * stepSeconds };
    }

    /**
     * The head has stopped after `steps` steps. Fewer than announced fades the run out where
     * the next step would have sounded, or from now if that has passed, and lets the recording's
     * settle ring from there. Told once every step has sounded, it leaves the run's own settle
     * ringing. The run stays until a new movement, so that a settle still to come can give way.
     */
    seekEnd(steps) {
        const run = this.run;
        if (!run || steps >= run.steps) return;
        const now = this.context.currentTime;
        run.steps = steps;
        if (now >= run.parts.at(-1).stepsEnd) return;
        const stopAt = run.start + steps * run.stepSeconds;
        for (const { source, at, cutAt, stepsEnd } of run.parts) {
            if (!source || (cutAt < stopAt && stepsEnd <= stopAt)) continue;
            if (cutAt >= stopAt && now < at + JoinFadeSeconds) source.stop();
            else this.stopSound(source, stopAt, JoinFadeSeconds);
        }
        const settleAt = Math.max(stopAt, now + JoinFadeSeconds);
        run.parts.push(this.playSteps(run.sound, settleAt, RunSteps, null, run.stepSeconds));
    }

    /**
     * Stops the parts of a run with steps still to sound, fading out any already sounding; a
     * part still fading in has not been heard, and stops outright, since fading it out from there
     * would first jump it to full level. A settle already ringing rings on.
     */
    cancelRun() {
        if (!this.run) return;
        const { parts } = this.run;
        this.run = null;
        const now = this.context.currentTime;
        for (const { source, at, stepsEnd } of parts) {
            if (!source || now >= stepsEnd) continue;
            if (now < at + JoinFadeSeconds) source.stop();
            else this.stopSound(source, now + JoinFadeSeconds, JoinFadeSeconds);
        }
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
