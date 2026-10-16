import { describe, it, expect } from "vitest";

import { StereoRing } from "../../src/stereo-ring.js";

const Quantum = 4;
const NoExcess = { excessFrames: Infinity, persistentExcessFrames: Infinity };

function framesFrom(first, count) {
    const samples = new Float64Array(count * 2);
    for (let i = 0; i < count; ++i) {
        samples[2 * i] = first + i;
        samples[2 * i + 1] = -(first + i);
    }
    return samples;
}

function readQuantum(ring, frames = Quantum) {
    const left = new Float32Array(frames).fill(NaN);
    const right = new Float32Array(frames).fill(NaN);
    ring.read(left, right);
    return { left: Array.from(left), right: Array.from(right) };
}

const silence = (frames = Quantum) => new Array(frames).fill(0);

describe("StereoRing", () => {
    it("outputs silence until the target is reached, keeping what it has", () => {
        const ring = new StereoRing(16, { targetFrames: 6, ...NoExcess });
        ring.write(framesFrom(1, 5));
        expect(readQuantum(ring)).toEqual({ left: silence(), right: silence() });
        ring.write(framesFrom(6, 1));
        expect(readQuantum(ring).left).toEqual([1, 2, 3, 4]);
    });

    it("plays deinterleaved frames in order once started", () => {
        const ring = new StereoRing(16, { targetFrames: 4, ...NoExcess });
        ring.write(framesFrom(1, 4));
        expect(readQuantum(ring)).toEqual({ left: [1, 2, 3, 4], right: [-1, -2, -3, -4] });
        expect(readQuantum(ring).left).toEqual(silence());
    });

    it("scales samples as they are written", () => {
        const ring = new StereoRing(16, { targetFrames: 4, ...NoExcess });
        ring.write(framesFrom(2, 4), 0.5);
        expect(readQuantum(ring).left).toEqual([1, 1.5, 2, 2.5]);
    });

    it("trims a burst that arrives while stopped back to the target", () => {
        const ring = new StereoRing(16, { targetFrames: 4, ...NoExcess });
        ring.write(framesFrom(1, 10));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });

    it("pads an underrun with silence rather than stale data, then rebuffers", () => {
        const ring = new StereoRing(8, { targetFrames: 4, ...NoExcess });
        ring.write(framesFrom(1, 4));
        readQuantum(ring);
        ring.write(framesFrom(5, 2));
        expect(readQuantum(ring)).toEqual({ left: [5, 6, 0, 0], right: [-5, -6, 0, 0] });

        ring.write(framesFrom(7, 3));
        expect(readQuantum(ring).left).toEqual(silence());
        ring.write(framesFrom(10, 1));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });

    it("wraps correctly for block sizes that do not divide the capacity", () => {
        const ring = new StereoRing(7, { targetFrames: 3, ...NoExcess });
        const played = [];
        let next = 1;
        for (let block = 0; block < 20; ++block) {
            ring.write(framesFrom(next, 3));
            next += 3;
            played.push(...readQuantum(ring, 3).left);
        }
        expect(played).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    });

    it("discards the oldest frames when the writer laps the reader", () => {
        const ring = new StereoRing(6, { targetFrames: 2, ...NoExcess });
        ring.write(framesFrom(1, 2));
        readQuantum(ring, 1);
        ring.write(framesFrom(3, 8));
        expect(readQuantum(ring, 6).left).toEqual([5, 6, 7, 8, 9, 10]);
        expect(readQuantum(ring, 1).left).toEqual([0]);
    });

    it("keeps the newest frames from a single block larger than the capacity", () => {
        const ring = new StereoRing(4, { targetFrames: 4, ...NoExcess });
        ring.write(framesFrom(1, 10));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });

    describe("while running with a backlog", () => {
        function runningWithBacklog(persistentExcessFrames, backlog) {
            const ring = new StereoRing(64, { targetFrames: 4, excessFrames: 4, persistentExcessFrames });
            ring.write(framesFrom(1, 4));
            readQuantum(ring);
            ring.write(framesFrom(5, backlog));
            return ring;
        }

        it("plays a backlog past the margin until it has persisted, then skips back to the target", () => {
            const ring = runningWithBacklog(12, 20);
            expect(readQuantum(ring).left).toEqual([5, 6, 7, 8]);
            expect(readQuantum(ring).left).toEqual([9, 10, 11, 12]);
            expect(readQuantum(ring).left).toEqual([21, 22, 23, 24]);
        });

        it("forgets an excess that drains below the margin before it persists", () => {
            const ring = runningWithBacklog(8, 10);
            expect(readQuantum(ring).left).toEqual([5, 6, 7, 8]);
            expect(readQuantum(ring).left).toEqual([9, 10, 11, 12]);
            ring.write(framesFrom(15, 8));
            expect(readQuantum(ring).left).toEqual([13, 14, 15, 16]);
        });

        it("drains to a lowered target once the excess persists", () => {
            const ring = new StereoRing(64, { targetFrames: 12, excessFrames: 2, persistentExcessFrames: 8 });
            ring.write(framesFrom(1, 12));
            readQuantum(ring);
            ring.write(framesFrom(13, 8));
            ring.setTargetFrames(4);
            expect(readQuantum(ring).left).toEqual([5, 6, 7, 8]);
            expect(readQuantum(ring).left).toEqual([17, 18, 19, 20]);
        });
    });
});
