"use strict";

import VERT_SHADER from "./shaders/hqx.vert.glsl?raw";
import FRAG_SHADER from "./shaders/hqx.frag.glsl?raw";

export class HqxFilter {
    static requiresGl() {
        return true;
    }

    static getDisplayConfig() {
        return {
            name: "HQx",
            image: "images/cub-monitor.png",
            imageAlt: "A fake CUB computer monitor",
            imageWidth: 896,
            imageHeight: 648,
            canvasLeft: 0,
            canvasTop: 8,
            visibleWidth: 896,
            visibleHeight: 600,
            // Render at 2× the BBC content resolution so each source texel
            // covers a 2×2 block of output pixels.  The hq2x algorithm needs
            // multiple output pixels per source texel to produce visible
            // anti-aliasing; at 1:1 all four corner blends collapse to the
            // same value and the filter has no visible effect.
            canvasWidth: 1792,
            canvasHeight: 1200,
        };
    }

    constructor(gl) {
        this.gl = gl;
        this.program = null;
        this.locations = {};

        this._init();
    }

    _init() {
        const gl = this.gl;

        const vertexShader = this._compileShader(gl.VERTEX_SHADER, VERT_SHADER);
        const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SHADER);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error("Failed to link HQx shader program: " + gl.getProgramInfoLog(this.program));
        }

        this.locations.tex = gl.getUniformLocation(this.program, "tex");
        this.locations.uTexelSize = gl.getUniformLocation(this.program, "uTexelSize");
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(shader);
            const typeName = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
            gl.deleteShader(shader);
            throw new Error(`Failed to compile HQx ${typeName} shader: ${error}`);
        }

        return shader;
    }

    setUniforms(params) {
        const gl = this.gl;
        gl.uniform1i(this.locations.tex, 0);
        gl.uniform2f(this.locations.uTexelSize, 1.0 / params.width, 1.0 / params.height);
    }
}
