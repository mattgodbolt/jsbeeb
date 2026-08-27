"use strict";

// PAL Composite Video Filter - Approach D: Baseband Chroma Blending
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// connecting a BBC Micro to a PAL television via composite cable.
//
// REFERENCES:
// - John Watkinson's "Engineer's Guide to Decoding & Encoding" (Section 3.4)
// - https://www.jim-easterbrook.me.uk/pal/ - Jim Easterbrook's PAL decoder research
// - docs/pal-simulation-design.md - Full implementation details and alternatives tried
// - docs/pal-comb-filter-research.md - Research on authentic PAL TV implementations

import VERT_SHADER from "./shaders/pal-composite.vert.glsl?raw";
import FRAG_SHADER from "./shaders/pal-composite.frag.glsl?raw";
import { compileProgram } from "./shader-program.js";

export const LumaTaps = 15;
const SampleRateMhz = 16;
const PalSubcarrierMhz = 4.43361875;
// When combined with a low-pass; the two convolve to LumaTaps. Alone, a notch is LumaTaps wide.
const NotchTaps = 9;

const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Hann over taps+2 points so the outermost taps are not wasted on zeros.
const hann = (n, taps) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 1)) / (taps + 1));
const centreOf = (taps) => (taps - 1) / 2;
const scale = (kernel, factor) => kernel.map((x) => x * factor);

function lowpassKernel(cutoffMhz, taps) {
    const cutoff = cutoffMhz / SampleRateMhz;
    const centre = centreOf(taps);
    const kernel = [];
    for (let n = 0; n < taps; n++) kernel.push(2 * cutoff * sinc(2 * cutoff * (n - centre)) * hann(n, taps));
    return kernel;
}

// Identity minus a windowed bandpass of unit gain at the subcarrier.
function notchKernel(taps) {
    const omega = (2 * Math.PI * PalSubcarrierMhz) / SampleRateMhz;
    const centre = centreOf(taps);
    const bandpass = [];
    for (let n = 0; n < taps; n++) bandpass.push(Math.cos(omega * (n - centre)) * hann(n, taps));
    const gainAtSubcarrier = bandpass.reduce((sum, x, n) => sum + x * Math.cos(omega * (n - centre)), 0);
    return scale(bandpass, -1 / gainAtSubcarrier).map((x, n) => (n === centre ? 1 + x : x));
}

function convolve(a, b) {
    const result = new Array(a.length + b.length - 1).fill(0);
    a.forEach((x, i) => b.forEach((y, j) => (result[i + j] += x * y)));
    return result;
}

/**
 * The zero-phase kernel applied to luma at the 16 MHz texel rate, or null for none.
 *
 * @param {number} bandwidthMhz low-pass cutoff (-6 dB), 0 for no low-pass
 * @param {boolean} notch reject the colour subcarrier as well
 * @returns {Float32Array|null} LumaTaps coefficients summing to one
 */
export function lumaFilterKernel(bandwidthMhz, notch) {
    const lowpass = bandwidthMhz > 0;
    if (!lowpass && !notch) return null;
    let kernel = [1];
    if (lowpass) kernel = convolve(kernel, lowpassKernel(bandwidthMhz, notch ? LumaTaps - NotchTaps + 1 : LumaTaps));
    if (notch) kernel = convolve(kernel, notchKernel(lowpass ? NotchTaps : LumaTaps));
    // Unity at DC; the scaling leaves the notch's null where it is.
    return new Float32Array(scale(kernel, 1 / kernel.reduce((sum, x) => sum + x, 0)));
}

let lumaKernel = null;

export class PALCompositeFilter {
    /** Set the luma bandwidth limit every PAL filter applies from its next frame on. */
    static setLumaFilter({ bandwidthMhz = 0, notch = false } = {}) {
        lumaKernel = lumaFilterKernel(bandwidthMhz, notch);
    }

    static get lumaKernel() {
        return lumaKernel;
    }

    static getDisplayConfig() {
        return {
            name: "PAL TV",
            image: "images/tv.png",
            imageAlt: "A SolaVox television",
            imageWidth: 1000,
            imageHeight: 719,
            canvasLeft: 50,
            canvasTop: 70,
            visibleWidth: 800,
            visibleHeight: 600,
            canvasWidth: 896,
            canvasHeight: 600,
        };
    }

    constructor(gl) {
        this.gl = gl;
        this.program = compileProgram(gl, VERT_SHADER, FRAG_SHADER, "PAL composite");
        this.locations = {
            uFramebuffer: gl.getUniformLocation(this.program, "uFramebuffer"),
            uResolution: gl.getUniformLocation(this.program, "uResolution"),
            uTexelSize: gl.getUniformLocation(this.program, "uTexelSize"),
            uFrameCount: gl.getUniformLocation(this.program, "uFrameCount"),
            uLumaFilter: gl.getUniformLocation(this.program, "uLumaFilter"),
            uLumaFir: gl.getUniformLocation(this.program, "uLumaFir[0]"),
        };
    }

    /** Release the GL objects this filter owns. */
    dispose() {
        this.gl.deleteProgram(this.program);
        this.program = null;
    }

    setUniforms(params) {
        const gl = this.gl;
        gl.uniform1i(this.locations.uFramebuffer, 0); // Texture unit 0
        gl.uniform2f(this.locations.uResolution, params.width, params.height);
        gl.uniform2f(this.locations.uTexelSize, 1.0 / params.width, 1.0 / params.height);
        gl.uniform1f(this.locations.uFrameCount, params.frameCount % 8); // 8-field temporal phase sequence
        gl.uniform1f(this.locations.uLumaFilter, lumaKernel ? 1 : 0);
        if (lumaKernel) gl.uniform1fv(this.locations.uLumaFir, lumaKernel);
    }
}
