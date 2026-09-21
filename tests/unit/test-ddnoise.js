import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("DdNoise seeks", () => {
    let context;
    let ddNoise;
    beforeEach(() => {
        context = stubContext();
        ddNoise = loadedDdNoise(context);
    });

    const started = () => ddNoise.playing.map((source) => source.buffer);

    it("clicks for a step or two, and plays a longer run the further the head goes", () => {
        expect(ddNoise.seek(0)).toBe(0);
        expect(started()).toEqual([]);
        for (const [tracks, sound] of [
            [1, Sounds.step],
            [-2, Sounds.step],
            [3, Sounds.seek],
            [20, Sounds.seek],
            [21, Sounds.seek2],
            [-40, Sounds.seek2],
            [41, Sounds.seek3],
            [79, Sounds.seek3],
        ]) {
            context.currentTime += 5;
            expect(ddNoise.seek(tracks)).toBe(sound.duration);
            expect(started().at(-1)).toBe(sound);
        }
    });

    it("lets a sound finish before starting another of any length", () => {
        ddNoise.seek(1);
        context.currentTime = 0.05;
        expect(ddNoise.seek(1)).toBe(0);
        expect(ddNoise.seek(30)).toBe(0);
        context.currentTime = 0.1;
        expect(ddNoise.seek(30)).toBe(Sounds.seek2.duration);
        context.currentTime = 0.6;
        expect(ddNoise.seek(30)).toBe(0);
        expect(ddNoise.seek(5)).toBe(0);
        expect(started()).toEqual([Sounds.step, Sounds.seek2]);
    });

    it("sounds a click over the tail of a run, and never cuts anything short", () => {
        ddNoise.seek(30);
        context.currentTime = 0.6;
        expect(ddNoise.seek(1)).toBe(Sounds.step.duration);
        context.currentTime = 0.65;
        expect(ddNoise.seek(1)).toBe(0);
        context.currentTime = 1.0;
        expect(ddNoise.seek(1)).toBe(Sounds.step.duration);
        expect(started()).toEqual([Sounds.seek2, Sounds.step, Sounds.step]);
        for (const source of ddNoise.playing) expect(source.stop).not.toHaveBeenCalled();
    });

    it("holds the next sound off for the full length even when the context could not play it", () => {
        context.state = "suspended";
        expect(ddNoise.seek(30)).toBe(Sounds.seek2.duration);
        expect(started()).toEqual([]);
        context.state = "running";
        context.currentTime = 0.5;
        expect(ddNoise.seek(30)).toBe(0);
        context.currentTime = 1.1;
        expect(ddNoise.seek(30)).toBe(Sounds.seek2.duration);
        expect(started()).toEqual([Sounds.seek2]);
    });
});
