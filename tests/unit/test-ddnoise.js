import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DdNoise } from "../../src/ddnoise.js";

const Sounds = {
    motorOn: { duration: 0.37 },
    motorOff: { duration: 0.39 },
    motor: { duration: 0.21 },
    step: { duration: 0.096 },
    seek: { duration: 0.148 },
    seek2: { duration: 1.066 },
    seek3: { duration: 1.795 },
};

function stubContext() {
    return {
        state: "running",
        currentTime: 0,
        createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
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

/** Steps `count` times, `intervalMs` apart on both the audio clock and the timers. */
function stepAt(ddNoise, context, count, intervalMs) {
    for (let i = 0; i < count; ++i) {
        if (i > 0) {
            context.currentTime += intervalMs / 1000;
            vi.advanceTimersByTime(intervalMs);
        }
        ddNoise.step();
    }
}

describe("DdNoise steps", () => {
    let context;
    let ddNoise;
    beforeEach(() => {
        vi.useFakeTimers();
        context = stubContext();
        ddNoise = loadedDdNoise(context);
    });
    afterEach(() => vi.useRealTimers());

    const started = () => ddNoise.playing.map((source) => source.buffer);

    it("clicks for a single step, and again for another after the head has rested", () => {
        ddNoise.step();
        expect(started()).toEqual([Sounds.step]);
        expect(ddNoise.playing[0].loop).toBe(false);
        context.currentTime = 0.4;
        vi.advanceTimersByTime(400);
        ddNoise.step();
        expect(started()).toEqual([Sounds.step, Sounds.step]);
        expect(ddNoise.playing[0].stop).not.toHaveBeenCalled();
    });

    it("hands a second step in the same movement over to the looped run, and keeps it running while the steps come", () => {
        stepAt(ddNoise, context, 30, 24);
        const [click, run] = ddNoise.playing;
        expect(started()).toEqual([Sounds.step, Sounds.seek3]);
        expect(click.stop).toHaveBeenCalled();
        expect(run.loop).toBe(true);
        expect(run.loopStart).toBeCloseTo(0.0055, 4);
        expect(run.loopEnd).toBeCloseTo(0.0055 + 73 * 0.024209, 4);
        expect(run.start).toHaveBeenCalledWith(0, run.loopStart);
        expect(run.stop).not.toHaveBeenCalled();
    });

    it("ends the run on a click boundary once the steps stop, with the click's ring as the settle", () => {
        stepAt(ddNoise, context, 30, 24);
        const run = ddNoise.playing[1];
        const lastStep = context.currentTime;
        context.currentTime += 0.1;
        vi.advanceTimersByTime(100);
        expect(run.stop).toHaveBeenCalledTimes(1);
        const [boundary] = run.stop.mock.calls[0];
        const sinceRunStarted = boundary - 0.024;
        expect(boundary).toBeGreaterThan(context.currentTime);
        expect(boundary - context.currentTime).toBeLessThanOrEqual(0.024209);
        expect(sinceRunStarted % 0.024209).toBeCloseTo(0, 3);
        const settle = ddNoise.playing[2];
        expect(settle.buffer).toBe(Sounds.step);
        expect(settle.start).toHaveBeenCalledWith(boundary, 0.024);
        expect(lastStep).toBeLessThan(boundary);
    });

    it("starts a fresh click for a step after a run has ended", () => {
        stepAt(ddNoise, context, 5, 24);
        context.currentTime += 0.5;
        vi.advanceTimersByTime(500);
        ddNoise.step();
        expect(started().at(-1)).toBe(Sounds.step);
        expect(ddNoise.playing.at(-1).loop).toBe(false);
    });

    it("keeps its footing when the context is not running", () => {
        context.state = "suspended";
        expect(() => stepAt(ddNoise, context, 5, 24)).not.toThrow();
        expect(started()).toEqual([]);
        context.currentTime += 0.5;
        vi.advanceTimersByTime(500);
        context.state = "running";
        ddNoise.step();
        expect(started()).toEqual([Sounds.step]);
    });
});
