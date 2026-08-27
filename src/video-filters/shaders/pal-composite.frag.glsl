precision highp float;

varying vec2 vTexCoord;

uniform sampler2D uFramebuffer;
uniform vec2 uResolution;
uniform vec2 uTexelSize;
uniform float uFrameCount;

const float PI = 3.14159265359;

// IMPLEMENTATION (Baseband Blending Method):
// 1. Encode RGB to PAL composite: Y + U*sin(ωt) + V*cos(ωt)*v_switch
// 2. Demodulate current line (with correct phase) → U_curr, V_curr
// 3. Demodulate previous line (2H for interlaced, same field) → U_prev, V_prev
// 4. Blend at baseband: U_final = mix(U_curr, U_prev), V_final = mix(V_curr, V_prev)
// 5. Remodulate blended chroma back to composite frequency
// 6. Extract luma via complementary subtraction: Y = composite - remodulated_chroma
//    (optionally low-passed to the TV's luma bandwidth, with a subcarrier notch)
// 7. Combine luma and chroma, convert back to RGB
//
// NOTE: Uses 2H delay (line-2) not 1H (line-1) because jsbeeb simulates interlacing by
// rendering only odd or even lines per frame. A real PAL TV's 1H delay line would contain
// the previous scanline from the SAME field, which is 2 texture lines apart. Proper
// support for non-interlaced modes needs to be added.

// Chroma demodulation gain: compensates for sin²(x) = 0.5 - 0.5·cos(2x) amplitude loss
const float FIR_GAIN = 2.0;

// Chroma vertical blending weight (0.0 = no blend, 0.5 = equal blend)
const float CHROMA_BLEND_WEIGHT = 0.5;

// PAL standard base parameters
const float PAL_TOTAL_LINES = 625.0;         // Total scanlines per frame
const float PAL_FRAME_RATE = 25.0;           // Frames per second
const float PAL_SUBCARRIER_MHZ = 4.43361875; // PAL color subcarrier frequency (exact)

// Derived PAL parameters
const float PAL_LINES_PER_FIELD = PAL_TOTAL_LINES / 2.0;
const float PAL_CYCLES_PER_LINE = PAL_SUBCARRIER_MHZ * 1e6 / (PAL_TOTAL_LINES * PAL_FRAME_RATE);
const float PAL_LINE_PHASE_OFFSET = fract(PAL_CYCLES_PER_LINE);
const float PAL_FIELD_PHASE_OFFSET = PAL_LINE_PHASE_OFFSET * PAL_LINES_PER_FIELD;

// jsbeeb texture parameters
const float TEXTURE_WIDTH = 1024.0;          // Framebuffer width (896 visible + 128 blanking)

// Luma bandwidth limit: a symmetric FIR across neighbouring texels, designed on the JS side.
// uLumaFilter is 0 for the unfiltered path, 1 to apply uLumaFir.
const int LUMA_TAPS = 15;
uniform float uLumaFilter;
uniform float uLumaFir[LUMA_TAPS];

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

// Subcarrier phase (radians) at offset_pixels from pixel_x
float carrier_phase(float pixel_x, float offset_pixels, float cycles_per_pixel, float phase_offset) {
    return ((pixel_x + offset_pixels) * cycles_per_pixel + phase_offset) * 2.0 * PI;
}

// Encode the texel at offset_pixels from xy to composite: Y + U*sin(ωt) + V*cos(ωt)*v_switch
float encode_composite(vec2 xy, float offset_pixels, float t, float v_switch) {
    vec2 sample_uv = xy + vec2(offset_pixels * uTexelSize.x, 0.0);
    vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
    vec3 yuv = rgb_to_yuv(rgb);
    return yuv.x + yuv.y * sin(t) + yuv.z * cos(t) * v_switch;
}

float remodulate_chroma(vec2 uv, float t, float v_switch) {
    return uv.x * sin(t) + uv.y * cos(t) * v_switch;
}

// Demodulate composite signal at given position
vec2 demodulate_uv(vec2 xy, float pixel_x, float offset_pixels, float v_switch, float cycles_per_pixel, float phase_offset) {
    float t = carrier_phase(pixel_x, offset_pixels, cycles_per_pixel, phase_offset);
    float composite = encode_composite(xy, offset_pixels, t, v_switch);

    // Demodulate: multiply by carrier to shift chroma to baseband
    return vec2(composite * sin(t), composite * cos(t) * v_switch);
}

void main() {
    // Use gl_FragCoord for pixel coordinates - it's hardware-provided and avoids interpolation artifacts
    vec2 pixelCoord = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);

    // BEGIN_FIR_COEFFICIENTS
    // This section is replaced by the Vite build to include FIR filter coefficients.
    // Change Cutoff (in comment below) or FIRTAPS value to configure.
    // Cutoff: 1.108 MHz (quarter subcarrier; the -6 dB design point, -3 dB at about 0.83 MHz)
    const int FIRTAPS = 21;
    float FIR[FIRTAPS];
    // END_FIR_COEFFICIENTS

    float line = floor(pixelCoord.y);

    // PAL phase alternates each scanline (V component inverts)
    float v_switch = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // Map PAL subcarrier across texture width
    float cycles_per_pixel = PAL_CYCLES_PER_LINE / TEXTURE_WIDTH;

    // PAL temporal phase (8-field sequence creates animated dot crawl)
    float line_phase_offset = line * PAL_LINE_PHASE_OFFSET;
    float frame_phase_offset = uFrameCount * PAL_FIELD_PHASE_OFFSET;
    float phase_offset = line_phase_offset + frame_phase_offset;

    // Step 1: Demodulate current line with FIR filter
    vec2 filtered_uv_curr = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
        vec2 uv = demodulate_uv(vTexCoord, pixelCoord.x, offset, v_switch, cycles_per_pixel, phase_offset);
        filtered_uv_curr += FIR_GAIN * uv * FIR[i];
    }

    // Step 2: Demodulate previous line (2H for interlaced, same field) with FIR filter
    // In interlaced mode, only odd OR even lines are rendered per frame.
    // Using 2H (line-2) ensures we sample from the same field (both fresh data).
    // This represents the TV's 1H delay within a single field.
    vec2 prev_uv = vTexCoord - vec2(0.0, 2.0 * uTexelSize.y);
    float prev_line = line - 2.0;
    float prev_v_switch = v_switch * -1.0;
    float prev_phase_offset = prev_line * PAL_LINE_PHASE_OFFSET + frame_phase_offset;

    vec2 filtered_uv_prev = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
        vec2 uv = demodulate_uv(prev_uv, pixelCoord.x, offset, prev_v_switch, cycles_per_pixel, prev_phase_offset);
        filtered_uv_prev += FIR_GAIN * uv * FIR[i];
    }

    // Step 3: Blend chroma at baseband
    vec2 filtered_uv = mix(filtered_uv_curr, filtered_uv_prev, CHROMA_BLEND_WEIGHT);

    // Step 4: Get luma via complementary subtraction, luma = composite - remodulated blended chroma.
    // The bandwidth limit repeats the subtraction at neighbouring texels, each at its own carrier
    // phase but sharing this texel's blended chroma, which varies too slowly to matter over 15 taps.
    float y_out;
    if (uLumaFilter > 0.5) {
        y_out = 0.0;
        for (int i = 0; i < LUMA_TAPS; i++) {
            float offset = float(i - (LUMA_TAPS - 1) / 2);
            float t = carrier_phase(pixelCoord.x, offset, cycles_per_pixel, phase_offset);
            float composite = encode_composite(vTexCoord, offset, t, v_switch);
            y_out += (composite - remodulate_chroma(filtered_uv, t, v_switch)) * uLumaFir[i];
        }
    } else {
        float t_curr = carrier_phase(pixelCoord.x, 0.0, cycles_per_pixel, phase_offset);
        float composite_curr = encode_composite(vTexCoord, 0.0, t_curr, v_switch);
        y_out = composite_curr - remodulate_chroma(filtered_uv, t_curr, v_switch);
    }

    vec3 rgb_out = yuv_to_rgb(vec3(y_out, filtered_uv.x, filtered_uv.y));
    gl_FragColor = vec4(clamp(rgb_out, 0.0, 1.0), 1.0);
}
