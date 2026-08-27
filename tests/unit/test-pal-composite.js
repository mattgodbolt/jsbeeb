import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { lumaFilterKernel, LumaTaps, PALCompositeFilter } from "../../src/video-filters/pal-composite.js";

const Shader = readFileSync(
    new URL("../../src/video-filters/shaders/pal-composite.frag.glsl", import.meta.url),
    "utf8",
);

/** Signal level of white: BT.470's 0.7 V, which the shader bakes into its matrices. */
const WhiteLevel = 0.7;

/** Six significant figures in the source; sums and products of those agree to about this. */
const Places = 4;

const ComponentColumn = { r: 0, g: 1, b: 2, x: 0, y: 1, z: 2 };

/**
 * The 3x3 matrix a shader function `name` applies to its `argument`, read out
 * of the constants in its `vec3(...)`: one row per line, one column per
 * component the constant multiplies.
 */
function matrixOf(name, argument) {
    const body = new RegExp(`vec3 ${name}\\(vec3 ${argument}\\) \\{([^}]*)\\}`).exec(Shader);
    if (!body) throw new Error(`No ${name} in the shader`);
    const term = new RegExp(`([-+]?)\\s*(\\d+\\.\\d+(?:e[-+]?\\d+)?)\\s*\\*\\s*${argument}\\.([rgbxyz])`, "g");
    const rows = [];
    for (const line of body[1].split("\n")) {
        const terms = [...line.matchAll(term)];
        if (terms.length === 0) continue;
        const row = [0, 0, 0];
        for (const [, sign, value, component] of terms)
            row[ComponentColumn[component]] = Number(value) * (sign === "-" ? -1 : 1);
        rows.push(row);
    }
    if (rows.length !== 3) throw new Error(`${name} has ${rows.length} rows, not 3`);
    return rows;
}

const multiply = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));

const apply = (matrix, vector) => matrix.map((row) => row.reduce((sum, value, k) => sum + value * vector[k], 0));

const expectClose = (actual, expected) =>
    actual.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], Places)));

describe("PAL composite shader matrices", () => {
    const rgbToYuv = matrixOf("rgb_to_yuv", "rgb");
    const yuvToRgb = matrixOf("yuv_to_rgb", "yuv");
    const identity = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];

    it("undo each other in both orders", () => {
        expectClose(multiply(yuvToRgb, rgbToYuv), identity);
        expectClose(multiply(rgbToYuv, yuvToRgb), identity);
    });

    it("put white at the signal level with no chroma", () => {
        const [y, u, v] = apply(rgbToYuv, [1, 1, 1]);
        expect(y).toBeCloseTo(WhiteLevel, Places);
        expect(u).toBeCloseTo(0, Places);
        expect(v).toBeCloseTo(0, Places);
    });

    it("scale BT.470's luma weights by the signal level", () => {
        const bt470Luma = [0.299, 0.587, 0.114];
        rgbToYuv[0].forEach((value, i) => expect(value).toBeCloseTo(WhiteLevel * bt470Luma[i], Places));
    });
});

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
        const taps = /const int LUMA_TAPS = (\d+);/.exec(Shader);
        expect(taps).not.toBeNull();
        expect(Number(taps[1])).toBe(LumaTaps);
    });
});
