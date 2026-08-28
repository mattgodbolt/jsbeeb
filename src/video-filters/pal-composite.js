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
// The video bandwidth of a set's composite input.
const LumaBandwidthMhz = 5;

const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
// Hann over taps+2 points so the outermost taps are not wasted on zeros.
const hann = (n, taps) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 1)) / (taps + 1));

function lowpassKernel(cutoffMhz, taps) {
    const cutoff = cutoffMhz / SampleRateMhz;
    const centre = (taps - 1) / 2;
    const kernel = [];
    for (let n = 0; n < taps; n++) kernel.push(2 * cutoff * sinc(2 * cutoff * (n - centre)) * hann(n, taps));
    const sum = kernel.reduce((total, x) => total + x, 0);
    return new Float32Array(kernel.map((x) => x / sum));
}

/** The zero-phase kernel applied to luma at the 16 MHz texel rate, LumaTaps coefficients summing to one. */
export const LumaKernel = lowpassKernel(LumaBandwidthMhz, LumaTaps);

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
