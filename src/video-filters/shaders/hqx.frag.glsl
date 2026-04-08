// HQx upscaling filter for jsbeeb
//
// Implements the hq2x pixel-art scaling algorithm by Maxim Stepin, adapted
// for WebGL 1.0 / GLSL ES 1.00.
//
// For each output fragment we determine which quadrant of the virtual 2x2
// output block it falls in (top-left / top-right / bottom-left / bottom-right)
// and apply the appropriate blend from the 3x3 neighbourhood:
//
//   A B C
//   D E F      (E = centre texel)
//   G H I
//
// Blending rules for each corner (illustrated for top-left, others mirror):
//   • D~E and B~E          → blend2(E, D, B)   [soft area merge]
//   • only D~E             → blend3_1(E, D)
//   • only B~E             → blend3_1(E, B)
//   • neither, but A~B~D   → blend3_1(E, A)    [diagonal anti-alias]
//   • neither              → E                  [hard corner preserved]
//
// Colour comparison uses the YUV (ITU-R BT.601) perceptual difference to
// avoid blending across hue boundaries that appear similar in raw RGB.
//
// REFERENCES:
//   - Original hq2x C source by Maxim Stepin (2003)
//   - https://en.wikipedia.org/wiki/Hqx
//   - libretro common-shaders hq2x.cg

precision mediump float;

uniform sampler2D tex;
uniform vec2 uTexelSize;

varying vec2 uv;

// ── Colour-difference ────────────────────────────────────────────────────────

// Thresholds in normalised YUV space (0-1 range)
const float T_Y = 0.20; // luma
const float T_U = 0.20; // blue-difference chroma
const float T_V = 0.20; // red-difference chroma

vec3 rgb2yuv(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713);
}

bool colorsDiffer(vec3 a, vec3 b) {
    vec3 d = abs(rgb2yuv(a) - rgb2yuv(b));
    return d.x > T_Y || d.y > T_U || d.z > T_V;
}

// ── Blend helpers ─────────────────────────────────────────────────────────────

// 3:1 blend — main pixel 75 %, minor 25 %
vec3 blend3_1(vec3 main, vec3 minor) {
    return main * 0.75 + minor * 0.25;
}

// 2:1:1 blend — main 50 %, two minors 25 % each
vec3 blend2(vec3 main, vec3 b, vec3 c) {
    return main * 0.5 + b * 0.25 + c * 0.25;
}

// ── Per-corner blend ─────────────────────────────────────────────────────────

// Compute the output colour for one corner of the 2×2 block.
//   centre  — the E pixel
//   orth1   — first orthogonal neighbour  (e.g. D for TL corner)
//   orth2   — second orthogonal neighbour (e.g. B for TL corner)
//   diag    — diagonal neighbour          (e.g. A for TL corner)
vec3 cornerBlend(vec3 centre, vec3 orth1, vec3 orth2, vec3 diag) {
    bool o1 = !colorsDiffer(centre, orth1);
    bool o2 = !colorsDiffer(centre, orth2);

    if (o1 && o2) {
        // Both orthogonal neighbours match — blend the corner area
        return blend2(centre, orth1, orth2);
    } else if (o1) {
        return blend3_1(centre, orth1);
    } else if (o2) {
        return blend3_1(centre, orth2);
    } else {
        // Neither orthogonal matches — check for diagonal anti-alias:
        // if orth1, orth2, and diag all agree with each other (they form the
        // "other side" of a diagonal edge), soften the concave staircase corner.
        if (!colorsDiffer(diag, orth1) && !colorsDiffer(diag, orth2)) {
            return blend3_1(centre, diag);
        }
        return centre;
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

void main() {
    // Convert UV to a floating-point texel coordinate.
    vec2 pixelPos = uv / uTexelSize;

    // Snap to the centre of the nearest source texel.
    vec2 texelIdx = floor(pixelPos);
    vec2 subpix = pixelPos - texelIdx; // 0.0 – 1.0 within the texel

    vec2 cUv = (texelIdx + 0.5) * uTexelSize;

    // Sample 3×3 neighbourhood at exact texel centres.
    vec3 A = texture2D(tex, cUv + vec2(-1.0, -1.0) * uTexelSize).rgb;
    vec3 B = texture2D(tex, cUv + vec2( 0.0, -1.0) * uTexelSize).rgb;
    vec3 C = texture2D(tex, cUv + vec2( 1.0, -1.0) * uTexelSize).rgb;
    vec3 D = texture2D(tex, cUv + vec2(-1.0,  0.0) * uTexelSize).rgb;
    vec3 E = texture2D(tex, cUv).rgb;
    vec3 F = texture2D(tex, cUv + vec2( 1.0,  0.0) * uTexelSize).rgb;
    vec3 G = texture2D(tex, cUv + vec2(-1.0,  1.0) * uTexelSize).rgb;
    vec3 H = texture2D(tex, cUv + vec2( 0.0,  1.0) * uTexelSize).rgb;
    vec3 I = texture2D(tex, cUv + vec2( 1.0,  1.0) * uTexelSize).rgb;

    // Compute all four corner blends and bilinearly interpolate using the
    // sub-pixel position.  Using a pure quadrant select would always land in
    // one corner at 1:1 scale (subpix = 0.5 exactly) and would miss the
    // diagonal anti-aliasing for three out of four cases.  Bilinear
    // interpolation between all four corners gives symmetric coverage at
    // every scale.
    vec3 tlBlend = cornerBlend(E, D, B, A); // top-left
    vec3 trBlend = cornerBlend(E, F, B, C); // top-right
    vec3 blBlend = cornerBlend(E, D, H, G); // bottom-left
    vec3 brBlend = cornerBlend(E, F, H, I); // bottom-right

    vec3 topMix = mix(tlBlend, trBlend, subpix.x);
    vec3 botMix = mix(blBlend, brBlend, subpix.x);
    vec3 result = mix(topMix, botMix, subpix.y);

    gl_FragColor = vec4(result, 1.0);
}
