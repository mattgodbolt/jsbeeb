precision highp float;

varying vec2 vTexCoord;

uniform sampler2D uFramebuffer;
uniform vec2 uResolution;
uniform vec2 uTexelSize;
// Line number of texture rows 0 (x) and 1 (y); row r is line uLineBase[r & 1] + (r >> 1).
uniform vec2 uLineBase;

const float PI = 3.14159265359;

// IMPLEMENTATION (Baseband Blending Method):
// 1. Encode RGB to PAL composite: Y + U*sin(ωt) + V*cos(ωt)*v_switch
// 2. Demodulate current line (with correct phase) → U_curr, V_curr
// 3. Demodulate previous line (2H for interlaced, same field) → U_prev, V_prev
// 4. Blend at baseband: U_final = mix(U_curr, U_prev), V_final = mix(V_curr, V_prev)
// 5. Remodulate blended chroma back to composite frequency
// 6. Extract luma via complementary subtraction: Y = composite - remodulated_chroma
// 7. Combine luma and chroma, convert back to RGB
//
// NOTE: Texture rows are half-lines, so the previous scanline of the same field is two rows
// up, and the subcarrier phase and V-switch come from uLineBase, not from the row.

// Chroma demodulation gain: compensates for sin²(x) = 0.5 - 0.5·cos(2x) amplitude loss
const float FIR_GAIN = 2.0;

// Chroma vertical blending weight (0.0 = no blend, 0.5 = equal blend)
const float CHROMA_BLEND_WEIGHT = 0.5;

// PAL standard base parameters
const float PAL_TOTAL_LINES = 625.0;         // Total scanlines per frame
const float PAL_FRAME_RATE = 25.0;           // Frames per second
const float PAL_SUBCARRIER_MHZ = 4.43361875; // PAL color subcarrier frequency (exact)

// Derived PAL parameters
const float PAL_CYCLES_PER_LINE = PAL_SUBCARRIER_MHZ * 1e6 / (PAL_TOTAL_LINES * PAL_FRAME_RATE);
// fract(PAL_CYCLES_PER_LINE), as a literal so a float holds it to 1e-8 rather than the 1e-5 it
// keeps at 283; it is multiplied by line numbers up to 2813.
const float PAL_LINE_PHASE_OFFSET = 0.7516;

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
vec2 demodulate_uv(vec2 xy, float pixel_x, float offset_pixels, float v_switch, float cycles_per_pixel, float phase_offset) {
    float t = ((pixel_x + offset_pixels) * cycles_per_pixel + phase_offset) * 2.0 * PI;

    vec2 sample_uv = xy + vec2(offset_pixels * uTexelSize.x, 0.0);
    vec3 rgb = texture2D(uFramebuffer, sample_uv).rgb;
    vec3 yuv = rgb_to_yuv(rgb);

    // Encode to composite: Y + U*sin(ωt) + V*cos(ωt)*v_switch
    float composite = yuv.x + yuv.y * sin(t) + yuv.z * cos(t) * v_switch;

    // Demodulate: multiply by carrier to shift chroma to baseband
    return vec2(composite * sin(t), composite * cos(t) * v_switch);
}

void main() {
    // Texel column and row, whatever size the drawing buffer is.
    vec2 pixelCoord = floor(vTexCoord * uResolution);

    // BEGIN_FIR_COEFFICIENTS
    // This section is replaced by the Vite build to include FIR filter coefficients.
    // Change Cutoff (in comment below) or FIRTAPS value to configure.
    // Cutoff: 1.108 MHz (quarter subcarrier)
    const int FIRTAPS = 21;
    float FIR[FIRTAPS];
    // END_FIR_COEFFICIENTS

    float row = pixelCoord.y;
    float line = (mod(row, 2.0) < 1.0 ? uLineBase.x : uLineBase.y) + floor(row / 2.0);

    // PAL phase alternates each scanline (V component inverts)
    float v_switch = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;

    // Map PAL subcarrier across the full line, blanking included
    float cycles_per_pixel = PAL_CYCLES_PER_LINE / uResolution.x;

    // Subcarrier phase at the start of this line, carried across frames by the line count
    float phase_offset = fract(line * PAL_LINE_PHASE_OFFSET);

    // Step 1: Demodulate current line with FIR filter
    vec2 filtered_uv_curr = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
        vec2 uv = demodulate_uv(vTexCoord, pixelCoord.x, offset, v_switch, cycles_per_pixel, phase_offset);
        filtered_uv_curr += FIR_GAIN * uv * FIR[i];
    }

    // Step 2: Demodulate the previous scanline of the same field (two rows up, one line
    // earlier) with FIR filter. This represents the TV's 1H delay line.
    vec2 prev_uv = vTexCoord - vec2(0.0, 2.0 * uTexelSize.y);
    float prev_v_switch = -v_switch;
    float prev_phase_offset = fract((line - 1.0) * PAL_LINE_PHASE_OFFSET);

    vec2 filtered_uv_prev = vec2(0.0);
    for (int i = 0; i < FIRTAPS; i++) {
        float offset = float(i - (FIRTAPS - 1) / 2);
        vec2 uv = demodulate_uv(prev_uv, pixelCoord.x, offset, prev_v_switch, cycles_per_pixel, prev_phase_offset);
        filtered_uv_prev += FIR_GAIN * uv * FIR[i];
    }

    // Step 3: Blend chroma at baseband
    vec2 filtered_uv = mix(filtered_uv_curr, filtered_uv_prev, CHROMA_BLEND_WEIGHT);

    // Step 4: Get luma via complementary subtraction
    float t_curr = (pixelCoord.x * cycles_per_pixel + phase_offset) * 2.0 * PI;
    vec3 rgb_curr = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv_curr = rgb_to_yuv(rgb_curr);
    float composite_curr = yuv_curr.x + yuv_curr.y * sin(t_curr) + yuv_curr.z * cos(t_curr) * v_switch;

    // Remodulate blended chroma back to composite frequency
    float remodulated_chroma = filtered_uv.x * sin(t_curr) + filtered_uv.y * cos(t_curr) * v_switch;

    // Complementary subtraction: luma = composite - chroma
    float y_out = composite_curr - remodulated_chroma;

    vec3 rgb_out = yuv_to_rgb(vec3(y_out, filtered_uv.x, filtered_uv.y));
    gl_FragColor = vec4(clamp(rgb_out, 0.0, 1.0), 1.0);
}
