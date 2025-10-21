"use strict";

// PAL Composite Video Filter
// Proof-of-concept implementation

const VERT_SHADER = `
attribute vec2 pos;
attribute vec2 uvIn;
varying vec2 vTexCoord;
varying vec2 vPixelCoord;
uniform vec2 uResolution;

void main() {
    vTexCoord = uvIn;
    vPixelCoord = uvIn * uResolution;
    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG_SHADER = `
precision mediump float;

varying vec2 vTexCoord;
varying vec2 vPixelCoord;

uniform sampler2D uFramebuffer;
uniform vec2 uTexelSize;

const float PI = 3.14159265359;

vec3 rgb_to_yuv(vec3 rgb) {
    return vec3(
        0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b,
        -0.147 * rgb.r - 0.289 * rgb.g + 0.436 * rgb.b,
        0.615 * rgb.r - 0.515 * rgb.g - 0.100 * rgb.b
    );
}

vec3 yuv_to_rgb(vec3 yuv) {
    return vec3(
        yuv.x + 1.140 * yuv.z,
        yuv.x - 0.394 * yuv.y - 0.581 * yuv.z,
        yuv.x + 2.028 * yuv.y
    );
}

void main() {
    float line = floor(vPixelCoord.y);
    float x_pos = vPixelCoord.x;

    // PAL phase alternates each scanline
    float pal_phase = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // Sample at 4x subcarrier frequency across a few pixels
    // This simulates the composite encode/decode process
    const int SAMPLES = 4;
    vec3 yuv_sum = vec3(0.0);

    for (int i = 0; i < SAMPLES; i++) {
        float offset = float(i) - float(SAMPLES) / 2.0;
        vec2 sample_uv = vTexCoord + vec2(offset * uTexelSize.x, 0.0);
        vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
        vec3 yuv = rgb_to_yuv(rgb);

        // Encode to composite: Y + U*sin(ωt) + V*cos(ωt)*phase
        // We're using x position as our time 't'
        float t = (x_pos + offset) * 0.5;  // Scale for subcarrier frequency
        float composite = yuv.x + yuv.y * sin(t) + yuv.z * cos(t) * pal_phase;

        // Decode: multiply by sin/cos to extract U and V
        // This is where the crosstalk happens that creates artifacts
        float u_demod = composite * sin(t);
        float v_demod = composite * cos(t) * pal_phase;

        yuv_sum += vec3(composite, u_demod, v_demod);
    }

    vec3 yuv_avg = yuv_sum / float(SAMPLES);

    // The 'composite' value has luma + chroma mixed
    // Separate them with a simple comb filter
    float y_out = yuv_avg.x;
    float u_out = yuv_avg.y * 2.0;  // Demodulated U
    float v_out = yuv_avg.z * 2.0;  // Demodulated V

    vec3 rgb_out = yuv_to_rgb(vec3(y_out, u_out, v_out));
    gl_FragColor = vec4(clamp(rgb_out, 0.0, 1.0), 1.0);
}
`;

export class PALCompositeFilter {
    constructor(gl) {
        this.gl = gl;
        this.program = null;
        this.locations = {};

        this._init();
    }

    _init() {
        const gl = this.gl;

        // Compile shaders
        const vertShader = this._compileShader(gl.VERTEX_SHADER, VERT_SHADER);
        const fragShader = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SHADER);

        // Link program
        this.program = gl.createProgram();
        gl.attachShader(this.program, vertShader);
        gl.attachShader(this.program, fragShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(this.program);
            throw new Error("Failed to link PAL shader program: " + info);
        }

        // Get uniform locations
        this.locations.uFramebuffer = gl.getUniformLocation(this.program, "uFramebuffer");
        this.locations.uResolution = gl.getUniformLocation(this.program, "uResolution");
        this.locations.uTexelSize = gl.getUniformLocation(this.program, "uTexelSize");

        console.log("PAL composite filter initialized");
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            const typeName = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
            throw new Error(`Failed to compile ${typeName} shader: ${info}`);
        }

        return shader;
    }
}
