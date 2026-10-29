import { describe, expect, it } from "vitest";

import { PolyphaseResampler } from "../../src/resampler.js";
import { goertzelAmplitude } from "./helpers.js";

const InputRate = 500000;
const OutputRate = 48000;
const Ratio = InputRate / OutputRate;
const Cutoff = 0.4 * OutputRate;

// Push `signal` through in quanta of `quantum` output samples, as the worklet does.
function resampleInQuanta(signal, quantum, options = {}) {
    const resampler = new PolyphaseResampler(InputRate, Cutoff, options);
    const out = [];
    let phase = 0;
    let consumed = 0;
    const chunk = new Float32Array(quantum);
    for (;;) {
        const end = phase + quantum * Ratio;
        const count = Math.floor(end);
        if (consumed + count > signal.length) break;
        resampler.reserve(count);
        resampler.buffer.set(signal.subarray(consumed, consumed + count), resampler.inputOffset);
        consumed += count;
        resampler.read(chunk, phase, Ratio);
        resampler.commit();
        out.push(...chunk);
        phase = end - count;
    }
    return Float32Array.from(out);
}

const tone = (hz, seconds, amplitude = 1) =>
    Float32Array.from(
        { length: seconds * InputRate },
        (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / InputRate),
    );

describe("PolyphaseResampler", () => {
    it("should pass DC at unity gain", () => {
        const out = resampleInQuanta(new Float32Array(InputRate / 10).fill(0.5), 128);
        const settled = out.subarray(1000);
        expect(Math.min(...settled)).toBeCloseTo(0.5, 5);
        expect(Math.max(...settled)).toBeCloseTo(0.5, 5);
    });

    it("should pass an audible tone with its amplitude intact", () => {
        const out = resampleInQuanta(tone(1000, 0.2), 128);
        expect(goertzelAmplitude(out.subarray(2000), 1000, OutputRate)).toBeCloseTo(1, 2);
    });

    it("should remove what lies above the output rate's Nyquist before it can fold", () => {
        const carrier = 31250;
        const out = resampleInQuanta(tone(carrier, 0.2), 128);
        expect(goertzelAmplitude(out.subarray(2000), OutputRate - carrier, OutputRate)).toBeLessThan(1e-4);
    });

    it("should give the same output whatever the quantum size", () => {
        const signal = tone(3000, 0.05, 0.7);
        const a = resampleInQuanta(signal, 128);
        const b = resampleInQuanta(signal, 37);
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; ++i) expect(b[i]).toBeCloseTo(a[i], 4);
    });
});
