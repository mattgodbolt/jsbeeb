// Proof-of-concept PAL composite video simulation
// Single-pass shader that shows basic PAL artifacts

precision mediump float;

varying vec2 vTexCoord;
varying vec2 vPixelCoord;

uniform sampler2D uFramebuffer;
uniform vec2 uTexelSize;

const float PI = 3.14159265359;

// RGB → YUV (ITU-R BT.470-2 PAL)
vec3 rgb_to_yuv(vec3 rgb) {
    return vec3(
        0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b,
        -0.147 * rgb.r - 0.289 * rgb.g + 0.436 * rgb.b,
        0.615 * rgb.r - 0.515 * rgb.g - 0.100 * rgb.b
    );
}

// YUV → RGB
vec3 yuv_to_rgb(vec3 yuv) {
    return vec3(
        yuv.x + 1.140 * yuv.z,
        yuv.x - 0.394 * yuv.y - 0.581 * yuv.z,
        yuv.x + 2.028 * yuv.y
    );
}

void main() {
    float line = floor(vPixelCoord.y);

    // Sample current pixel
    vec3 rgb = texture2D(uFramebuffer, vTexCoord).rgb;
    vec3 yuv = rgb_to_yuv(rgb);

    // Simple comb filter simulation: average with previous scanline
    vec3 rgb_prev = texture2D(uFramebuffer, vTexCoord - vec2(0.0, uTexelSize.y)).rgb;
    vec3 yuv_prev = rgb_to_yuv(rgb_prev);

    // PAL phase alternates each line
    float phase = mod(line, 2.0) < 1.0 ? 1.0 : -1.0;
    float phase_prev = -phase;

    // Simulate chroma crosstalk (simplified dot crawl)
    // On PAL, the phase alternation causes the characteristic pattern
    vec3 yuv_decoded = yuv;
    yuv_decoded.y = (yuv.y * phase + yuv_prev.y * phase_prev) * 0.5;
    yuv_decoded.z = (yuv.z * phase + yuv_prev.z * phase_prev) * 0.5;

    // Add some chroma bleed by blurring the chroma horizontally
    vec3 yuv_left = rgb_to_yuv(texture2D(uFramebuffer, vTexCoord - vec2(uTexelSize.x, 0.0)).rgb);
    vec3 yuv_right = rgb_to_yuv(texture2D(uFramebuffer, vTexCoord + vec2(uTexelSize.x, 0.0)).rgb);

    yuv_decoded.y = (yuv_decoded.y + yuv_left.y + yuv_right.y) * 0.33;
    yuv_decoded.z = (yuv_decoded.z + yuv_left.z + yuv_right.z) * 0.33;

    vec3 rgb_out = yuv_to_rgb(yuv_decoded);

    gl_FragColor = vec4(clamp(rgb_out, 0.0, 1.0), 1.0);
}
