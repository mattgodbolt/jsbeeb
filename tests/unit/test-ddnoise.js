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

const Start = 5;

const untouched = (source) => expect(source.stop).not.toHaveBeenCalled();

/** Stopped without the fade, as a source that has not yet been heard. */
const outright = (source) => {
    expect(source.stop).toHaveBeenCalledWith();
    expect(fadeOf(source).gain.cancelScheduledValues).not.toHaveBeenCalled();
};

/** Faded out to silence by `time` from Start. */
const fadedBy = (time) => (source) => {
    const end = Start + time;
    expect(source.stop).toHaveBeenCalledWith(expect.closeTo(end, 9));
    expect(fadeOf(source).gain.setValueAtTime).toHaveBeenLastCalledWith(1, expect.closeTo(end - JoinFade, 9));
    expect(fadeOf(source).gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, expect.closeTo(end, 9));
};

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

    // Each piece: the step its cut point lands on, the recorded step it plays from, and how many it
    // plays (null: the rest, settle and all).
    it.each([
        ["a seek the run covers", -20, 20, [[0, RunSteps - 20, null]]],
        [
            "a seek just longer than the run",
            36,
            12,
            [
                [0, 0, 6],
                [6, RunFillFirstStep, null],
            ],
        ],
        [
            "a seek filled out once",
            79,
            6,
            [
                [0, 0, 35],
                [35, RunFillFirstStep, 14],
                [49, RunFillFirstStep, null],
            ],
        ],
        [
            "a seek filled out twice",
            100,
            30,
            [
                [0, 0, 35],
                [35, RunFillFirstStep, 30],
                [65, RunFillFirstStep, 5],
                [70, RunFillFirstStep, null],
            ],
        ],
    ])("plays %s as cross-fading pieces of the run", (_, steps, rate, pieces) => {
        context.currentTime = Start;
        ddNoise.seekStart(steps, rate);
        const sound = Sounds[runName(rate, steps > 0)];
        const stepSeconds = rate / 1000;
        expect(starts(ddNoise)).toEqual(
            pieces.map(([at, first, take]) => ({
                sound,
                when: expect.closeTo(Start + at * stepSeconds, 9),
                offset: expect.closeTo(stepOffset(rate, first), 9),
                duration: expect.closeTo(
                    take === null ? sound.duration - stepOffset(rate, first) : take * stepSeconds + JoinFade,
                    9,
                ),
            })),
        );
    });

    // At 24 ms a step; times are from the start of the seek.
    const cutAfter = (steps) => JoinFade + steps * 0.024;

    it.each([
        ["short of a seek the run covers", 30, 0, 11, [fadedBy(cutAfter(11))], cutAfter(11)],
        ["short, told after the audio clock has passed it", 30, 0.5, 11, [fadedBy(0.5 + JoinFade)], 0.5 + JoinFade],
        [
            "short, in the first piece of a long seek",
            79,
            0,
            20,
            [fadedBy(cutAfter(20)), outright, outright],
            cutAfter(20),
        ],
        [
            "short, in a later piece of a long seek",
            79,
            0,
            40,
            [untouched, fadedBy(cutAfter(40)), outright],
            cutAfter(40),
        ],
        [
            "short of a long seek, told late",
            79,
            1,
            20,
            [fadedBy(1 + JoinFade), fadedBy(1 + JoinFade), outright],
            1 + JoinFade,
        ],
        ["without moving", 5, 0.05, 0, [fadedBy(0.05 + JoinFade)], 0.05 + JoinFade],
        ["without moving, while the run still fades in", 5, JoinFade / 2, 0, [outright], JoinFade / 2 + JoinFade],
        ["where it was told to", 5, 0, 5, [untouched], null],
        ["short, once every step has sounded", 5, cutAfter(5) + 0.01, 3, [untouched], null],
    ])(
        "stops a run when the head stops %s, and moves the settle there",
        (_, steps, after, stopped, expectStops, settleCut) => {
            context.currentTime = Start;
            ddNoise.seekStart(steps, 24);
            const pieces = ddNoise.playing.slice();
            context.currentTime = Start + after;
            ddNoise.seekEnd(stopped);
            expect(pieces).toHaveLength(expectStops.length);
            pieces.forEach((piece, i) => expectStops[i](piece));
            const sound = Sounds.seek24in;
            const settleOffset = stepOffset(24, RunSteps);
            const settle = {
                sound,
                when: expect.closeTo(Start + settleCut - JoinFade, 9),
                offset: expect.closeTo(settleOffset, 9),
                duration: expect.closeTo(sound.duration - settleOffset, 9),
            };
            expect(starts(ddNoise).slice(pieces.length)).toEqual(settleCut === null ? [] : [settle]);
        },
    );

    it.each([
        ["fades out a run with steps still to sound", 30, 0.05, fadedBy(0.05 + JoinFade)],
        ["stops outright a run still fading in", 30, JoinFade / 2, outright],
        ["lets a run that has reached its settle ring on", 5, cutAfter(5) + 0.005, untouched],
    ])("on a new movement, %s", (_, steps, after, expectStop) => {
        context.currentTime = Start;
        ddNoise.seekStart(steps, 24);
        const [old] = ddNoise.playing;
        context.currentTime = Start + after;
        ddNoise.seekStart(-1, 24);
        expectStop(old);
        expect(starts(ddNoise).at(-1).sound).toBe(Sounds.stepOut);
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
