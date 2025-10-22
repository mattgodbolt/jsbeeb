"use strict";

// PAL Composite Video Filter
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// connecting a BBC Micro to a PAL television via composite cable.
//
// IMPLEMENTATION:
// 1. Encode RGB to PAL composite: Y + U*sin(ωt) + V*cos(ωt)*phase
// 2. Demodulate chroma with 20-tap FIR low-pass filter (~1.3 MHz bandwidth)
// 3. Apply FIR_GAIN = 2.0 to compensate for demodulation amplitude loss (CRITICAL!)
// 4. Extract luma via 2H comb filter with tunable weighting (COMB_PREV_WEIGHT)
// 5. Combine filtered luma and chroma, convert back to RGB
//
// TUNABLE PARAMETERS:
// - FIR_GAIN: Must be 2.0 to compensate for sin²(x) amplitude loss during demodulation
// - COMB_PREV_WEIGHT: Controls blur vs sharpness tradeoff
//   * 0.5 = authentic equal-weight comb (Watkinson)
//   * 0.33 = current setting (1/3 prev, 2/3 curr) - empirically tuned
//   * Lower values favor current line → sharper but potentially more cross-color
//
// REFERENCES:
// - John Watkinson's "Engineer's Guide to Decoding & Encoding" (Section 3.4)
// - https://www.jim-easterbrook.me.uk/pal/ - Jim Easterbrook's PAL decoder research
// - docs/pal-simulation-design.md - Full implementation details and alternatives tried
// - docs/pal-comb-filter-research.md - Research on authentic PAL TV implementations

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
uniform float uFrameCount;

const float PI = 3.14159265359;

// Chroma demodulation gain - CRITICAL: Must be 2.0 to compensate for sin²(x) amplitude loss
const float FIR_GAIN = 2.0;

// 2H comb filter weight - controls blur vs sharpness tradeoff
// 0.5 = equal weight (Watkinson), 0.33 = current (empirical), lower = sharper
const float COMB_PREV_WEIGHT = 0.33;

// 20-tap FIR low-pass filter coefficients for chroma bandwidth limiting (~1.3 MHz)
// Copied from svofski/CRT (glsl/shaders/singlepass/pass1.fsh:24)
const int FIRTAPS = 20;

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

// Demodulate composite signal: multiply by carrier to shift chroma to baseband
vec2 demodulate_uv(vec2 xy, float offset_pixels, float pal_phase, float cycles_per_pixel, float phase_offset) {
    float t = ((vPixelCoord.x + offset_pixels) * cycles_per_pixel + phase_offset) * 2.0 * PI;

    vec2 sample_uv = xy + vec2(offset_pixels * uTexelSize.x, 0.0);
    vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
    vec3 yuv = rgb_to_yuv(rgb);

    // Encode to composite: Y + U*sin(ωt) + V*cos(ωt)*phase
    float composite = yuv.x + yuv.y * sin(t) + yuv.z * cos(t) * pal_phase;

    // Demodulate: multiply by carrier to shift chroma to baseband
    return vec2(composite * sin(t), composite * cos(t) * pal_phase);
}

void main() {
    // Initialize FIR coefficients (GLSL ES 1.00 limitation)
    float FIR[20];
    FIR[0] = -0.008030271; FIR[1] = 0.003107906; FIR[2] = 0.016841352; FIR[3] = 0.032545161;
    FIR[4] = 0.049360136; FIR[5] = 0.066256720; FIR[6] = 0.082120150; FIR[7] = 0.095848433;
    FIR[8] = 0.106453014; FIR[9] = 0.113151423; FIR[10] = 0.115441842; FIR[11] = 0.113151423;
    FIR[12] = 0.106453014; FIR[13] = 0.095848433; FIR[14] = 0.082120150; FIR[15] = 0.066256720;
    FIR[16] = 0.049360136; FIR[17] = 0.032545161; FIR[18] = 0.016841352; FIR[19] = 0.003107906;

    float line = floor(vPixelCoord.y);

    // PAL phase alternates each scanline (V component inverts)
    float pal_phase = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // PAL subcarrier: 4.43MHz × 64μs = 283.75 cycles/line
    // BBC Micro maps this across 1024 pixels (896 visible + 128 blanking)
    const float cycles_per_pixel = 283.75 / 1024.0;

    // PAL temporal phase (4-field sequence creates animated dot crawl)
    // 0.75 cycles/line accumulates: 625 lines × 0.75 = 468.75 cycles/frame
    float line_phase_offset = line * 0.75;
    float frame_phase_offset = uFrameCount * 468.75;

    // Demodulate composite signal and apply FIR low-pass filter to extract chroma
    float phase_offset = line_phase_offset + frame_phase_offset;
    vec2 filtered_uv = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - FIRTAPS / 2);
        vec2 uv = demodulate_uv(vTexCoord, offset, pal_phase, cycles_per_pixel, phase_offset);
        filtered_uv += FIR_GAIN * uv * FIR[i];
    }

    // Extract luma using 2H comb filter
    // 2H spacing provides 180° phase shift (1.5 cycles) for proper chroma cancellation

    // Current scanline
    float t_curr = (vPixelCoord.x * cycles_per_pixel + phase_offset) * 2.0 * PI;
    vec3 rgb_curr = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv_curr = rgb_to_yuv(rgb_curr);
    float composite_curr = yuv_curr.x + yuv_curr.y * sin(t_curr) + yuv_curr.z * cos(t_curr) * pal_phase;

    // Previous scanline (2 lines up for 2H spacing)
    vec2 prev_uv = vTexCoord - vec2(0.0, 2.0 * uTexelSize.y);
    float prev_line = line - 2.0;
    float prev_pal_phase = mod(prev_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float prev_phase_offset = prev_line * 0.75 + frame_phase_offset;
    float t_prev = (vPixelCoord.x * cycles_per_pixel + prev_phase_offset) * 2.0 * PI;
    vec3 rgb_prev = texture2D(uFramebuffer, prev_uv).rgb;
    vec3 yuv_prev = rgb_to_yuv(rgb_prev);
    float composite_prev = yuv_prev.x + yuv_prev.y * sin(t_prev) + yuv_prev.z * cos(t_prev) * prev_pal_phase;

    // Apply weighted 2H comb filter
    float y_out = COMB_PREV_WEIGHT * composite_prev + (1.0 - COMB_PREV_WEIGHT) * composite_curr;

    vec3 rgb_out = yuv_to_rgb(vec3(y_out, filtered_uv.x, filtered_uv.y));
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
        this.locations.uFrameCount = gl.getUniformLocation(this.program, "uFrameCount");

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
