// xBR-lv2 edge-directed upscaling, applied to the BBC's *logical* pixels.
//
// Ported from Hyllian's xbr-lv2-standalone.slang (MIT, Copyright (C) 2011-2022
// Hyllian <sergiogdb@gmail.com>), which see for the original. tests/shader runs
// this file in headless Chrome and asserts on the pixels it produces.
//
// The one thing this does that a stock xBR shader does not: jsbeeb's
// framebuffer is a 1024-wide raster in which one BBC pixel spans up to eight
// texels horizontally and two vertically. Sampling raw texel neighbours would
// find nine copies of the same pixel and do nothing at all, so every sample
// here is taken on the logical grid, whose size for each row comes from the
// lineGrid texture that Video fills in (see video-filters/pixel-grid.js).

// Texel coordinates run to 1024 and are floored to find the pixel grid, which
// mediump's ~10 bits of mantissa cannot resolve — the grid would land on the
// wrong texel and the picture would break up. XbrFilter refuses to build on
// hardware without high precision, so this shader never runs at mediump; the
// fallback is here only so it still compiles if something else includes it.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D tex; // the framebuffer
uniform sampler2D lineGrid; // one descriptor byte per framebuffer row
uniform vec2 uTextureSize; // framebuffer texture size, in texels
uniform vec2 uTexelSize; // 1.0 / uTextureSize
uniform float uTexelsPerOutputPixel; // horizontal, for the antialiasing ramp

varying vec2 uv;

// Colour distance below which two pixels count as "equal".
const float EqThreshold = 0.32;
// Used as the threshold of a step(), so larger values make the shallow 30/60
// degree rules harder to satisfy and fewer shallow edges get smoothed.
const float Lv2Coefficient = 0.3;
const float Lv2Cf = Lv2Coefficient + 2.0;

// Coefficients of the straight lines that bound each interpolation region.
const vec4 Ao = vec4(1.0, -1.0, -1.0, 1.0);
const vec4 Bo = vec4(1.0, 1.0, -1.0, -1.0);
const vec4 Co = vec4(1.5, 0.5, -0.5, 0.5);
const vec4 Ax = vec4(1.0, -1.0, -1.0, 1.0);
const vec4 Bx = vec4(0.5, 2.0, -0.5, -2.0);
const vec4 Cx = vec4(1.0, 1.0, -0.5, 0.0);
const vec4 Ay = vec4(1.0, -1.0, -1.0, 1.0);
const vec4 By = vec4(2.0, 0.5, -2.0, -0.5);
const vec4 Cy = vec4(2.0, 0.0, -1.0, 0.5);
const vec4 Ci = vec4(0.25, 0.25, 0.25, 0.25);

// BT.2020 luma weights, used to weight the per-channel colour distance.
const vec3 Y = vec3(0.2627, 0.678, 0.0593);

// Line grid descriptor bits; see video-filters/pixel-grid.js.
const float GridRendered = 128.0;
const float GridVerticalDouble = 8.0;

// Four colours held channel-wise, standing in for the reference shader's
// mat4x3. The four lanes are the same rule applied to the four rotations of
// the neighbourhood, so nearly every term is just a relabelling.
struct Lane4 {
    vec4 r;
    vec4 g;
    vec4 b;
};

Lane4 lane(vec3 x, vec3 y, vec3 z, vec3 w) {
    return Lane4(vec4(x.r, y.r, z.r, w.r), vec4(x.g, y.g, z.g, w.g), vec4(x.b, y.b, z.b, w.b));
}

/** Perceptually weighted colour distance, per lane. */
vec4 dist4(Lane4 a, Lane4 b) {
    return abs(a.r - b.r) * Y.r + abs(a.g - b.g) * Y.g + abs(a.b - b.b) * Y.b;
}

vec4 eq4(Lane4 a, Lane4 b) {
    return step(dist4(a, b), vec4(EqThreshold));
}

vec4 neq4(Lane4 a, Lane4 b) {
    return vec4(1.0) - eq4(a, b);
}

/** Distance among pixels in some direction; the 4x term dominates. */
vec4 weightedDistance(Lane4 a, Lane4 b, Lane4 c, Lane4 d, Lane4 e, Lane4 f, Lane4 g, Lane4 h) {
    return dist4(a, b) + dist4(a, c) + dist4(d, e) + dist4(d, f) + 4.0 * dist4(g, h);
}

/**
 * Pack a colour so exact equality is one comparison rather than three, matching
 * the reference shader's `v2f` trick.
 */
vec4 pack4(Lane4 a) {
    return a.r * 65536.0 + a.g * 256.0 + a.b;
}

float pack(vec3 c) {
    return c.r * 65536.0 + c.g * 256.0 + c.b;
}

/** Exact (not thresholded) inequality. */
vec4 diff4(vec4 a, vec4 b) {
    return vec4(notEqual(a, b));
}

float colourDistance(vec3 a, vec3 b) {
    return dot(abs(a - b), Y);
}

/** Pick whichever candidate is further from the centre pixel. */
vec3 furtherFrom(vec3 e, vec3 res1, vec3 res2) {
    return mix(res1, res2, step(colourDistance(e, res1), colourDistance(e, res2)));
}

void main() {
    // Absolute texel coordinates within the framebuffer.
    vec2 fbCoord = uv * uTextureSize;

    // This row's logical pixel size. The descriptor is a byte, so recover it by
    // scaling and rounding rather than trusting the sampled float directly.
    float row = floor(fbCoord.y);
    float descriptor = floor(texture2D(lineGrid, vec2((row + 0.5) * uTexelSize.x, 0.5)).r * 255.0 + 0.5);
    descriptor -= step(GridRendered, descriptor) * GridRendered;
    float verticalDouble = step(GridVerticalDouble, descriptor);
    descriptor -= verticalDouble * GridVerticalDouble;
    // What is left is the pixel's width in texels, less one.
    vec2 pixelSize = vec2(descriptor + 1.0, 1.0 + verticalDouble);

    // Everything below works in logical pixels, as a stock xBR shader would.
    vec2 logical = fbCoord / pixelSize;
    vec2 centre = floor(logical);
    vec2 fp = logical - centre;

    // Sample the centre of the first texel of each logical pixel. Every texel
    // within a logical pixel holds the same colour — the ULA writes them from
    // one table entry — so which one is arbitrary; the first avoids landing on
    // a boundary and rounding the wrong way.
    vec2 base = centre * pixelSize + 0.5;
#define AT(dx, dy) texture2D(tex, (base + vec2(dx, dy) * pixelSize) * uTexelSize).rgb

    //    A1 B1 C1
    // A0  A  B  C C4
    // D0  D  E  F F4
    // G0  G  H  I I4
    //    G5 H5 I5
    vec3 E = AT(0.0, 0.0);
    vec3 B = AT(0.0, -1.0);
    vec3 D = AT(-1.0, 0.0);
    vec3 F = AT(1.0, 0.0);
    vec3 H = AT(0.0, 1.0);

    // Level 0: the centre differs from both its right and lower neighbours,
    // i.e. there is an edge here at all. Every rule below is gated on it, so
    // where it is zero in all four rotations the answer is exactly E — and
    // most of a BBC screen is flat colour. Taking that exit early skips
    // sixteen texture fetches and the whole of the algorithm.
    //
    // Correctness rests on this being the same irlv0 the full path computes.
    // tests/shader asserts what the shader is for — flat areas untouched, hard
    // edges left hard, diagonals smoothed — so a shortcut that took this exit
    // where the algorithm would have blended shows up there.
    //
    // Returning here also puts every texture2D below inside non-uniform
    // control flow, which GLSL ES 1.0 section 8.7 leaves undefined for lookups
    // needing implicit derivatives. It is defined here only because there is
    // no level of detail to choose: XbrFilter asks for `nearestSampling`, so
    // canvas.js gives this texture NEAREST for both filters, and it has no
    // mipmaps. Move this filter back to LINEAR, or give the texture mipmaps,
    // and this shortcut stops being merely faster and starts being undefined.
    vec4 eP = vec4(pack(E));
    vec4 fP = vec4(pack(F), pack(B), pack(D), pack(H));
    vec4 hP = fP.wxyz;
    vec4 irlv0 = vec4(notEqual(eP, fP)) * vec4(notEqual(eP, hP));
    if (all(equal(irlv0, vec4(0.0)))) {
        gl_FragColor = vec4(E, 1.0);
        return;
    }

    vec3 A1 = AT(-1.0, -2.0);
    vec3 B1 = AT(0.0, -2.0);
    vec3 C1 = AT(1.0, -2.0);
    vec3 A = AT(-1.0, -1.0);
    vec3 C = AT(1.0, -1.0);
    vec3 G = AT(-1.0, 1.0);
    vec3 I = AT(1.0, 1.0);
    vec3 G5 = AT(-1.0, 2.0);
    vec3 H5 = AT(0.0, 2.0);
    vec3 I5 = AT(1.0, 2.0);
    vec3 A0 = AT(-2.0, -1.0);
    vec3 D0 = AT(-2.0, 0.0);
    vec3 G0 = AT(-2.0, 1.0);
    vec3 C4 = AT(2.0, -1.0);
    vec3 F4 = AT(2.0, 0.0);
    vec3 I4 = AT(2.0, 1.0);
#undef AT

    Lane4 b = lane(B, D, H, F);
    Lane4 c = lane(C, A, G, I);
    Lane4 d = lane(D, H, F, B);
    Lane4 e = lane(E, E, E, E);
    Lane4 f = lane(F, B, D, H);
    Lane4 g = lane(G, I, C, A);
    Lane4 h = lane(H, F, B, D);
    Lane4 i = lane(I, C, A, G);
    Lane4 i4 = lane(I4, C1, A0, G5);
    Lane4 i5 = lane(I5, C4, A1, G0);
    Lane4 h5 = lane(H5, F4, B1, D0);
    Lane4 f4 = lane(F4, B1, D0, H5);

    // Packed forms, for the exact-inequality tests. `fP` and `hP` are already in
    // hand from the early-out above, and `b` is `f` rotated, so `bP` is too —
    // packing it again would cost eight multiplies for the same bits.
    vec4 bP = fP.yzwx;
    vec4 cP = pack4(c);
    vec4 dP = bP.yzwx;
    vec4 gP = cP.zwxy;

    // These inequations define the line below which interpolation occurs.
    vec4 fx = Ao * fp.y + Bo * fp.x;
    vec4 fxL = Ax * fp.y + Bx * fp.x;
    vec4 fxU = Ay * fp.y + By * fp.x;

    // Corner detection variant C: also require the edge to be part of a longer
    // run, so isolated single pixels are not rounded away.
    vec4 eqEC = eq4(e, c);
    vec4 eqEG = eq4(e, g);
    vec4 irlv1 = clamp(
        irlv0 *
            (neq4(f, b) * neq4(f, c) + neq4(h, d) * neq4(h, g) +
                eq4(e, i) * (neq4(f, f4) * neq4(f, i4) + neq4(h, h5) * neq4(h, i5)) + eqEG + eqEC),
        0.0,
        1.0);

    // Level 2 restrictions gate the shallower 30 and 60 degree edges.
    vec4 irlv2l = diff4(eP, gP) * diff4(dP, gP);
    vec4 irlv2u = diff4(eP, cP) * diff4(bP, cP);

    // How far across the blend ramp this fragment sits, for each edge angle.
    // Two output pixels' worth of source, matching the reference's aa_factor.
    float aaFactor = 2.0 * uTexelsPerOutputPixel / pixelSize.x;
    vec4 delta = vec4(aaFactor);
    vec4 deltaL = vec4(0.5, 1.0, 0.5, 1.0) * aaFactor;
    vec4 deltaU = deltaL.yxwz;

    vec4 fx45i = clamp(0.5 + (fx - Co - Ci) / delta, 0.0, 1.0);
    vec4 fx45 = clamp(0.5 + (fx - Co) / delta, 0.0, 1.0);
    vec4 fx30 = clamp(0.5 + (fxL - Cx) / deltaL, 0.0, 1.0);
    vec4 fx60 = clamp(0.5 + (fxU - Cy) / deltaU, 0.0, 1.0);

    // Which way does the edge run? wd1 small means the main diagonal through E,
    // wd2 small means the anti-diagonal.
    vec4 wd1 = weightedDistance(e, c, g, i, h5, f4, h, f);
    vec4 wd2 = weightedDistance(h, d, i5, f, i4, b, e, i);

    vec4 dFG = dist4(f, g);
    vec4 dHC = dist4(h, c);

    vec4 edri = step(wd1, wd2) * irlv0;
    vec4 edr = vec4(lessThan(wd1, wd2)) * irlv1 * (vec4(1.0) - edri.yzwx * edri.wxyz);
    vec4 edrL = step(Lv2Cf * dFG, dHC) * irlv2l * edr * ((vec4(1.0) - edri.yzwx) * eqEC);
    vec4 edrU = step(Lv2Cf * dHC, dFG) * irlv2u * edr * ((vec4(1.0) - edri.wxyz) * eqEG);

    fx45i *= edri;
    fx45 *= edr;
    fx30 *= edrL;
    fx60 *= edrU;

    // Of the two pixels either side of the edge, blend towards the nearer one.
    vec4 px = step(dist4(e, f), dist4(e, h));

    vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));

    vec3 resA = furtherFrom(E, mix(E, mix(H, F, px.x), maximos.x), mix(E, mix(B, D, px.z), maximos.z));
    vec3 resB = furtherFrom(E, mix(E, mix(F, B, px.y), maximos.y), mix(E, mix(D, H, px.w), maximos.w));

    gl_FragColor = vec4(furtherFrom(E, resA, resB), 1.0);
}
