import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { lumaFilterKernel, LumaTaps, PALCompositeFilter } from "../../src/video-filters/pal-composite.js";

const SampleRateMhz = 16;
const SubcarrierMhz = 4.43361875;

// Gain of a symmetric kernel at frequencyMhz; symmetric kernels are real (zero phase).
function gainAt(kernel, frequencyMhz) {
    const centre = (kernel.length - 1) / 2;
    const omega = (2 * Math.PI * frequencyMhz) / SampleRateMhz;
    return kernel.reduce((sum, x, n) => sum + x * Math.cos(omega * (n - centre)), 0);
}

const decibels = (gain) => 20 * Math.log10(Math.abs(gain));

describe("PAL luma filter kernel", () => {
    it("is off with no bandwidth and no notch", () => {
        expect(lumaFilterKernel(0, false)).toBeNull();
        expect(lumaFilterKernel(undefined, undefined)).toBeNull();
    });

    it.each([
        [5, false],
        [3, false],
        [5, true],
        [0, true],
    ])("is symmetric, unity at DC and LumaTaps wide (%s MHz, notch %s)", (bandwidth, notch) => {
        const kernel = lumaFilterKernel(bandwidth, notch);
        expect(kernel).toHaveLength(LumaTaps);
        for (let n = 0; n < LumaTaps; n++) expect(kernel[n]).toBeCloseTo(kernel[LumaTaps - 1 - n], 6);
        expect(gainAt(kernel, 0)).toBeCloseTo(1, 5);
    });

    it("passes the low band and is 6 dB down at the cutoff", () => {
        const kernel = lumaFilterKernel(5, false);
        expect(decibels(gainAt(kernel, 1))).toBeCloseTo(0, 0);
        expect(decibels(gainAt(kernel, 5))).toBeCloseTo(-6, 0);
        expect(decibels(gainAt(kernel, 8))).toBeLessThan(-30);
    });

    it("moves the cutoff with the bandwidth", () => {
        const kernel = lumaFilterKernel(3, false);
        expect(decibels(gainAt(kernel, 3))).toBeCloseTo(-6, 0);
        expect(decibels(gainAt(kernel, 5))).toBeLessThan(-30);
    });

    it("rejects the subcarrier with the notch, with and without the low-pass", () => {
        for (const bandwidth of [0, 5]) {
            const kernel = lumaFilterKernel(bandwidth, true);
            expect(decibels(gainAt(kernel, SubcarrierMhz))).toBeLessThan(-60);
            expect(decibels(gainAt(kernel, 1))).toBeCloseTo(0, 0);
        }
    });
});

describe("PALCompositeFilter.setLumaFilter", () => {
    it("keeps the unfiltered path unless asked otherwise", () => {
        PALCompositeFilter.setLumaFilter();
        expect(PALCompositeFilter.lumaKernel).toBeNull();
        PALCompositeFilter.setLumaFilter({ bandwidthMhz: 5 });
        expect(PALCompositeFilter.lumaKernel).toHaveLength(LumaTaps);
        PALCompositeFilter.setLumaFilter({ bandwidthMhz: 0 });
        expect(PALCompositeFilter.lumaKernel).toBeNull();
    });
});

describe("PAL luma filter shader", () => {
    it("declares as many taps as the kernel supplies", () => {
        const shader = readFileSync(
            new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url),
            "utf8",
        );
        const taps = /const int LUMA_TAPS = (\d+);/.exec(shader);
        expect(taps).not.toBeNull();
        expect(Number(taps[1])).toBe(LumaTaps);
    });
});
