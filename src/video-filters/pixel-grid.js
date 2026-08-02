"use strict";

// Recovering the logical pixel grid from jsbeeb's framebuffer.
//
// The framebuffer is a 1024-wide *raster*, not a grid of BBC pixels. One
// logical pixel covers several framebuffer texels:
//
//   * horizontally, `Video.blitFb` writes `pixelsPerChar` texels per byte, so a
//     logical pixel is 1, 2, 4 or 8 texels wide depending on the ULA's colour
//     bits — one texel in MODE 0, two in MODE 1, four in MODE 2 and MODE 5;
//   * vertically, non-interlaced modes write each CRTC scanline into two
//     adjacent framebuffer rows (`doubledLines`), so logical pixels are two
//     texels tall.
//
// The Atom's 6847 has its own geometry and records the same descriptor from its
// own blitters.
//
// Any upscaler that samples raw texel neighbours therefore sees nine copies of
// the same logical pixel and does nothing at all. Filters need the grid, and
// only Video knows it — so Video records it per row, and this module turns that
// record into something a filter can use.

/**
 * Rows in the line grid. The framebuffer is 625 rows, but the GL texture it is
 * uploaded into is 1024 square, and the shader indexes the grid with the same
 * coordinate it uses for the picture — so the two must agree.
 */
export const LineGridRows = 1024;

// Row descriptor bits, as stored in `Video.lineGrid`. The width is held less
// one, so it needs no logarithm to write and no exponential to read, and any
// width from one to eight can be described — the 6847 uses widths the BBC's ULA
// never selects.
export const LineGridRendered = 0x80;
export const LineGridVerticalDouble = 0x08;
export const LineGridWidthMask = 0x07;

/**
 * How many framebuffer texels wide one logical pixel is, given the ULA's
 * colour-select bits. The ULA writes 8 pixels per byte at `ulaMode` 3 and
 * halves the count for each step down, which `Video.table4bpp` implements by
 * indexing its 1bpp entries with `i >> (3 - ulaMode)`. This holds for the 1MHz
 * modes too: `pixelsPerChar` is 16 there rather than 8, and the same shift over
 * twice as many texels gives the same width — MODE 4 is two, MODE 5 is four.
 *
 * @param {number} ulaMode 0..3, the ULA control register's colour bits
 * @returns {number} 1, 2, 4 or 8; the standard modes use 1, 2 and 4
 */
export function texelsPerPixel(ulaMode) {
    return 8 >> ulaMode;
}

/**
 * Pack a row's grid description into the byte the video chips store.
 *
 * @param {number} texelsWide 1 to 8 (see {@link texelsPerPixel})
 * @param {boolean} doubledLines whether this scanline was written to two rows
 */
export function encodeLineGrid(texelsWide, doubledLines) {
    return LineGridRendered | (texelsWide - 1) | (doubledLines ? LineGridVerticalDouble : 0);
}

/**
 * Unpack a row descriptor.
 *
 * @param {number} encoded a byte from Video's `lineGrid`
 * @returns {{rendered: boolean, texelsWide: number, texelsHigh: number}}
 */
export function decodeLineGrid(encoded) {
    return {
        rendered: (encoded & LineGridRendered) !== 0,
        texelsWide: (encoded & LineGridWidthMask) + 1,
        texelsHigh: encoded & LineGridVerticalDouble ? 2 : 1,
    };
}

/**
 * Split a frame into horizontal bands of constant logical pixel size.
 *
 * A single frame can mix modes — a MODE 7 status line above a MODE 1 playfield
 * is routine — so there is no one logical grid for the whole screen. Each band
 * is upscaled independently; the only cost is that the filter cannot see across
 * a mode change, which is where the picture is discontinuous anyway.
 *
 * Note the GLSL filter has no bands: it reads each row's own descriptor and
 * samples its vertical neighbours at that row's stride, so at a seam it reads
 * the neighbouring mode's texels at the wrong one. The two implementations
 * therefore differ for a row or two at a mode change, and tools/verify-xbr-
 * shader.js does not compare multi-band frames for that reason.
 *
 * @param {Uint8Array} lineGrid one descriptor byte per framebuffer row
 * @param {number} top first row to consider
 * @param {number} bottom one past the last row to consider
 * @returns {Array<{top: number, bottom: number, texelsWide: number, texelsHigh: number}>}
 *     bands covering every *rendered* row between `top` and `bottom`
 */
export function findBands(lineGrid, top, bottom) {
    const bands = [];
    let current = null;
    let currentEncoded = 0;
    for (let y = top; y < bottom; ++y) {
        const encoded = lineGrid[y];
        if (!(encoded & LineGridRendered)) {
            current = null;
        } else if (current && encoded === currentEncoded) {
            current.bottom = y + 1;
        } else {
            const { texelsWide, texelsHigh } = decodeLineGrid(encoded);
            current = { top: y, bottom: y + 1, texelsWide, texelsHigh };
            currentEncoded = encoded;
            bands.push(current);
        }
    }
    return bands;
}

/**
 * Extract a band of the framebuffer as an image of logical pixels, by taking
 * one texel from the middle of each logical pixel.
 *
 * The band's height is rounded down to a whole number of logical pixels; a band
 * whose height is not a multiple of `texelsHigh` (which happens when a mode
 * change lands mid-character-row) loses its last raster row rather than
 * inventing a half-height pixel.
 *
 * Logical pixels are anchored to the framebuffer's own origin rather than to
 * `left`: character cells begin at whole multiples of their width, so column
 * zero is a pixel boundary in every mode. `left` is snapped back to the nearest
 * boundary at or before it and returned, so callers can map the result to the
 * screen. The GLSL filter anchors the same way, which is what lets the two be
 * compared against each other.
 *
 * @param {Uint32Array} fb32 the 1024-wide framebuffer
 * @param {number} fbWidth framebuffer stride in texels
 * @param {{top: number, bottom: number, texelsWide: number, texelsHigh: number}} band
 * @param {number} left first texel column of the visible area
 * @param {number} right one past the last visible texel column
 * @returns {{width: number, height: number, data: Uint32Array, left: number}}
 */
export function extractBand(fb32, fbWidth, band, left, right) {
    const { texelsWide, texelsHigh } = band;
    const alignedLeft = left - (left % texelsWide);
    const width = Math.floor((right - alignedLeft) / texelsWide);
    const height = Math.floor((band.bottom - band.top) / texelsHigh);
    const data = new Uint32Array(width * height);
    // Every texel of a logical pixel holds the same colour — the ULA writes
    // them all from one table entry — so any of them will do. Take the first,
    // as the shader does, so the two implementations agree exactly.
    for (let y = 0; y < height; ++y) {
        const srcRow = (band.top + y * texelsHigh) * fbWidth;
        for (let x = 0; x < width; ++x) {
            data[y * width + x] = fb32[srcRow + alignedLeft + x * texelsWide];
        }
    }
    return { width, height, data, left: alignedLeft };
}
