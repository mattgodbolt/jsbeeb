import { describe, expect, it } from "vitest";

import { Biquad } from "../../src/biquad.js";

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
function gainDb(filter, freq) {
    const samples = sine(freq, 2 * Window);
    filter.process(samples, 0, samples.length);
    return 20 * Math.log10(goertzelAmplitude(samples.subarray(Window), freq));
}

const lowPass = () => Biquad.lowPass(SampleRate, Corner, Q);
const magnitudeDb = (filter, freq) => 20 * Math.log10(filter.magnitudeAt(SampleRate, freq));

describe("Biquad", () => {
    describe("low-pass", () => {
        it("should pass frequencies well below the corner unchanged", () => {
            expect(gainDb(lowPass(), Corner / 16)).toBeCloseTo(0, 1);
        });

        it("should have a gain of Q at the corner", () => {
            expect(gainDb(lowPass(), Corner)).toBeCloseTo(20 * Math.log10(Q), 2);
        });

        it("should roll off at 12 dB per octave above the corner", () => {
            const octave = gainDb(lowPass(), 8 * Corner) - gainDb(lowPass(), 4 * Corner);
            expect(octave).toBeLessThan(-11);
            expect(octave).toBeGreaterThan(-13.5);
        });
    });

    describe("high-pass", () => {
        it("should pass frequencies well above the corner and have a gain of Q at it", () => {
            const filter = () => Biquad.highPass(SampleRate, Corner, Q);
            expect(gainDb(filter(), 16 * Corner)).toBeCloseTo(0, 1);
            expect(gainDb(filter(), Corner)).toBeCloseTo(20 * Math.log10(Q), 2);
        });

        it("should roll off at 12 dB per octave below the corner", () => {
            const filter = () => Biquad.highPass(SampleRate, Corner, Q);
            const octave = gainDb(filter(), Corner / 8) - gainDb(filter(), Corner / 4);
            expect(octave).toBeLessThan(-11);
            expect(octave).toBeGreaterThan(-13.5);
        });

        it("should peak at the corner for a high Q", () => {
            const filter = Biquad.highPass(SampleRate, Corner, 3);
            expect(magnitudeDb(filter, Corner)).toBeCloseTo(20 * Math.log10(3), 1);
        });
    });

    describe("first-order high-pass", () => {
        it("should be 3 dB down at the corner and fall 6 dB per octave below it", () => {
            const filter = () => Biquad.firstOrderHighPass(SampleRate, Corner);
            expect(gainDb(filter(), Corner)).toBeCloseTo(-3.01, 1);
            expect(gainDb(filter(), Corner / 8) - gainDb(filter(), Corner / 4)).toBeCloseTo(-6, 0);
            expect(gainDb(filter(), 32 * Corner)).toBeCloseTo(0, 1);
        });
    });

    describe("peaking", () => {
        it("should apply its gain at the centre and nothing far away", () => {
            const filter = Biquad.peaking(SampleRate, Corner, 1, 9);
            expect(magnitudeDb(filter, Corner)).toBeCloseTo(9, 2);
            expect(magnitudeDb(filter, Corner / 64)).toBeCloseTo(0, 1);
            expect(magnitudeDb(filter, Corner * 64)).toBeCloseTo(0, 1);
        });
    });

    describe("high shelf", () => {
        it("should apply its gain above the corner and nothing below", () => {
            const filter = Biquad.highShelf(SampleRate, Corner, 0.7, -18);
            expect(magnitudeDb(filter, Corner * 32)).toBeCloseTo(-18, 1);
            expect(magnitudeDb(filter, Corner / 32)).toBeCloseTo(0, 1);
        });
    });

    it("should report the same magnitude it applies", () => {
        for (const filter of [
            () => Biquad.lowPass(SampleRate, Corner, Q),
            () => Biquad.peaking(SampleRate, Corner, 2, 6),
            () => Biquad.firstOrderHighPass(SampleRate, Corner),
        ]) {
            for (const freq of [Corner / 4, Corner, 4 * Corner]) {
                expect(gainDb(filter(), freq)).toBeCloseTo(magnitudeDb(filter(), freq), 2);
            }
        }
    });

    it("should scale by a plain gain", () => {
        const samples = new Float64Array([1, -2, 0.5]);
        Biquad.gain(0.25).process(samples, 0, samples.length);
        expect(Array.from(samples)).toEqual([0.25, -0.5, 0.125]);
    });

    it("should leave the untouched parts of the buffer alone", () => {
        const samples = new Float64Array(10).fill(1);
        lowPass().process(samples, 3, 4);
        expect(Array.from(samples.subarray(0, 3))).toEqual([1, 1, 1]);
        expect(Array.from(samples.subarray(7))).toEqual([1, 1, 1]);
        expect(samples[3]).not.toBe(1);
    });

    it("should carry its state across calls, so chunking does not change the output", () => {
        const whole = sine(Corner, 4096);
        const chunked = Float64Array.from(whole);
        lowPass().process(whole, 0, whole.length);
        const filter = lowPass();
        for (let offset = 0; offset < chunked.length; offset += 128) filter.process(chunked, offset, 128);
        expect(Array.from(chunked)).toEqual(Array.from(whole));
    });
});
