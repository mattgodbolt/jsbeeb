import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DdNoise } from "../../src/ddnoise.js";

const Sounds = {
    motorOn: { duration: 0.37 },
    motorOff: { duration: 0.39 },
    motor: { duration: 0.21 },
    step: { duration: 0.096 },
    seek3: { duration: 1.795193 },
};

const RunFirstClick = 0.0085;
const RunClickSeconds = 0.024209;
const GrainLead = 0.002;

function stubContext() {
    return {
        state: "running",
        currentTime: 0,
        createGain: () => ({
            gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
            connect: vi.fn(),
            disconnect: vi.fn(),
        }),
        createBufferSource: () => ({
            buffer: null,
            loop: false,
            onended: null,
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
        }),
    };
}

/** A DdNoise with the samples in place of loading them. */
function loadedDdNoise(context) {
    const ddNoise = new DdNoise(context, { connect: vi.fn() });
    ddNoise.sounds = Sounds;
    return ddNoise;
}

/** The starts made so far: which sound, when, from where in it, for how long. */
const starts = (ddNoise) =>
    ddNoise.playing.map((source) => {
        const [when = 0, offset = 0, duration] = source.start.mock.calls[0];
        return { sound: source.buffer, when, offset, duration };
    });

describe("DdNoise seeks", () => {
    let context;
    let ddNoise;
    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        context = stubContext();
        ddNoise = loadedDdNoise(context);
    });

    it("clicks once for a single step either way, and not at all for no movement", () => {
        ddNoise.seekStart(0, 24);
        expect(starts(ddNoise)).toEqual([]);
        ddNoise.seekStart(1, 24);
        context.currentTime = 0.1;
        ddNoise.seekStart(-1, 24);
        expect(starts(ddNoise).map((s) => s.sound)).toEqual([Sounds.step, Sounds.step]);
    });

    it("runs two grains and the settle for two steps", () => {
        ddNoise.seekStart(2, 24);
        expect(starts(ddNoise).map((s) => s.sound)).toEqual([Sounds.seek3, Sounds.seek3, Sounds.step]);
    });

    it("holds a click off while the last one still sounds", () => {
        ddNoise.seekStart(1, 6);
        context.currentTime = 0.006;
        ddNoise.seekStart(1, 6);
        expect(starts(ddNoise)).toHaveLength(1);
        context.currentTime = 0.1;
        ddNoise.seekStart(1, 6);
        expect(starts(ddNoise)).toHaveLength(2);
    });

    it("runs a click per step at the controller's own rate, then lets the last one ring", () => {
        context.currentTime = 5;
        ddNoise.seekStart(30, 12);
        const made = starts(ddNoise);
        const grains = made.slice(0, 30);
        const settle = made[30];
        expect(made).toHaveLength(31);
        grains.forEach((grain, track) => {
            expect(grain.sound).toBe(Sounds.seek3);
            expect(grain.when).toBeCloseTo(5 + track * 0.012, 6);
            expect(grain.duration).toBeCloseTo(RunClickSeconds, 6);
            const click = (grain.offset + GrainLead - RunFirstClick) / RunClickSeconds;
            expect(click).toBeCloseTo(Math.round(click), 6);
            expect(click).toBeGreaterThanOrEqual(0);
            expect(grain.offset + RunClickSeconds).toBeLessThanOrEqual(Sounds.seek3.duration);
        });
        expect(settle.sound).toBe(Sounds.step);
        expect(settle.when).toBeCloseTo(5 + 30 * 0.012, 6);
        expect(settle.offset).toBe(0.024);
    });

    it("cuts its last grain from a click that still lies wholly inside the recording", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.999999);
        ddNoise.seekStart(3, 24);
        const [grain] = starts(ddNoise);
        expect(grain.offset + RunClickSeconds).toBeLessThanOrEqual(Sounds.seek3.duration);
        expect(grain.offset + RunClickSeconds).toBeGreaterThan(Sounds.seek3.duration - 2 * RunClickSeconds);
    });

    it("drops the clicks past the step the head stopped at, and lets it ring from there", () => {
        context.currentTime = 5;
        ddNoise.seekStart(30, 24);
        const made = ddNoise.playing.slice();
        ddNoise.seekEnd(11);
        made.slice(0, 11).forEach((source) => expect(source.stop).not.toHaveBeenCalled());
        made.slice(11, 30).forEach((source) => expect(source.stop).toHaveBeenCalled());
        expect(made[30].stop).toHaveBeenCalled();
        const settle = starts(ddNoise).at(-1);
        expect(settle.sound).toBe(Sounds.step);
        expect(settle.when).toBeCloseTo(5 + 11 * 0.024, 6);
        expect(settle.offset).toBe(0.024);
    });

    it("leaves a run alone when the head stops where it was told to", () => {
        ddNoise.seekStart(5, 24);
        const made = ddNoise.playing.slice();
        ddNoise.seekEnd(5);
        made.forEach((source) => expect(source.stop).not.toHaveBeenCalled());
        expect(ddNoise.playing).toHaveLength(made.length);
    });

    it("gives way to a new movement, dropping what the old one had still to play", () => {
        ddNoise.seekStart(30, 24);
        const old = ddNoise.playing.slice();
        context.currentTime = 0.05;
        ddNoise.seekStart(1, 24);
        old.slice(0, 3).forEach((source) => expect(source.stop).not.toHaveBeenCalled());
        old.slice(3).forEach((source) => expect(source.stop).toHaveBeenCalled());
        expect(starts(ddNoise).at(-1).sound).toBe(Sounds.step);
    });

    it("drops the settle of a run the head finished if a new movement comes before it sounds", () => {
        ddNoise.seekStart(5, 24);
        const settle = ddNoise.playing.at(-1);
        context.currentTime = 5 * 0.024 - 0.005;
        ddNoise.seekEnd(5);
        ddNoise.seekStart(30, 24);
        expect(settle.stop).toHaveBeenCalled();
    });

    it("lets a settle that has begun ring on under a new movement", () => {
        ddNoise.seekStart(5, 24);
        const settle = ddNoise.playing.at(-1);
        context.currentTime = 5 * 0.024 + 0.005;
        ddNoise.seekEnd(5);
        ddNoise.seekStart(30, 24);
        expect(settle.stop).not.toHaveBeenCalled();
    });

    it("drops a moved settle too if a new movement comes before it sounds", () => {
        ddNoise.seekStart(30, 24);
        context.currentTime = 10 * 0.024;
        ddNoise.seekEnd(11);
        const moved = ddNoise.playing.at(-1);
        ddNoise.seekStart(1, 24);
        expect(moved.stop).toHaveBeenCalled();
    });

    it("does nothing at all when the context is not running", () => {
        context.state = "suspended";
        ddNoise.seekStart(30, 24);
        expect(ddNoise.playing).toEqual([]);
        expect(() => ddNoise.seekEnd(3)).not.toThrow();
    });
});
