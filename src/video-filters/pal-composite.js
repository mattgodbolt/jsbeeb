"use strict";

// PAL Composite Video Filter
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// connecting a BBC Micro to a PAL television via composite cable.
//
// CURRENT APPROACH:
// - Encode RGB to composite signal (Y + U*sin(ωt) + V*cos(ωt)*phase)
// - Demodulate chroma with 20-tap FIR low-pass filter (~1.3 MHz bandwidth)
// - Extract luma via 2-line comb filter (authentic to real PAL decoders)
// - Proper PAL 4-field temporal phase sequence (283.75 cycles/line)
//
// APPROACHES TRIED:
// 1. Notch filter for luma (svofski/CRT approach):
//    - Subtract FIR-filtered chroma from composite to extract luma
//    - PROBLEM: Wide FIR filter (20 taps) reached across color transitions,
//      creating premature artifacts ~10 pixels before edges
//    - ABANDONED in favor of comb filter
//
// 2. Comb filter without temporal phase:
//    - Average current and previous scanlines to cancel chroma
//    - PROBLEM: Heavy vertical striping because we didn't account for the
//      0.75 cycle phase offset between lines
//    - FIXED by adding proper line_phase_offset calculation
//
// 3. Various horizontal bandwidth limiting attempts:
//    - Tried filtering composite signal horizontally
//    - ABANDONED as unnecessary once comb filter phase was fixed
//
// CURRENT STATUS:
// - Working well with authentic PAL artifacts
// - Slight checkerboard pattern visible in solid colors (may be authentic)
// - Temporal dot crawl animates correctly across 4-frame sequence
//
// KNOWN ISSUES:
// - Slight checkerboard pattern visible in solid colors (may be authentic PAL behavior)

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
uniform float uFrameCount;  // For PAL 4-field temporal phase sequence

const float PI = 3.14159265359;

// Chroma filter gain parameter for empirical adjustment
// Controls color saturation - increase for more saturated colors
const float FIR_GAIN = 1.0;

// 20-tap FIR low-pass filter coefficients for chroma bandwidth limiting (~1.3 MHz)
// Copied from svofski/CRT (glsl/shaders/singlepass/pass1.fsh:24)
// Note: Array must be initialized element-by-element (GLSL ES 1.00 doesn't support constructors)
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

// Demodulate composite signal at given offset to extract U/V components
// This is the core of PAL decoding: multiply composite by carrier to shift chroma to baseband
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
    // Initialize FIR filter coefficients
    // (GLSL ES 1.00 doesn't support array constructors, so we initialize element-by-element)
    float FIR[20];
    FIR[0] = -0.008030271; FIR[1] = 0.003107906; FIR[2] = 0.016841352; FIR[3] = 0.032545161;
    FIR[4] = 0.049360136; FIR[5] = 0.066256720; FIR[6] = 0.082120150; FIR[7] = 0.095848433;
    FIR[8] = 0.106453014; FIR[9] = 0.113151423; FIR[10] = 0.115441842; FIR[11] = 0.113151423;
    FIR[12] = 0.106453014; FIR[13] = 0.095848433; FIR[14] = 0.082120150; FIR[15] = 0.066256720;
    FIR[16] = 0.049360136; FIR[17] = 0.032545161; FIR[18] = 0.016841352; FIR[19] = 0.003107906;

    float line = floor(vPixelCoord.y);

    // PAL phase alternates each scanline (V component inverts)
    float pal_phase = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // PAL subcarrier frequency and phase calculation:
    // BBC Micro CRTC register R0 = 127 (128 character clocks per scanline)
    // Character clock = 2 MHz (to fit PAL timing: 128 * 0.5μs = 64μs)
    // Total scanline time = 64 μs (includes displayed + blanking)
    // PAL subcarrier = 4.43361875 MHz
    // Subcarrier cycles per scanline = 64μs × 4.43MHz ≈ 283.75 cycles
    //
    // Our 1024-pixel texture represents the FULL scanline (not just active video):
    // - 896 visible pixels = displayed region (~40μs)
    // - 128 border pixels = blanking periods (~24μs)
    //
    // The subcarrier runs continuously through the entire scanline, so we must
    // map all 283.75 cycles across the full 1024 pixels to maintain correct phase.
    const float cycles_per_pixel = 283.75 / 1024.0;  // ≈ 0.277 cycles/pixel

    // PAL TEMPORAL PHASE (4-field sequence for dot crawl):
    // The fractional 0.75 cycles causes phase accumulation:
    // - Vertically: each line starts 0.75 cycles ahead of the previous (mod 4)
    // - Frame-to-frame: 625 lines × 0.75 = 468.75 cycles offset per frame
    // - Complete cycle: 4 frames (4 × 0.75 = 3.0 integer cycles)
    //
    // This creates the animated "dot crawl" and color fringing patterns.
    float line_phase_offset = line * 0.75;  // Vertical accumulation
    float frame_phase_offset = uFrameCount * 468.75;  // Temporal cycling (modulo 4 frames)

    // Demodulate composite at multiple sample points, then apply FIR filter.
    // This matches real PAL decoder behavior: demod first, then low-pass filter.
    // (Contrast with our previous approach which averaged composite then demodulated)
    float phase_offset = line_phase_offset + frame_phase_offset;
    vec2 filtered_uv = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - FIRTAPS / 2);
        vec2 uv = demodulate_uv(vTexCoord, offset, pal_phase, cycles_per_pixel, phase_offset);
        filtered_uv += FIR_GAIN * uv * FIR[i];
    }

    // Extract luma using COMB FILTER approach.
    //
    // COMB FILTER (what real PAL TVs used):
    // Real PAL decoders separate luma from chroma by "subtracting the signal from
    // itself, delayed by a line and a bit" (the "bit" is the 0.75 cycle phase offset).
    //
    // How it works:
    // - Sample current scanline and encode to composite
    // - Sample previous scanline (one line up) and encode to composite
    // - The phase difference between lines is 0.75 cycles (270°) due to 283.75 cycles/line
    // - Average the two signals: chroma cancels (opposite phases), luma adds
    //
    // This is more authentic than the notch filter approach (svofski/CRT), which had
    // edge artifacts from the wide FIR filter reaching across color transitions.

    // Current scanline with phase for this line
    float t_curr = (vPixelCoord.x * cycles_per_pixel + phase_offset) * 2.0 * PI;
    vec3 rgb_curr = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv_curr = rgb_to_yuv(rgb_curr);
    float composite_curr = yuv_curr.x + yuv_curr.y * sin(t_curr) + yuv_curr.z * cos(t_curr) * pal_phase;

    // Previous scanline (one line up) with phase for previous line
    // The line_phase_offset automatically gives us the correct phase difference:
    // Current line N: phase = N × 0.75 + frame_offset
    // Previous line N-1: phase = (N-1) × 0.75 + frame_offset = N × 0.75 - 0.75 + frame_offset
    // Difference: 0.75 cycles = 270° - the "bit" in "delayed by a line and a bit"
    vec2 prev_uv = vTexCoord - vec2(0.0, uTexelSize.y);
    float prev_line = line - 1.0;
    float prev_pal_phase = mod(prev_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float prev_line_phase_offset = prev_line * 0.75;
    float prev_phase_offset = prev_line_phase_offset + frame_phase_offset;
    float t_prev = (vPixelCoord.x * cycles_per_pixel + prev_phase_offset) * 2.0 * PI;
    vec3 rgb_prev = texture2D(uFramebuffer, prev_uv).rgb;
    vec3 yuv_prev = rgb_to_yuv(rgb_prev);
    float composite_prev = yuv_prev.x + yuv_prev.y * sin(t_prev) + yuv_prev.z * cos(t_prev) * prev_pal_phase;

    // Comb filter: average current and previous scanlines
    // Chroma cancels (opposite phases due to PAL alternation + 0.75 offset), luma adds
    float y_out = (composite_curr + composite_prev) * 0.5;

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
