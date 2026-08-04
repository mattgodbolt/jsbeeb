"use strict";

// xBR-lv2: an edge-directed upscaler for pixel art.
//
// Ported to JavaScript from Hyllian's reference shader
// `edge-smoothing/xbr/shaders/xbr-lv2-standalone.slang` in libretro's
// slang-shaders, Copyright (C) 2011-2022 Hyllian <sergiogdb@gmail.com>,
// MIT licensed, incorporating ideas from Joshua Street's SABR shader.
//
// The port is deliberately literal so it can be diffed against the shader and
// mirrored back into GLSL: variable names, the four-lane rotation scheme and
// the order of operations all follow the original. A shader `vec4` becomes a
// four-element array — one lane per 90 degree rotation of the same rule — and a
// `mat4x3` becomes a four-element array of [r, g, b] triples.
//
// Note the older `xbr/shaders/xbr-lv2.glsl` in libretro's glsl-shaders repo
// declares `f4` and never assigns it; use this (standalone slang) version as
// the reference, not that one.

/** Colour distance below which two pixels count as "equal". */
const EqThreshold = 0.32;
/** Larger values let the shallow 30/60 degree rules fire more readily. */
const Lv2Cf = 0.3 + 2.0;

// Coefficients of the straight lines that bound each interpolation region.
// A/B give the line's gradient in (fp.x, fp.y); C is its offset.
const Ao = [1.0, -1.0, -1.0, 1.0];
const Bo = [1.0, 1.0, -1.0, -1.0];
const Co = [1.5, 0.5, -0.5, 0.5];
const Ax = [1.0, -1.0, -1.0, 1.0];
const Bx = [0.5, 2.0, -0.5, -2.0];
const Cx = [1.0, 1.0, -0.5, 0.0];
const Ay = [1.0, -1.0, -1.0, 1.0];
const By = [2.0, 0.5, -2.0, -0.5];
const Cy = [2.0, 0.0, -1.0, 0.5];
const Ci = [0.25, 0.25, 0.25, 0.25];

// BT.2020 luma weights, used to weight the per-channel colour distance.
const LumaWeights = [0.2627, 0.678, 0.0593];

// Lane rotations. The four lanes are the same rule applied to the four
// rotations of the neighbourhood, so most terms are just a relabelling.
const yzwx = (a) => [a[1], a[2], a[3], a[0]];
const zwxy = (a) => [a[2], a[3], a[0], a[1]];
const wxyz = (a) => [a[3], a[0], a[1], a[2]];

const mul4 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
const add4 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const sub4 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
const scale4 = (a, s) => [a[0] * s, a[1] * s, a[2] * s, a[3] * s];
const divide4 = (a, b) => [a[0] / b[0], a[1] / b[1], a[2] / b[2], a[3] / b[3]];
const max4 = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const saturate1 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const saturate4 = (a) => [saturate1(a[0]), saturate1(a[1]), saturate1(a[2]), saturate1(a[3])];

/** GLSL `step(a, b)`: 1 where b >= a. */
const lte4 = (a, b) => [a[0] <= b[0] ? 1 : 0, a[1] <= b[1] ? 1 : 0, a[2] <= b[2] ? 1 : 0, a[3] <= b[3] ? 1 : 0];
const lt4 = (a, b) => [a[0] < b[0] ? 1 : 0, a[1] < b[1] ? 1 : 0, a[2] < b[2] ? 1 : 0, a[3] < b[3] ? 1 : 0];
/** Logical inverse; only meaningful for arrays of 0.0/1.0. */
const not4 = (a) => [1 - a[0], 1 - a[1], 1 - a[2], 1 - a[3]];
/** Exact (not thresholded) inequality, used on the packed colour codes. */
const diff4 = (a, b) => [a[0] !== b[0] ? 1 : 0, a[1] !== b[1] ? 1 : 0, a[2] !== b[2] ? 1 : 0, a[3] !== b[3] ? 1 : 0];

/**
 * Pack a colour into a single number so that exact equality tests are one
 * comparison rather than three (the shader's `v2f` trick).
 */
const packColour = (c) => c[0] * 65536 + c[1] * 256 + c[2];
const pack4 = (m) => [packColour(m[0]), packColour(m[1]), packColour(m[2]), packColour(m[3])];

const colourDistance = (a, b) =>
    Math.abs(a[0] - b[0]) * LumaWeights[0] +
    Math.abs(a[1] - b[1]) * LumaWeights[1] +
    Math.abs(a[2] - b[2]) * LumaWeights[2];

const dist4 = (A, B) => [
    colourDistance(A[0], B[0]),
    colourDistance(A[1], B[1]),
    colourDistance(A[2], B[2]),
    colourDistance(A[3], B[3]),
];

const eq4 = (A, B) => lte4(dist4(A, B), [EqThreshold, EqThreshold, EqThreshold, EqThreshold]);
const neq4 = (A, B) => not4(eq4(A, B));

/** Distance among pixels in some direction; the 4x term dominates. */
const weightedDistance = (a, b, c, d, e, f, g, h) =>
    add4(add4(add4(dist4(a, b), dist4(a, c)), add4(dist4(d, e), dist4(d, f))), scale4(dist4(g, h), 4.0));

const mixColour = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Pick whichever of two candidate colours is further from the centre pixel.
 * The shader spells this `mix(res1, res2, step(dist(E, res1), dist(E, res2)))`.
 */
const furtherFrom = (E, res1, res2) => (colourDistance(E, res1) <= colourDistance(E, res2) ? res2 : res1);

/**
 * A source image of logical pixels.
 * @typedef {Object} PixelImage
 * @property {number} width
 * @property {number} height
 * @property {Uint32Array} data packed 0xAABBGGRR words, as jsbeeb's framebuffer
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Compute the colour for one output pixel.
 *
 * @param {function(number, number): number[]} at samples the neighbourhood,
 *     `at(dx, dy)` returning [r, g, b] in 0..1 relative to the centre pixel
 * @param {number} fpx sub-pixel x position within the centre pixel, 0..1
 * @param {number} fpy sub-pixel y position within the centre pixel, 0..1
 * @param {Object} params carries `aaFactor`
 * @returns {number[]} the output colour as [r, g, b] in 0..1
 */
function xbrPixel(at, fpx, fpy, params) {
    const { aaFactor } = params;

    //    A1 B1 C1
    // A0  A  B  C C4
    // D0  D  E  F F4
    // G0  G  H  I I4
    //    G5 H5 I5
    const A1 = at(-1, -2);
    const B1 = at(0, -2);
    const C1 = at(1, -2);
    const A = at(-1, -1);
    const B = at(0, -1);
    const C = at(1, -1);
    const D = at(-1, 0);
    const E = at(0, 0);
    const F = at(1, 0);
    const G = at(-1, 1);
    const H = at(0, 1);
    const I = at(1, 1);
    const G5 = at(-1, 2);
    const H5 = at(0, 2);
    const I5 = at(1, 2);
    const A0 = at(-2, -1);
    const D0 = at(-2, 0);
    const G0 = at(-2, 1);
    const C4 = at(2, -1);
    const F4 = at(2, 0);
    const I4 = at(2, 1);

    // The four lanes: each is the same neighbourhood rotated 90 degrees.
    const b = [B, D, H, F];
    const c = [C, A, G, I];
    const d = [D, H, F, B];
    const e = [E, E, E, E];
    const f = [F, B, D, H];
    const g = [G, I, C, A];
    const h = [H, F, B, D];
    const i = [I, C, A, G];
    const i4 = [I4, C1, A0, G5];
    const i5 = [I5, C4, A1, G0];
    const h5 = [H5, F4, B1, D0];
    const f4 = [F4, B1, D0, H5];

    // Packed forms, for the exact-inequality tests.
    const bP = pack4(b);
    const cP = pack4(c);
    const dP = yzwx(bP);
    const eP = pack4(e);
    const fP = wxyz(bP);
    const gP = zwxy(cP);
    const hP = zwxy(bP);

    // These inequations define the line below which interpolation occurs.
    const fx = add4(scale4(Ao, fpy), scale4(Bo, fpx));
    const fxL = add4(scale4(Ax, fpy), scale4(Bx, fpx));
    const fxU = add4(scale4(Ay, fpy), scale4(By, fpx));

    // Interpolation restrictions: level 0 is "the centre differs from both its
    // right and lower neighbours", i.e. there is an edge here at all.
    const irlv0 = mul4(diff4(eP, fP), diff4(eP, hP));

    // Corner detection variant C: also require the edge to be part of a longer
    // run, so isolated single pixels are left alone.
    const irlv1 = saturate4(
        mul4(
            irlv0,
            add4(
                add4(mul4(neq4(f, b), neq4(f, c)), mul4(neq4(h, d), neq4(h, g))),
                add4(
                    mul4(eq4(e, i), add4(mul4(neq4(f, f4), neq4(f, i4)), mul4(neq4(h, h5), neq4(h, i5)))),
                    add4(eq4(e, g), eq4(e, c)),
                ),
            ),
        ),
    );

    // Level 2 restrictions gate the shallower 30 and 60 degree edges.
    const irlv2l = mul4(diff4(eP, gP), diff4(dP, gP));
    const irlv2u = mul4(diff4(eP, cP), diff4(bP, cP));

    // How far across the blend ramp this fragment sits, for each edge angle.
    const delta = [aaFactor, aaFactor, aaFactor, aaFactor];
    const deltaL = [0.5 * aaFactor, aaFactor, 0.5 * aaFactor, aaFactor];
    const deltaU = [deltaL[1], deltaL[0], deltaL[3], deltaL[2]];
    const ramp = (value, offset, widths) => saturate4(add4([0.5, 0.5, 0.5, 0.5], divide4(sub4(value, offset), widths)));
    let fx45i = ramp(fx, add4(Co, Ci), delta);
    let fx45 = ramp(fx, Co, delta);
    let fx30 = ramp(fxL, Cx, deltaL);
    let fx60 = ramp(fxU, Cy, deltaU);

    // Which way does the edge run? wd1 small means the edge is the main
    // diagonal through E, wd2 small means it is the anti-diagonal.
    const wd1 = weightedDistance(e, c, g, i, h5, f4, h, f);
    const wd2 = weightedDistance(h, d, i5, f, i4, b, e, i);

    const dFG = dist4(f, g);
    const dHC = dist4(h, c);

    const edri = mul4(lte4(wd1, wd2), irlv0);
    const edr = mul4(mul4(lt4(wd1, wd2), irlv1), not4(mul4(yzwx(edri), wxyz(edri))));
    const edrL = mul4(mul4(mul4(lte4(scale4(dFG, Lv2Cf), dHC), irlv2l), edr), mul4(not4(yzwx(edri)), eq4(e, c)));
    const edrU = mul4(mul4(mul4(lte4(scale4(dHC, Lv2Cf), dFG), irlv2u), edr), mul4(not4(wxyz(edri)), eq4(e, g)));

    fx45i = mul4(edri, fx45i);
    fx45 = mul4(edr, fx45);
    fx30 = mul4(edrL, fx30);
    fx60 = mul4(edrU, fx60);

    // Of the two pixels either side of the edge, blend towards the nearer one.
    const px = lte4(dist4(e, f), dist4(e, h));

    const maximos = max4(max4(fx30, fx60), max4(fx45, fx45i));

    const resA = furtherFrom(
        E,
        mixColour(E, mixColour(H, F, px[0]), maximos[0]),
        mixColour(E, mixColour(B, D, px[2]), maximos[2]),
    );
    const resB = furtherFrom(
        E,
        mixColour(E, mixColour(F, B, px[1]), maximos[1]),
        mixColour(E, mixColour(D, H, px[3]), maximos[3]),
    );
    return furtherFrom(E, resA, resB);
}

/**
 * Upscale `src` into `dest` using xBR-lv2. The two may be any sizes; the
 * algorithm works per output pixel, so non-integer and anisotropic scale
 * factors are fine (which matters here, as BBC pixels are not square).
 *
 * @param {PixelImage} src
 * @param {PixelImage} dest modified in place
 */
export function xbrUpscale(src, dest) {
    const params = {
        // Width of the antialiasing ramp, in units of a source pixel: two
        // output pixels' worth, matching the shader's `aa_factor`.
        aaFactor: (2.0 * src.width) / dest.width,
    };

    const srcData = src.data;
    const srcWidth = src.width;
    const srcHeight = src.height;

    // One scratch triple per neighbourhood position, reused for every output
    // pixel: this runs tens of millions of times over a full frame.
    const scratch = [];
    for (let n = 0; n < 21; ++n) scratch.push([0, 0, 0]);

    for (let oy = 0; oy < dest.height; ++oy) {
        const sy = ((oy + 0.5) / dest.height) * srcHeight;
        const cy = Math.floor(sy);
        const fpy = sy - cy;
        for (let ox = 0; ox < dest.width; ++ox) {
            const sx = ((ox + 0.5) / dest.width) * srcWidth;
            const cx = Math.floor(sx);
            const fpx = sx - cx;

            let scratchIndex = 0;
            const at = (dx, dy) => {
                const word = srcData[clamp(cy + dy, 0, srcHeight - 1) * srcWidth + clamp(cx + dx, 0, srcWidth - 1)];
                const out = scratch[scratchIndex++];
                out[0] = (word & 0xff) / 255;
                out[1] = ((word >>> 8) & 0xff) / 255;
                out[2] = ((word >>> 16) & 0xff) / 255;
                return out;
            };

            const [r, g, bl] = xbrPixel(at, fpx, fpy, params);
            dest.data[oy * dest.width + ox] =
                (0xff << 24) |
                (Math.round(saturate1(bl) * 255) << 16) |
                (Math.round(saturate1(g) * 255) << 8) |
                Math.round(saturate1(r) * 255);
        }
    }
    return dest;
}

/** Allocate a {@link PixelImage} of the given size. */
export function makePixelImage(width, height) {
    return { width, height, data: new Uint32Array(width * height) };
}
