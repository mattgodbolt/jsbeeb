import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

import { generateFirCoefficients } from "../../tools/fir-generator.js";
import { applyFirCoefficients } from "../../tools/vite-plugin-fir-shader.js";

const SampleRateHz = 16e6;

/** What pal-composite.frag.glsl asks for; a test below checks it still does. */
const ShaderTaps = 21;
const ShaderCutoffMhz = 1.108;

const ShaderPath = new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url);

/** The numbers out of the generated GLSL, in tap order. */
function coefficientsOf(code) {
    const taps = [];
    for (const [, index, value] of code.matchAll(/FIR\[(\d+)\] = ([-0-9.e]+);/g)) taps[Number(index)] = Number(value);
    return taps;
}

/** Magnitude of the filter's response at `hz`, in dB relative to DC gain of one. */
function responseDb(taps, hz) {
    let re = 0;
    let im = 0;
    taps.forEach((tap, n) => {
        const angle = (2 * Math.PI * hz * n) / SampleRateHz;
        re += tap * Math.cos(angle);
        im -= tap * Math.sin(angle);
    });
    return 20 * Math.log10(Math.hypot(re, im));
}

/** The lowest frequency at which the response has fallen below `db`, in MHz. */
function crossingMhz(taps, db) {
    const stepHz = 1e3;
    for (let hz = 0; hz < SampleRateHz / 2; hz += stepHz) if (responseDb(taps, hz) < db) return hz / 1e6;
    throw new Error(`Response never falls below ${db} dB`);
}

describe("FIR generator", () => {
    describe("the shader's chroma filter", () => {
        const taps = coefficientsOf(generateFirCoefficients(ShaderTaps, ShaderCutoffMhz, ""));

        it("is what the shader asks for", () => {
            const shader = applyFirCoefficients(readFileSync(ShaderPath, "utf8"));
            expect([shader.taps, shader.cutoff]).toEqual([ShaderTaps, ShaderCutoffMhz]);
        });

        it("has every tap", () => {
            expect(taps).toHaveLength(ShaderTaps);
            expect(taps.every(Number.isFinite)).toBe(true);
        });

        it("has unity gain at DC", () => {
            expect(taps.reduce((sum, tap) => sum + tap, 0)).toBeCloseTo(1, 8);
        });

        it("is symmetric, so has linear phase", () => {
            expect(taps).toEqual([...taps].reverse());
        });

        it("peaks at the centre tap", () => {
            expect(Math.max(...taps)).toBe(taps[(ShaderTaps - 1) / 2]);
        });

        it("is 3 dB down at 0.83 MHz", () => {
            expect(crossingMhz(taps, -3)).toBeCloseTo(0.83, 1);
        });

        it("is 6 dB down at 1.15 MHz", () => {
            expect(crossingMhz(taps, -6)).toBeCloseTo(1.15, 1);
        });

        it("barely touches the low chroma band", () => {
            expect(responseDb(taps, 0.5e6)).toBeGreaterThan(-1.1);
        });

        it("rejects the subcarrier outright", () => {
            expect(responseDb(taps, 2.2e6)).toBeLessThan(-30);
            expect(responseDb(taps, 4.43361875e6)).toBeLessThan(-80);
        });
    });

    describe("GLSL output", () => {
        it("indents every line as asked", () => {
            const lines = generateFirCoefficients(5, 2, "  ").split("\n");
            expect(lines.length).toBeGreaterThan(0);
            for (const line of lines) expect(line.startsWith("  FIR[")).toBe(true);
        });

        it("rejects an even number of taps", () => {
            expect(() => generateFirCoefficients(20, 1, "")).toThrow();
        });

        it("rejects a cutoff beyond Nyquist", () => {
            expect(() => generateFirCoefficients(21, 9, "")).toThrow();
        });
    });
});
