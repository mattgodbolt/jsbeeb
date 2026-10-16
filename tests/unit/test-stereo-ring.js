import { describe, it, expect } from "vitest";

import { StereoRing } from "../../src/stereo-ring.js";

const Quantum = 4;

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

describe("StereoRing", () => {
    it("outputs silence until the start threshold is reached", () => {
        const ring = new StereoRing(16, 6);
        ring.write(framesFrom(1, 5));
        expect(readQuantum(ring)).toEqual({ left: [0, 0, 0, 0], right: [0, 0, 0, 0] });
        expect(ring.occupancy).toBe(5);
    });

    it("plays deinterleaved frames in order once started", () => {
        const ring = new StereoRing(16, 4);
        ring.write(framesFrom(1, 4));
        expect(readQuantum(ring)).toEqual({ left: [1, 2, 3, 4], right: [-1, -2, -3, -4] });
        expect(ring.occupancy).toBe(0);
    });

    it("scales samples as they are written", () => {
        const ring = new StereoRing(16, 4);
        ring.write(framesFrom(2, 4), 0.5);
        expect(readQuantum(ring).left).toEqual([1, 1.5, 2, 2.5]);
    });

    it("trims a burst that arrives while stopped back to the start threshold", () => {
        const ring = new StereoRing(16, 4);
        ring.write(framesFrom(1, 10));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });

    it("pads an underrun with silence rather than stale data, then rebuffers", () => {
        const ring = new StereoRing(8, 4);
        ring.write(framesFrom(1, 4));
        readQuantum(ring);
        ring.write(framesFrom(5, 2));
        expect(readQuantum(ring)).toEqual({ left: [5, 6, 0, 0], right: [-5, -6, 0, 0] });

        ring.write(framesFrom(7, 3));
        expect(readQuantum(ring).left).toEqual([0, 0, 0, 0]);
        ring.write(framesFrom(10, 1));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });

    it("wraps correctly for block sizes that do not divide the capacity", () => {
        const ring = new StereoRing(7, 3);
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
        const ring = new StereoRing(6, 2);
        ring.write(framesFrom(1, 2));
        readQuantum(ring, 1);
        ring.write(framesFrom(3, 8));
        expect(ring.occupancy).toBe(6);
        expect(readQuantum(ring, 6).left).toEqual([5, 6, 7, 8, 9, 10]);
    });

    it("keeps the newest frames from a single block larger than the capacity", () => {
        const ring = new StereoRing(4, 4);
        ring.write(framesFrom(1, 10));
        expect(readQuantum(ring).left).toEqual([7, 8, 9, 10]);
    });
});
