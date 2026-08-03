"use strict";

import VERT_SHADER from "./shaders/passthrough.vert.glsl?raw";
import FRAG_SHADER from "./shaders/passthrough.frag.glsl?raw";
import { compileProgram } from "./shader-program.js";

export class PassthroughFilter {
    static requiresGl() {
        return false;
    }

    static getDisplayConfig() {
        return {
            name: "RGB Monitor",
            image: "images/cub-monitor.png",
            imageAlt: "A fake CUB computer monitor",
            imageWidth: 896,
            imageHeight: 648,
            canvasLeft: 0,
            canvasTop: 8,
            visibleWidth: 896,
            visibleHeight: 600,
            canvasWidth: 896,
            canvasHeight: 600,
        };
    }

    constructor(gl) {
        this.gl = gl;
        this.program = compileProgram(gl, VERT_SHADER, FRAG_SHADER, "passthrough");
        this.locations = {
            tex: gl.getUniformLocation(this.program, "tex"),
        };
    }

    /** Release the GL objects this filter owns. */
    dispose() {
        this.gl.deleteProgram(this.program);
        this.program = null;
    }

    setUniforms(_params) {
        const gl = this.gl;
        gl.uniform1i(this.locations.tex, 0);
    }
}
