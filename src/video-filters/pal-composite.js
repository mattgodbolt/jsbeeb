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
uniform float uLeftBorder;
uniform float uActiveWidth;

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

    // PAL phase alternates each scanline
    float pal_phase = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // PAL subcarrier: 4.43 MHz × 52 μs active video ≈ 230 cycles
    // Calculate phase relative to active video area (not full texture)
    float x_in_active = vPixelCoord.x - uLeftBorder;
    float cycles_per_pixel = 230.0 / uActiveWidth;

    // Sample current and previous scanline for comb filter
    const int SAMPLES = 4;
    float composite_curr = 0.0;
    float composite_prev = 0.0;
    vec2 chroma_demod = vec2(0.0);

    for (int i = 0; i < SAMPLES; i++) {
        float offset = float(i) - float(SAMPLES) / 2.0;
        float t = (x_in_active + offset) * cycles_per_pixel * 2.0 * PI;

        // Current scanline
        vec2 sample_uv = vTexCoord + vec2(offset * uTexelSize.x, 0.0);
        vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
        vec3 yuv = rgb_to_yuv(rgb);

        // Encode to composite: Y + U*sin(ωt) + V*cos(ωt)*phase
        float comp = yuv.x + yuv.y * sin(t) + yuv.z * cos(t) * pal_phase;
        composite_curr += comp;

        // Previous scanline (for comb filter)
        vec2 prev_uv = sample_uv - vec2(0.0, uTexelSize.y);
        vec3 rgb_prev = texture2D(uFramebuffer, prev_uv).rgb;
        vec3 yuv_prev = rgb_to_yuv(rgb_prev);
        float comp_prev = yuv_prev.x + yuv_prev.y * sin(t) + yuv_prev.z * cos(t) * (-pal_phase);
        composite_prev += comp_prev;

        // Demodulate chroma from composite
        chroma_demod.x += comp * sin(t);  // U
        chroma_demod.y += comp * cos(t) * pal_phase;  // V
    }

    composite_curr /= float(SAMPLES);
    composite_prev /= float(SAMPLES);
    chroma_demod /= float(SAMPLES);

    // Comb filter: separate Y and C
    // Y = (current + previous) / 2  (chroma cancels due to phase alternation)
    // C = (current - previous) / 2  (luma cancels)
    float y_out = (composite_curr + composite_prev) * 0.5;

    // Demodulated chroma (scaled back up after averaging)
    float u_out = chroma_demod.x * 2.0;
    float v_out = chroma_demod.y * 2.0;

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
        this.locations.uLeftBorder = gl.getUniformLocation(this.program, "uLeftBorder");
        this.locations.uActiveWidth = gl.getUniformLocation(this.program, "uActiveWidth");

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
