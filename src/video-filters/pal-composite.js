"use strict";

// PAL Composite Video Filter
//
// Simulates PAL composite video artifacts by encoding the framebuffer to a
// composite signal and decoding it back to RGB, mimicking the behavior of
// connecting a BBC Micro to a PAL television via composite cable.
//
// REFERENCES:
// - John Watkinson's "Engineer's Guide to Decoding & Encoding" (particularly Section 3.4)
// - https://www.jim-easterbrook.me.uk/pal/ - Jim Easterbrook's PAL decoder research
//
// CURRENT APPROACH:
// - Encode RGB to composite signal (Y + U*sin(ωt) + V*cos(ωt)*phase)
// - Demodulate chroma with 20-tap FIR low-pass filter (~1.3 MHz bandwidth)
// - Apply FIR_GAIN = 2.0 to compensate for demodulation amplitude loss
// - Extract luma via notch filter: subtract re-modulated chroma from composite
// - Proper PAL 4-field temporal phase sequence (283.75 cycles/line)
//
// APPROACHES TRIED:
// 1. Notch filter for luma (svofski/CRT approach):
//    - Subtract FIR-filtered chroma from composite to extract luma
//    - ORIGINAL ASSESSMENT: Wide FIR filter (20 taps) reached across color transitions,
//      creating premature artifacts ~10 pixels before edges
//    - RE-TESTED: Super sharp, NO premature edge artifacts observed!
//    - Initial problem: Checkerboard (chroma leaking into luma)
//    - ROOT CAUSE FOUND: FIR_GAIN = 1.0 was wrong! Should be 2.0 to compensate for
//      demodulation amplitude loss (sin²(x) = 0.5 - 0.5·cos(2x) identity)
//    - FIXED: Set FIR_GAIN = 2.0, checkerboard gone, sharp, good saturation
//    - This approach WORKS correctly with proper gain compensation!
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
// 4. 1H (1-line) comb filter spacing (NTSC-style):
//    - Used line N and line N-1 with 0.75 cycle (270°) phase difference
//    - PROBLEM: 270° phase shift causes U/V rotation, not cancellation
//    - Result: Checkerboard artifacts on solid colors due to U/V mixing
//    - FIXED by switching to 2H (2-line) spacing per Watkinson's guide
//
// 5. 3-tap bandpass comb with complementary luma subtraction:
//    - Used -0.25, +0.5, -0.25 coefficients for "bandpass" chroma extraction
//    - Subtracted chroma from current line to get luma (complementary decoder)
//    - PROBLEM CONFIRMED: Complementary subtraction negates the negative coefficients:
//      y_out = composite_curr - (-0.25*prev + 0.5*curr - 0.25*next)
//            = 0.25*prev + 0.5*curr + 0.25*next  // Reduces to standard lowpass!
//    - Test A verified: Explicit lowpass produces IDENTICAL blur (toggled multiple times)
//    - Result: Luma averaged across 4 scanlines, excessive blur vs authentic PAL TVs
//    - Good chroma separation but unacceptable vertical resolution loss
//    - ABANDONED: Complementary approach doesn't work as intended with 3-tap comb
//
// 6. Various 2-tap comb filter weights (CURRENT TESTING):
//    - Test E: No filtering (y = yuv_curr.x) - TOO sharp, missing PAL artifacts, unrealistic
//    - Test B: 50/50 average (0.5*prev + 0.5*curr) - Still too blurry
//    - Test B weighted: 25/75 (0.25*prev + 0.75*curr) - Better sharpness, subtle artifacts
//    - PROBLEM: As we reduce blur (favor current line), checkerboard increases
//    - CONCERN: Tuning weights may be papering over a fundamental bug
//    - INVESTIGATING: Why does blur reduction increase checkerboard artifacts?
//
// CURRENT STATUS:
// - Using notch filter for luma extraction (working correctly with FIR_GAIN = 2.0)
// - Sharp image, no checkerboard artifacts
// - Good color saturation
// - Temporal dot crawl animates correctly across 4-frame sequence
// - Ready to revisit comb filter approaches with correct gain to compare

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

// Chroma filter gain parameter
// CRITICAL: Must be 2.0 to compensate for demodulation amplitude loss!
// When we demodulate with sin/cos, the baseband signal has 0.5x amplitude
// due to sin²(x) = 0.5 - 0.5·cos(2x). We must scale by 2 to recover original.
// Without this, we only remove HALF the chroma from luma → checkerboard artifacts!
const float FIR_GAIN = 2.0;

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

    // Extract luma using COMPLEMENTARY DECODER approach (Watkinson Fig 3.4.2b).
    //
    // BANDPASS COMB FILTER extracts CHROMA:
    // PAL requires 2-line (2H) spacing. The key insight from Watkinson is that the
    // comb filter coefficients should be NEGATIVE on the outer taps: -0.25, +0.5, -0.25
    //
    // This creates a BANDPASS filter (not lowpass!) that:
    // - Extracts frequencies around subcarrier (chroma)
    // - Rejects low frequencies (luma) and high frequencies
    // - Maintains 180° phase cancellation (2H spacing = 1.5 cycles = 180°)
    //
    // COMPLEMENTARY LUMA EXTRACTION:
    // Once we have clean chroma from the bandpass comb, we get luma by subtraction:
    //   luma = composite - chroma
    // This is the "complementary decoder" principle (also used in BBC transform decoder).
    //
    // Benefits:
    // - Luma is NOT averaged across lines → preserves full vertical resolution (sharp!)
    // - Chroma properly extracted with 2H spacing → no checkerboard
    // - No blur because luma comes from current line only
    //
    // Phase relationships (for chroma extraction):
    // - Line N-2: phase offset = -1.5 cycles = 180° from N
    // - Line N: reference phase
    // - Line N+2: phase offset = +1.5 cycles = 180° from N
    // V-switch is SAME on all three lines (2-line spacing → same V-switch state)

    // Current scanline (line N) - center of comb filter
    float t_curr = (vPixelCoord.x * cycles_per_pixel + phase_offset) * 2.0 * PI;
    vec3 rgb_curr = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv_curr = rgb_to_yuv(rgb_curr);
    float composite_curr = yuv_curr.x + yuv_curr.y * sin(t_curr) + yuv_curr.z * cos(t_curr) * pal_phase;

    // Scanline two lines up (line N-2)
    // Phase difference: -1.5 cycles = 180° (chroma inverts)
    vec2 prev_uv = vTexCoord - vec2(0.0, 2.0 * uTexelSize.y);
    float prev_line = line - 2.0;
    float prev_pal_phase = mod(prev_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float prev_line_phase_offset = prev_line * 0.75;
    float prev_phase_offset = prev_line_phase_offset + frame_phase_offset;
    float t_prev = (vPixelCoord.x * cycles_per_pixel + prev_phase_offset) * 2.0 * PI;
    vec3 rgb_prev = texture2D(uFramebuffer, prev_uv).rgb;
    vec3 yuv_prev = rgb_to_yuv(rgb_prev);
    float composite_prev = yuv_prev.x + yuv_prev.y * sin(t_prev) + yuv_prev.z * cos(t_prev) * prev_pal_phase;

    // Scanline two lines down (line N+2)
    // Phase difference: +1.5 cycles = 180° (chroma inverts)
    vec2 next_uv = vTexCoord + vec2(0.0, 2.0 * uTexelSize.y);
    float next_line = line + 2.0;
    float next_pal_phase = mod(next_line, 2.0) < 1.0 ? 1.0 : -1.0;
    float next_line_phase_offset = next_line * 0.75;
    float next_phase_offset = next_line_phase_offset + frame_phase_offset;
    float t_next = (vPixelCoord.x * cycles_per_pixel + next_phase_offset) * 2.0 * PI;
    vec3 rgb_next = texture2D(uFramebuffer, next_uv).rgb;
    vec3 yuv_next = rgb_to_yuv(rgb_next);
    float composite_next = yuv_next.x + yuv_next.y * sin(t_next) + yuv_next.z * cos(t_next) * next_pal_phase;

    // RE-TEST: svofski notch filter approach (approach #1, previously abandoned)
    // Extract luma by subtracting re-modulated filtered chroma from composite.
    // This was abandoned due to premature artifacts ~10 pixels before edges,
    // but re-testing to confirm and document so we don't loop back to this.
    // (t_curr already defined at line 204)
    float remodulated_chroma = filtered_uv.x * sin(t_curr) + filtered_uv.y * cos(t_curr) * pal_phase;
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
