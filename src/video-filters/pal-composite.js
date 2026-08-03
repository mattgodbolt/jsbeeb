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

export class PALCompositeFilter {
    static requiresGl() {
        return true;
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
    }
}
