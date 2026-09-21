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

    it("lets a movement that has only just begun sound, rather than starting the next", () => {
        ddNoise.seek(30);
        context.currentTime = 0.05;
        expect(ddNoise.seek(1)).toBe(0);
        expect(started()).toEqual([Sounds.seek2]);
        expect(ddNoise.playing[0].stop).not.toHaveBeenCalled();
    });

    it("cuts a run short for a movement that begins once it has been heard", () => {
        ddNoise.seek(30);
        const run = ddNoise.seeking;
        context.currentTime = 0.6;
        expect(ddNoise.seek(1)).toBe(Sounds.step.duration);
        expect(started()).toEqual([Sounds.seek2, Sounds.step]);
        expect(run.fade.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, expect.closeTo(0.605, 3));
        expect(run.source.stop).toHaveBeenCalled();
        expect(ddNoise.seeking.fade.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    });

    it("has nothing to cut once the last movement has finished sounding", () => {
        ddNoise.seek(1);
        const click = ddNoise.playing[0];
        click.onended();
        context.currentTime = 0.5;
        ddNoise.seek(1);
        expect(click.stop).not.toHaveBeenCalled();
        expect(started()).toEqual([Sounds.step]);
    });

    it("carries on once a suspended context is running again", () => {
        context.state = "suspended";
        expect(ddNoise.seek(30)).toBe(Sounds.seek2.duration);
        expect(started()).toEqual([]);
        context.state = "running";
        expect(ddNoise.seek(1)).toBe(Sounds.step.duration);
        expect(started()).toEqual([Sounds.step]);
    });
});
