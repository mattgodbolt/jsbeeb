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
// 3. Demodulate previous line (2H for interlaced, same field) → U_prev, V_prev
// 4. Blend at baseband: U_final = mix(U_curr, U_prev), V_final = mix(V_curr, V_prev)
// 5. Remodulate blended chroma back to composite frequency
// 6. Extract luma via complementary subtraction: Y = composite - remodulated_chroma
// 7. Combine luma and chroma, convert back to RGB
//
// NOTE: Uses 2H delay (line-2) not 1H (line-1) because jsbeeb simulates interlacing by
// rendering only odd or even lines per frame. A real PAL TV's 1H delay line would contain
// the previous scanline from the SAME field, which is 2 texture lines apart.
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

// Chroma amplitude: Set to 1.0 as scaling is now baked into the YUV matrix
// The properly scaled matrix (from ITU-R BT.470-6) ensures signals stay within spec
const float CHROMA_GAIN = 1.0;

// Chroma demodulation gain: compensates for sin²(x) = 0.5 - 0.5·cos(2x) amplitude loss
const float FIR_GAIN = 2.0;

// Chroma vertical blending weight (0.0 = no blend, 0.5 = equal blend)
const float CHROMA_BLEND_WEIGHT = 0.5;

// 21-tap FIR low-pass filter coefficients for chroma bandwidth limiting
// Cutoff: 2.217 MHz (half subcarrier), sample rate: 16 MHz
// Generated for proper PAL chroma filtering with symmetric response
const int FIRTAPS = 21;

// RGB → YUV conversion with proper PAL signal levels baked in
// Derived from ITU-R BT.470-6: white at 0.7V, peak at 0.931V
// Matrix ensures RGB(1,1,1) → YUV(0.7,0,0) and worst case (yellow) peaks at 0.931V
vec3 rgb_to_yuv(vec3 rgb) {
    return vec3(
        0.2093 * rgb.r + 0.4109 * rgb.g + 0.0798 * rgb.b,
        -0.102228 * rgb.r - 0.200704 * rgb.g + 0.302939 * rgb.b,
        0.427311 * rgb.r - 0.357823 * rgb.g - 0.069488 * rgb.b
    );
}

// YUV → RGB inverse matrix
vec3 yuv_to_rgb(vec3 yuv) {
    return vec3(
        1.42857143 * yuv.x - 0.0000193387 * yuv.y + 1.64048673 * yuv.z,
        1.42857711 * yuv.x - 0.567986687 * yuv.y - 0.83560997 * yuv.z,
        1.42854218 * yuv.x + 2.92468392 * yuv.y - 0.0000217418 * yuv.z
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
    // 21-tap symmetric filter, cutoff 2.217 MHz @ 16 MHz sample rate
    float FIR[21];
    FIR[0] = 0.000427769337; FIR[1] = 0.00231068052; FIR[2] = 0.00344911363; FIR[3] = -0.00203420476;
    FIR[4] = -0.0168416192; FIR[5] = -0.0301975906; FIR[6] = -0.0173992619; FIR[7] = 0.0424187581;
    FIR[8] = 0.141605897; FIR[9] = 0.237531717; FIR[10] = 0.277457482; FIR[11] = 0.237531717;
    FIR[12] = 0.141605897; FIR[13] = 0.0424187581; FIR[14] = -0.0173992619; FIR[15] = -0.0301975906;
    FIR[16] = -0.0168416192; FIR[17] = -0.00203420476; FIR[18] = 0.00344911363; FIR[19] = 0.00231068052;
    FIR[20] = 0.000427769337;

    float line = floor(vPixelCoord.y);

    // PAL phase alternates each scanline (V component inverts)
    float v_switch = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // PAL subcarrier: 4.43MHz × 64μs = 283.75 cycles/line
    // BBC Micro maps this across 1024 pixels (896 visible + 128 blanking)
    const float cycles_per_pixel = 283.75 / 1024.0;

    // PAL temporal phase (8-field sequence creates animated dot crawl)
    // Correct: 0.7516 cycles/line (not 0.75)
    // Per field: 312.5 lines × 0.7516 ≈ 234.875 cycles
    // 8 fields = 1 complete cycle (234.875 × 8 ≈ 1879)
    float line_phase_offset = line * 0.7516;
    float frame_phase_offset = uFrameCount * 234.875;  // Assumes 312.5 lines/field
    float phase_offset = line_phase_offset + frame_phase_offset;

    // Approach D: Baseband Chroma Blending
    // Demodulate current and previous lines separately, then blend at baseband

    // Step 1: Demodulate current line with FIR filter
    vec2 filtered_uv_curr = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
        vec2 uv = demodulate_uv(vTexCoord, offset, v_switch, cycles_per_pixel, phase_offset);
        filtered_uv_curr += FIR_GAIN * uv * FIR[i];
    }

    // Step 2: Demodulate previous line (2H for interlaced, same field) with FIR filter
    // In interlaced mode, only odd OR even lines are rendered per frame.
    // Using 2H (line-2) ensures we sample from the same field (both fresh data).
    // This represents the TV's 1H delay within a single field.
    vec2 prev_uv = vTexCoord - vec2(0.0, 2.0 * uTexelSize.y);
    float prev_line = line - 2.0;
    float prev_v_switch = mod(prev_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float prev_phase_offset = prev_line * 0.7516 + frame_phase_offset;

    vec2 filtered_uv_prev = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
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
