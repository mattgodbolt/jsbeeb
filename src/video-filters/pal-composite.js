"use strict";

// PAL Composite Video Filter - Approach D: Baseband Chroma Blending
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// connecting a BBC Micro to a PAL television via composite cable.
//
// IMPLEMENTATION (Baseband Blending Method):
// 1. Encode RGB to PAL composite: Y + CHROMA_GAIN*(U*sin(ωt) + V*cos(ωt)*v_switch)
// 2. Demodulate current line (with correct phase) → U_curr, V_curr
// 3. Demodulate previous line (with correct phase) → U_prev, V_prev
// 4. Blend at baseband: U_final = mix(U_curr, U_prev), V_final = mix(V_curr, V_prev)
// 5. Remodulate blended chroma back to composite frequency
// 6. Extract luma via complementary subtraction: Y = composite - remodulated_chroma
// 7. Combine luma and chroma, convert back to RGB
//
// KEY INSIGHT: Demodulate FIRST (with each line's correct phase), THEN blend.
// This avoids U/V mixing that occurs when blending at composite level (Approach C failure).
//
// TUNABLE PARAMETERS:
// - CHROMA_GAIN: Set to 0.2 to prevent overmodulation (fully saturated colors would clip)
// - FIR_GAIN: Must be 2.0 to compensate for sin²(x) amplitude loss during demodulation
// - CHROMA_BLEND_WEIGHT: Controls vertical chroma blending (0.0 = sharp, 0.5 = smooth)
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

// Chroma amplitude: No scaling needed - BBC Micro palette works fine at full amplitude
// Theoretical overmodulation with fully saturated colors doesn't appear to be an issue in practice
const float CHROMA_GAIN = 1.0;

// Chroma demodulation gain: compensates for sin²(x) = 0.5 - 0.5·cos(2x) amplitude loss
const float FIR_GAIN = 2.0;

// Chroma vertical blending weight (0.0 = no blend, 0.5 = equal blend)
const float CHROMA_BLEND_WEIGHT = 0.5;

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

// Demodulate composite signal at given position
vec2 demodulate_uv(vec2 xy, float offset_pixels, float v_switch, float cycles_per_pixel, float phase_offset) {
    float t = ((vPixelCoord.x + offset_pixels) * cycles_per_pixel + phase_offset) * 2.0 * PI;

    vec2 sample_uv = xy + vec2(offset_pixels * uTexelSize.x, 0.0);
    vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
    vec3 yuv = rgb_to_yuv(rgb);

    // Encode to composite: Y + CHROMA_GAIN * (U*sin(ωt) + V*cos(ωt)*v_switch)
    // CHROMA_GAIN prevents overmodulation (see docs/pal-simulation-design.md)
    float composite = yuv.x + CHROMA_GAIN * (yuv.y * sin(t) + yuv.z * cos(t) * v_switch);

    // Demodulate: multiply by carrier to shift chroma to baseband
    return vec2(composite * sin(t), composite * cos(t) * v_switch);
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
    float v_switch = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // PAL subcarrier: 4.43MHz × 64μs = 283.75 cycles/line
    // BBC Micro maps this across 1024 pixels (896 visible + 128 blanking)
    const float cycles_per_pixel = 283.75 / 1024.0;

    // PAL temporal phase (4-field sequence creates animated dot crawl)
    // 0.75 cycles/line accumulates: 625 lines × 0.75 = 468.75 cycles/frame
    float line_phase_offset = line * 0.75;
    float frame_phase_offset = uFrameCount * 468.75;
    float phase_offset = line_phase_offset + frame_phase_offset;

    // Approach D: Baseband Chroma Blending
    // Demodulate current and previous lines separately, then blend at baseband

    // Step 1: Demodulate current line with FIR filter
    vec2 filtered_uv_curr = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - FIRTAPS / 2);
        vec2 uv = demodulate_uv(vTexCoord, offset, v_switch, cycles_per_pixel, phase_offset);
        filtered_uv_curr += FIR_GAIN * uv * FIR[i];
    }

    // Step 2: Demodulate previous line (1H) with FIR filter
    vec2 prev_uv = vTexCoord - vec2(0.0, 1.0 * uTexelSize.y);
    float prev_line = line - 1.0;
    float prev_v_switch = mod(prev_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float prev_phase_offset = prev_line * 0.75 + frame_phase_offset;

    vec2 filtered_uv_prev = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - FIRTAPS / 2);
        vec2 uv = demodulate_uv(prev_uv, offset, prev_v_switch, cycles_per_pixel, prev_phase_offset);
        filtered_uv_prev += FIR_GAIN * uv * FIR[i];
    }

    // Step 3: Blend chroma at baseband (no U/V mixing!)
    vec2 filtered_uv = mix(filtered_uv_curr, filtered_uv_prev, CHROMA_BLEND_WEIGHT);

    // Step 4: Get luma via complementary subtraction
    float t_curr = (vPixelCoord.x * cycles_per_pixel + phase_offset) * 2.0 * PI;
    vec3 rgb_curr = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv_curr = rgb_to_yuv(rgb_curr);
    float composite_curr = yuv_curr.x + CHROMA_GAIN * (yuv_curr.y * sin(t_curr) + yuv_curr.z * cos(t_curr) * v_switch);

    // Remodulate blended chroma back to composite frequency
    // Note: filtered_uv already contains CHROMA_GAIN scaling from demodulation, don't apply again!
    float remodulated_chroma = filtered_uv.x * sin(t_curr) + filtered_uv.y * cos(t_curr) * v_switch;

    // Complementary subtraction: luma = composite - chroma
    float y_out = composite_curr - remodulated_chroma;

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
