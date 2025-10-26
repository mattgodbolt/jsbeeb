"use strict";

// Passthrough Filter - Simple texture copy for CUB Monitor mode
//
// This filter performs no processing - it simply copies the framebuffer
// texture to the screen with linear interpolation. This is the default
// behavior matching the main branch, providing clean RGB output as seen
// on CUB monitors.

export class PassthroughFilter {
    static getDisplayConfig() {
        return {
            name: "CUB Monitor",
            image: "images/cub-monitor.png",
            imageAlt: "A fake CUB computer monitor",
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

        // Simple vertex shader - same as main branch
        const vertexShader = this._compileShader(
            gl.VERTEX_SHADER,
            `
            attribute vec2 pos;
            attribute vec2 uvIn;
            varying vec2 uv;
            void main() {
                uv = uvIn;
                gl_Position = vec4(2.0 * pos - 1.0, 0.0, 1.0);
            }
        `,
        );

        // Simple fragment shader - just copy texture to screen
        const fragmentShader = this._compileShader(
            gl.FRAGMENT_SHADER,
            `
            precision mediump float;
            uniform sampler2D tex;
            varying vec2 uv;
            void main() {
                gl_FragColor = texture2D(tex, uv).rgba;
            }
        `,
        );

        // Link program
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error("Failed to link passthrough shader program: " + gl.getProgramInfoLog(this.program));
        }

        // Get uniform locations
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
        gl.uniform1i(this.locations.tex, 0); // Texture unit 0
    }
}
