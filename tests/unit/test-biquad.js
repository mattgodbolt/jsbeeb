import { describe, expect, it } from "vitest";

import { LowPassBiquad } from "../../src/biquad.js";

const SampleRate = 500000;
// Chosen so every frequency measured below is a whole number of cycles in
// the measurement window, making the Goertzel amplitude exact.
const Corner = SampleRate / 80;
const Q = 0.696;
const Window = 128000;

function goertzelAmplitude(samples, freq) {
    const w = (2 * Math.PI * freq) / SampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (const sample of samples) {
        const s0 = sample + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / samples.length;
}

function sine(freq, length) {
    const samples = new Float64Array(length);
    for (let i = 0; i < length; ++i) samples[i] = Math.sin((2 * Math.PI * freq * i) / SampleRate);
    return samples;
}

// Gain in dB of a steady sine at freq, measured once the transient has died.
function gainDb(freq) {
    const samples = sine(freq, 2 * Window);
    new LowPassBiquad(SampleRate, Corner, Q).process(samples, 0, samples.length);
    return 20 * Math.log10(goertzelAmplitude(samples.subarray(Window), freq));
}

describe("LowPassBiquad", () => {
    it("should pass frequencies well below the corner unchanged", () => {
        expect(gainDb(Corner / 16)).toBeCloseTo(0, 1);
    });

    it("should have a gain of Q at the corner", () => {
        expect(gainDb(Corner)).toBeCloseTo(20 * Math.log10(Q), 2);
    });

    it("should roll off at 12 dB per octave above the corner", () => {
        const octave = gainDb(8 * Corner) - gainDb(4 * Corner);
        expect(octave).toBeLessThan(-11);
        expect(octave).toBeGreaterThan(-13.5);
    });

    it("should leave the untouched parts of the buffer alone", () => {
        const samples = new Float64Array(10).fill(1);
        new LowPassBiquad(SampleRate, Corner, Q).process(samples, 3, 4);
        expect(Array.from(samples.subarray(0, 3))).toEqual([1, 1, 1]);
        expect(Array.from(samples.subarray(7))).toEqual([1, 1, 1]);
        expect(samples[3]).not.toBe(1);
    });

    it("should carry its state across calls, so chunking does not change the output", () => {
        const whole = sine(Corner, 4096);
        const chunked = Float64Array.from(whole);
        new LowPassBiquad(SampleRate, Corner, Q).process(whole, 0, whole.length);
        const filter = new LowPassBiquad(SampleRate, Corner, Q);
        for (let offset = 0; offset < chunked.length; offset += 128) filter.process(chunked, offset, 128);
        expect(Array.from(chunked)).toEqual(Array.from(whole));
    });
});
