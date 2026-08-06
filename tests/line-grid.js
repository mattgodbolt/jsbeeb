"use strict";

export const LineGridRendered = 0x80;
export const LineGridVerticalDouble = 0x08;
export const LineGridWidthMask = 0x07;

export function decodeLineGrid(encoded) {
    return {
        rendered: (encoded & LineGridRendered) !== 0,
        texelsWide: (encoded & LineGridWidthMask) + 1,
        texelsHigh: encoded & LineGridVerticalDouble ? 2 : 1,
    };
}

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
