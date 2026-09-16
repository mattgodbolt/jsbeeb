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
import { PalCyclesPerLine, PalPhasePerLine } from "../video.js";

/**
 * How far the raster bows outwards at the middle of each edge, as a fraction of its half
 * size, to roughly match the bezel in tv.png; canvasLeft and canvasTop below place it in
 * the bezel.
 */
export const PalScreenCurvature = { x: 1 / 48, y: 1 / 48 };

export class PALCompositeFilter {
    static getDisplayConfig() {
        return {
            name: "PAL TV",
            image: "images/tv.png",
            imageAlt: "A Ferguson television",
            imageWidth: 1000,
            imageHeight: 719,
            canvasLeft: 25,
            canvasTop: 60,
            visibleWidth: 825,
            visibleHeight: 620,
            canvasWidth: 896,
            canvasHeight: 600,
            persistence: { setting: "palPersistenceMs", default: 40 },
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
            uPhaseBase: gl.getUniformLocation(this.program, "uPhaseBase"),
            uCyclesPerLine: gl.getUniformLocation(this.program, "uCyclesPerLine"),
            uPhasePerLine: gl.getUniformLocation(this.program, "uPhasePerLine"),
            uExtentCentre: gl.getUniformLocation(this.program, "uExtentCentre"),
            uExtentHalfSize: gl.getUniformLocation(this.program, "uExtentHalfSize"),
            uCurvature: gl.getUniformLocation(this.program, "uCurvature"),
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
        gl.uniform2f(this.locations.uPhaseBase, params.phaseBaseEven, params.phaseBaseOdd);
        gl.uniform1f(this.locations.uCyclesPerLine, PalCyclesPerLine);
        gl.uniform1f(this.locations.uPhasePerLine, PalPhasePerLine);
        const { minx, miny, maxx, maxy } = params.extent;
        gl.uniform2f(this.locations.uExtentCentre, (minx + maxx) / 2 / params.width, (miny + maxy) / 2 / params.height);
        gl.uniform2f(
            this.locations.uExtentHalfSize,
            (maxx - minx) / 2 / params.width,
            (maxy - miny) / 2 / params.height,
        );
        gl.uniform2f(this.locations.uCurvature, PalScreenCurvature.x, PalScreenCurvature.y);
    }
}
