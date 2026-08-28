"use strict";

// PAL Composite Video Filter - Approach D: Baseband Chroma Blending
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// a BBC Micro's UHF-modulated picture on a PAL television.
//
// REFERENCES:
// - John Watkinson's "Engineer's Guide to Decoding & Encoding" (Section 3.4)
// - https://www.jim-easterbrook.me.uk/pal/ - Jim Easterbrook's PAL decoder research
// - docs/pal-simulation-design.md - Full implementation details and alternatives tried
// - docs/pal-comb-filter-research.md - Research on authentic PAL TV implementations

import VERT_SHADER from "./shaders/pal-composite.vert.glsl?raw";
import FRAG_SHADER from "./shaders/pal-composite.frag.glsl?raw";
import { compileProgram } from "./shader-program.js";

export const LumaTaps = 31;
const SampleRateMhz = 16;
const PalSubcarrierMhz = 4.43361875;
// The IF strip's roll-off below the sound carrier, as the picture came in by UHF.
const LumaBandwidthMhz = 4.5;
const LowpassTaps = 13;
// The two convolve to LumaTaps.
const NotchTaps = LumaTaps - LowpassTaps + 1;
// A lower beta narrows the trap, at the cost of ripple either side of it.
const NotchBeta = 3;

const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Windows span taps+2 points so the outermost taps are not wasted on zeros.
const hann = (n, taps) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 1)) / (taps + 1));
const kaiser = (n, taps, beta) => {
    const r = (2 * (n + 1)) / (taps + 1) - 1;
    return besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
};

function besselI0(x) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 50; k++) {
        term *= (x / (2 * k)) ** 2;
        sum += term;
    }
    return sum;
}

const centreOf = (taps) => (taps - 1) / 2;

function lowpassKernel(cutoffMhz, taps) {
    const cutoff = cutoffMhz / SampleRateMhz;
    const centre = centreOf(taps);
    const kernel = [];
    for (let n = 0; n < taps; n++) kernel.push(2 * cutoff * sinc(2 * cutoff * (n - centre)) * hann(n, taps));
    return kernel;
}

// Identity minus a windowed bandpass of unit gain at the subcarrier.
function notchKernel(taps, beta) {
    const omega = (2 * Math.PI * PalSubcarrierMhz) / SampleRateMhz;
    const centre = centreOf(taps);
    const bandpass = [];
    for (let n = 0; n < taps; n++) bandpass.push(Math.cos(omega * (n - centre)) * kaiser(n, taps, beta));
    const gainAtSubcarrier = bandpass.reduce((sum, x, n) => sum + x * Math.cos(omega * (n - centre)), 0);
    return bandpass.map((x, n) => (n === centre ? 1 : 0) - x / gainAtSubcarrier);
}

function convolve(a, b) {
    const result = new Array(a.length + b.length - 1).fill(0);
    a.forEach((x, i) => b.forEach((y, j) => (result[i + j] += x * y)));
    return result;
}

function unitDc(kernel) {
    const sum = kernel.reduce((total, x) => total + x, 0);
    return Float32Array.from(kernel, (x) => x / sum);
}

/** The set's luma path at the 16 MHz texel rate, low-pass and subcarrier trap: LumaTaps coefficients summing to one. */
export const LumaKernel = unitDc(
    convolve(lowpassKernel(LumaBandwidthMhz, LowpassTaps), notchKernel(NotchTaps, NotchBeta)),
);

export class PALCompositeFilter {
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
            uLineBase: gl.getUniformLocation(this.program, "uLineBase"),
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
        gl.uniform2f(this.locations.uLineBase, params.lineBaseEven, params.lineBaseOdd);
        gl.uniform1fv(this.locations.uLumaFir, LumaKernel);
    }
}
