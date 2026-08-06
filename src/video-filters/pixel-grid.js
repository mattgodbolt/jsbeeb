"use strict";

// Describing the logical pixel grid of jsbeeb's framebuffer, which is a
// 1024-wide *raster* rather than a grid of BBC pixels: one logical pixel covers
// up to eight texels across and two down. Filters need to know that, and only
// the video chips do, so they record one descriptor byte per row and this
// module owns the encoding.
//
// See docs/xbr-display-mode.md for why an upscaler that samples raw texels
// achieves nothing at all.

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
    // A width of 9 would set the doubling bit and read back as a doubled width
    // of 1 — a silent lie rather than an error. The widths come from mode-table
    // arithmetic, so check.
    if (texelsWide < 1 || texelsWide > LineGridWidthMask + 1)
        throw new Error(`Logical pixel width ${texelsWide} cannot be described in a line grid descriptor`);
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
 * is routine — so there is no one logical grid for the whole screen. This finds
 * the runs that do share one, which is how the integration tests check a real
 * screen's recorded grid against the pixels the modes actually wrote.
 *
 * The shader itself has no need of this: it reads each row's own descriptor.
 * That is also why it has no notion of a seam, and reads a neighbouring mode's
 * texels at the wrong stride for a row or two at a mode change.
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
