import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DdNoise } from "../../src/ddnoise.js";
import { stubAudioContext } from "../helpers/stub-audio-context.js";

const RunRates = [6, 12, 20, 24, 30];
const RunSteps = 35;
const RunLead = 0.005;
const JoinFade = 0.002;
const RunFillFirstStep = 5;
const Settle = 0.06;

const runName = (rate, inward) => `seek${String(rate).padStart(2, "0")}${inward ? "in" : "out"}`;

const Sounds = {
    motorOn: { duration: 0.37 },
    motorOff: { duration: 0.39 },
    motor: { duration: 0.21 },
    stepIn: { duration: 0.05 },
    stepOut: { duration: 0.05 },
};
for (const rate of RunRates) {
    for (const inward of [true, false]) {
        Sounds[runName(rate, inward)] = { duration: RunLead + RunSteps * (rate / 1000) + Settle };
    }
}

/** A DdNoise with the samples in place of loading them. */
function loadedDdNoise(context) {
    const ddNoise = new DdNoise(context, { connect: vi.fn() });
    ddNoise.sounds = Sounds;
    return ddNoise;
}

/** A 16-bit mono WAV's samples, from -1 to 1, and its rate. */
function wavSamples(path) {
    const bytes = readFileSync(new URL(path, import.meta.url));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = view.getUint32(24, true);
    let chunk = 12;
    while (bytes.toString("latin1", chunk, chunk + 4) !== "data") chunk += 8 + view.getUint32(chunk + 4, true);
    const count = view.getUint32(chunk + 4, true) / 2;
    const samples = Float32Array.from({ length: count }, (_, i) => view.getInt16(chunk + 8 + 2 * i, true) / 32768);
    return { samples, rate };
}

/** The starts made so far: which sound, when, from where in it, for how long. */
const starts = (ddNoise) =>
    ddNoise.playing.map((source) => {
        const [when = 0, offset = 0, duration] = source.start.mock.calls[0];
        return { sound: source.buffer, when, offset, duration };
    });

/** The gain a source was started through to fade it. */
const fadeOf = (source) => source.connect.mock.calls[0][0];

/** Where in a run recorded at `rate` ms its step `step` begins, less the join's fade. */
const stepOffset = (rate, step) => RunLead + (step * rate) / 1000 - JoinFade;

describe("DdNoise seeks", () => {
    let context;
    let ddNoise;

    beforeEach(() => {
        context = stubAudioContext();
        ddNoise = loadedDdNoise(context);
    });

    it("does nothing for no movement", () => {
        ddNoise.seekStart(0, 6);
        expect(starts(ddNoise)).toEqual([]);
    });

    it("plays a lone step for a single step, inward or outward, whatever the rate", () => {
        ddNoise.seekStart(1, 12);
        context.currentTime = 1;
        ddNoise.seekStart(-1, 30);
        expect(starts(ddNoise).map((s) => s.sound)).toEqual([Sounds.stepIn, Sounds.stepOut]);
    });

    it("holds a single step off while the last one still sounds", () => {
        ddNoise.seekStart(1, 6);
        context.currentTime = 0.006;
        ddNoise.seekStart(1, 6);
        expect(starts(ddNoise)).toHaveLength(1);
        context.currentTime = 0.1;
        ddNoise.seekStart(1, 6);
        expect(starts(ddNoise)).toHaveLength(2);
    });

    it.each([
        [6, 6],
        [3, 6],
        [2, 6],
        [8, 6],
        [10, 12],
        [14, 12],
        [18, 20],
        [22, 20],
        [26, 24],
        [28, 30],
        [60, 30],
    ])("plays the run recorded nearest a %d ms step rate: %d ms", (stepMs, rate) => {
        ddNoise.seekStart(5, stepMs);
        expect(starts(ddNoise)[0].sound).toBe(Sounds[runName(rate, true)]);
    });

    it("plays the last steps of a run through to its settle for a seek it covers", () => {
        context.currentTime = 5;
        ddNoise.seekStart(-20, 20);
        const [run, ...rest] = starts(ddNoise);
        expect(rest).toEqual([]);
        expect(run.sound).toBe(Sounds.seek20out);
        expect(run.when).toBeCloseTo(5, 9);
        expect(run.offset).toBeCloseTo(stepOffset(20, RunSteps - 20), 9);
        expect(run.offset + run.duration).toBeCloseTo(Sounds.seek20out.duration, 9);
    });

    it("opens a seek longer than the run with its opening steps, fills from past them, and ends the run", () => {
        context.currentTime = 5;
        ddNoise.seekStart(79, 6);
        const made = starts(ddNoise);
        expect(made).toHaveLength(3);
        made.forEach(({ sound }) => expect(sound).toBe(Sounds.seek06in));
        const [first, second, last] = made;
        // 79 steps: the run's opening 35, then 14 from step 5 on, then its last 30 and the settle.
        expect(first.when).toBeCloseTo(5, 9);
        expect(first.offset).toBeCloseTo(stepOffset(6, 0), 9);
        expect(first.duration).toBeCloseTo(35 * 0.006 + JoinFade, 9);
        expect(second.when).toBeCloseTo(5 + 35 * 0.006, 9);
        expect(second.offset).toBeCloseTo(stepOffset(6, RunFillFirstStep), 9);
        expect(second.duration).toBeCloseTo(14 * 0.006 + JoinFade, 9);
        expect(last.when).toBeCloseTo(5 + 49 * 0.006, 9);
        expect(last.offset).toBeCloseTo(stepOffset(6, RunFillFirstStep), 9);
        expect(last.offset + last.duration).toBeCloseTo(Sounds.seek06in.duration, 9);
    });

    it("plays a run's opening steps only at the start of a seek just longer than the run", () => {
        ddNoise.seekStart(36, 12);
        const [first, last] = starts(ddNoise);
        expect(starts(ddNoise)).toHaveLength(2);
        expect(first.offset).toBeCloseTo(stepOffset(12, 0), 9);
        expect(first.duration).toBeCloseTo(6 * 0.012 + JoinFade, 9);
        expect(last.offset).toBeCloseTo(stepOffset(12, RunFillFirstStep), 9);
    });

    it("cross-fades the pieces of a long run, each fading out as the next fades in", () => {
        ddNoise.seekStart(79, 12);
        const [first, second] = starts(ddNoise);
        const firstEnd = first.when + first.duration;
        expect(second.when).toBeCloseTo(firstEnd - JoinFade, 9);
    });

    it("fades the run out where the head stopped short, and lets the settle ring from there", () => {
        context.currentTime = 5;
        ddNoise.seekStart(30, 24);
        const [run] = ddNoise.playing;
        ddNoise.seekEnd(11);
        const stopAt = 5 + JoinFade + 11 * 0.024;
        expect(run.stop).toHaveBeenCalledWith(expect.closeTo(stopAt, 9));
        expect(fadeOf(run).gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, expect.closeTo(stopAt, 9));
        const settle = starts(ddNoise).at(-1);
        expect(settle.sound).toBe(Sounds.seek24in);
        expect(settle.when).toBeCloseTo(stopAt - JoinFade, 9);
        expect(settle.offset).toBeCloseTo(stepOffset(24, RunSteps), 9);
    });

    it("drops the pieces of a long run that would have sounded after the head stopped", () => {
        ddNoise.seekStart(79, 12);
        const [first, second, last] = ddNoise.playing;
        ddNoise.seekEnd(20);
        expect(first.stop).toHaveBeenCalledWith(expect.closeTo(JoinFade + 20 * 0.012, 9));
        expect(second.stop).toHaveBeenCalledWith();
        expect(last.stop).toHaveBeenCalledWith();
    });

    it("fades out the piece of a long run the head stopped in, past the first", () => {
        ddNoise.seekStart(79, 12);
        const [first, second, last] = ddNoise.playing;
        ddNoise.seekEnd(40);
        expect(first.stop).not.toHaveBeenCalled();
        expect(second.stop).toHaveBeenCalledWith(expect.closeTo(JoinFade + 40 * 0.012, 9));
        expect(last.stop).toHaveBeenCalledWith();
    });

    it("fades out every sounding piece of a long run when the stop is reported late", () => {
        ddNoise.seekStart(79, 12);
        const [first, second, last] = ddNoise.playing;
        context.currentTime = 0.5;
        ddNoise.seekEnd(20);
        expect(first.stop).toHaveBeenCalledWith(expect.closeTo(0.5 + JoinFade, 9));
        expect(second.stop).toHaveBeenCalledWith(expect.closeTo(0.5 + JoinFade, 9));
        expect(fadeOf(second).gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
            0,
            expect.closeTo(0.5 + JoinFade, 9),
        );
        expect(last.stop).toHaveBeenCalledWith();
    });

    it("fades the run out when the head is reported not to have moved at all", () => {
        ddNoise.seekStart(5, 24);
        const [run] = ddNoise.playing;
        context.currentTime = 0.05;
        ddNoise.seekEnd(0);
        expect(run.stop).toHaveBeenCalledWith(expect.closeTo(0.05 + JoinFade, 9));
    });

    it("fades the settle in from now when the stop is reported late", () => {
        ddNoise.seekStart(30, 24);
        context.currentTime = 0.5;
        ddNoise.seekEnd(11);
        const settle = starts(ddNoise).at(-1);
        expect(settle.when).toBeCloseTo(0.5, 9);
        expect(settle.offset).toBeCloseTo(stepOffset(24, RunSteps), 9);
    });

    it("leaves the run's own settle ringing when told of a stop after every step has sounded", () => {
        ddNoise.seekStart(5, 24);
        const [run] = ddNoise.playing;
        context.currentTime = JoinFade + 5 * 0.024 + 0.01;
        ddNoise.seekEnd(3);
        expect(run.stop).not.toHaveBeenCalled();
        expect(ddNoise.playing).toHaveLength(1);
    });

    it("fades out from now when the head is reported stopped after the audio clock has passed it", () => {
        ddNoise.seekStart(30, 24);
        const [run] = ddNoise.playing;
        context.currentTime = 0.5;
        ddNoise.seekEnd(11);
        expect(run.stop).toHaveBeenCalledWith(expect.closeTo(0.5 + JoinFade, 9));
        expect(fadeOf(run).gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0.5);
    });

    it("leaves a run alone when the head stops where it was told to", () => {
        ddNoise.seekStart(5, 24);
        const made = ddNoise.playing.slice();
        ddNoise.seekEnd(5);
        made.forEach((source) => expect(source.stop).not.toHaveBeenCalled());
        expect(ddNoise.playing).toHaveLength(made.length);
    });

    it("fades out for a new movement while steps are still to sound", () => {
        ddNoise.seekStart(30, 24);
        const [old] = ddNoise.playing;
        context.currentTime = 0.05;
        ddNoise.seekStart(-1, 24);
        expect(old.stop).toHaveBeenCalledWith(expect.closeTo(0.05 + JoinFade, 9));
        expect(fadeOf(old).gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
            0,
            expect.closeTo(0.05 + JoinFade, 9),
        );
        expect(starts(ddNoise).at(-1).sound).toBe(Sounds.stepOut);
    });

    it("stops outright a run a new movement interrupts while it is still fading in", () => {
        ddNoise.seekStart(30, 24);
        const [old] = ddNoise.playing;
        context.currentTime = JoinFade / 2;
        ddNoise.seekStart(-1, 24);
        expect(old.stop).toHaveBeenCalledWith();
        expect(fadeOf(old).gain.cancelScheduledValues).not.toHaveBeenCalled();
    });

    it("stops outright a run that took no steps, told while it is still fading in", () => {
        ddNoise.seekStart(5, 24);
        const [run] = ddNoise.playing;
        context.currentTime = JoinFade / 2;
        ddNoise.seekEnd(0);
        expect(run.stop).toHaveBeenCalledWith();
    });

    it("lets a run that has reached its settle ring on under a new movement", () => {
        ddNoise.seekStart(5, 24);
        const [old] = ddNoise.playing;
        context.currentTime = JoinFade + 5 * 0.024 + 0.005;
        ddNoise.seekStart(30, 24);
        expect(old.stop).not.toHaveBeenCalled();
    });

    it("drops a moved settle if a new movement comes before it sounds", () => {
        ddNoise.seekStart(30, 24);
        context.currentTime = 10 * 0.024;
        ddNoise.seekEnd(11);
        const moved = ddNoise.playing.at(-1);
        ddNoise.seekStart(1, 24);
        expect(moved.stop).toHaveBeenCalled();
        expect(starts(ddNoise).at(-1).sound).toBe(Sounds.stepIn);
    });

    it("does nothing at all when the context is not running", () => {
        context.state = "suspended";
        ddNoise.seekStart(30, 24);
        expect(ddNoise.playing).toEqual([]);
        expect(() => ddNoise.seekEnd(3)).not.toThrow();
        expect(() => ddNoise.seekStart(1, 24)).not.toThrow();
    });
});

describe("DdNoise recorded runs", () => {
    /** The run's energy above about 1.5 kHz, where a step's click is, folded over a step period. */
    function clickEnergyByPhase(name, rate, bins) {
        const { samples, rate: sampleRate } = wavSamples(`../../public/sounds/disc525/${name}.wav`);
        // RBJ high-pass, Q 0.707
        const w = (2 * Math.PI * 1500) / sampleRate;
        const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
        const cos = Math.cos(w);
        const a0 = 1 + alpha;
        const [b0, b1, b2] = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0];
        const [a1, a2] = [(-2 * cos) / a0, (1 - alpha) / a0];
        const period = (rate / 1000) * sampleRate;
        const first = Math.round(RunLead * sampleRate);
        const sums = new Float64Array(bins);
        const counts = new Float64Array(bins);
        let [x1, x2, y1, y2] = [0, 0, 0, 0];
        for (let i = 0; i < first + RunSteps * period; ++i) {
            const y = b0 * samples[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            [x2, x1, y2, y1] = [x1, samples[i], y1, y];
            if (i < first) continue;
            const bin = Math.floor((((i - first) % period) / period) * bins);
            sums[bin] += y * y;
            counts[bin]++;
        }
        return Array.from(sums, (sum, bin) => sum / counts[bin]);
    }

    it.each(RunRates.flatMap((rate) => [true, false].map((inward) => [runName(rate, inward), rate])))(
        "%s fades in from silence and is long enough for the lead, every step and a settle",
        (name, rate) => {
            const { samples, rate: sampleRate } = wavSamples(`../../public/sounds/disc525/${name}.wav`);
            expect(samples.length / sampleRate).toBeGreaterThan(RunLead + RunSteps * (rate / 1000) + 0.02);
            expect(Math.abs(samples[0])).toBeLessThan(0.01);
        },
    );

    // At 6 ms the steps run into one another, and no part of a period is quiet.
    it.each(
        RunRates.filter((rate) => rate > 6).flatMap((rate) =>
            [true, false].map((inward) => [runName(rate, inward), rate]),
        ),
    )("%s puts each step's cut point in the quiet before its click", (name, rate) => {
        const energy = clickEnergyByPhase(name, rate, 12);
        expect(energy[0]).toBeLessThan(1.25 * Math.min(...energy));
        expect(energy[0]).toBeLessThan(0.5 * Math.max(...energy));
    });
});
