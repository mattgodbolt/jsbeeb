import { describe, expect, it } from "vitest";

import { generateLumaCoefficients, generateLumaKernel, LumaTaps } from "../../tools/luma-fir-generator.js";

const SampleRateMhz = 16;
const SubcarrierMhz = 4.43361875;

// Gain of a symmetric kernel at frequencyMhz; symmetric kernels are real (zero phase).
function gainAt(kernel, frequencyMhz) {
    const centre = (kernel.length - 1) / 2;
    const omega = (2 * Math.PI * frequencyMhz) / SampleRateMhz;
    return kernel.reduce((sum, x, n) => sum + x * Math.cos(omega * (n - centre)), 0);
}

const decibels = (gain) => 20 * Math.log10(Math.abs(gain));

describe("PAL luma FIR generator", () => {
    describe("the kernel", () => {
        const kernel = generateLumaKernel();

        it("is symmetric, unity at DC and LumaTaps wide", () => {
            expect(kernel).toHaveLength(LumaTaps);
            for (let n = 0; n < LumaTaps; n++) expect(kernel[n]).toBeCloseTo(kernel[LumaTaps - 1 - n], 6);
            expect(gainAt(kernel, 0)).toBeCloseTo(1, 5);
        });

        it("passes luma to 3.5 MHz within 3 dB and holds the band below flat within 1 dB", () => {
            for (let frequency = 0; frequency <= 3; frequency += 0.1)
                expect(Math.abs(decibels(gainAt(kernel, frequency)))).toBeLessThanOrEqual(1);
            expect(decibels(gainAt(kernel, 3.5))).toBeGreaterThanOrEqual(-3);
        });

        it("traps the subcarrier by 60 dB and is at least 6 dB down at 4.5 MHz", () => {
            expect(decibels(gainAt(kernel, SubcarrierMhz))).toBeLessThan(-60);
            expect(decibels(gainAt(kernel, 4.5))).toBeLessThanOrEqual(-6);
            expect(decibels(gainAt(kernel, 8))).toBeLessThan(-30);
        });
    });

    describe("GLSL output", () => {
        const code = generateLumaCoefficients("  ");

        it("assigns every tap of the kernel, in order, at the indent asked for", () => {
            const assignments = [...code.matchAll(/LUMA_FIR\[(\d+)\] = ([-0-9.e]+);/g)];
            expect(assignments.map((m) => Number(m[1]))).toEqual([...Array(LumaTaps).keys()]);
            generateLumaKernel().forEach((tap, n) => expect(Number(assignments[n][2])).toBeCloseTo(tap, 9));
            for (const line of code.split("\n")) expect(line.startsWith("  LUMA_FIR[")).toBe(true);
        });
    });
});
