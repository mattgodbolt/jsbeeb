"use strict";

import VERT_SHADER from "./shaders/passthrough.vert.glsl?raw";
import FRAG_SHADER from "./shaders/passthrough.frag.glsl?raw";

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
            throw new Error("Failed to link passthrough shader program: " + gl.getProgramInfoLog(this.program));
        }

        this.locations.tex = gl.getUniformLocation(this.program, "tex");
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error("Shader compilation failed: " + error);
        }

        return shader;
    }

    setUniforms(_params) {
        const gl = this.gl;
        gl.uniform1i(this.locations.tex, 0);
    }
}
