import { describe, it, expect } from "vitest";
import {
    texelsPerPixel,
    encodeLineGrid,
    decodeLineGrid,
    findBands,
    extractBand,
    LineGridRendered,
    LineGridVerticalDouble,
    LineGridWidthMask,
} from "../../src/video-filters/pixel-grid.js";

describe("logical pixel grid", () => {
    describe("texelsPerPixel", () => {
        it("gives one texel per pixel for the ULA's 8-pixels-per-byte mode", () => {
            // ulaMode 3 is what MODE 0 selects: 8 pixels in an 8-texel cell.
            expect(texelsPerPixel(3)).toBe(1);
        });

        it("widens by a factor of two for each colour bit added", () => {
            expect(texelsPerPixel(2)).toBe(2); // MODE 1, 4 pixels per byte
            expect(texelsPerPixel(1)).toBe(4); // MODE 2, 2 pixels per byte
            expect(texelsPerPixel(0)).toBe(8);
        });
    });

    describe("encode and decode", () => {
        it("round-trips every combination", () => {
            for (const texelsWide of [1, 2, 3, 4, 5, 6, 7, 8]) {
                for (const doubled of [false, true]) {
                    const decoded = decodeLineGrid(encodeLineGrid(texelsWide, doubled));
                    expect(decoded).toEqual({
                        rendered: true,
                        texelsWide,
                        texelsHigh: doubled ? 2 : 1,
                    });
                }
            }
        });

        it("reports an unwritten row as not rendered", () => {
            expect(decodeLineGrid(0).rendered).toBe(false);
        });
    });

    describe("findBands", () => {
        const grid = (rows) => {
            const array = new Uint8Array(64);
            rows.forEach(([from, to, value]) => array.fill(value, from, to));
            return array;
        };

        it("returns one band for a screen in a single mode", () => {
            const lineGrid = grid([[10, 40, encodeLineGrid(2, true)]]);
            expect(findBands(lineGrid, 0, 64)).toEqual([{ top: 10, bottom: 40, texelsWide: 2, texelsHigh: 2 }]);
        });

        it("splits at a mode change", () => {
            const lineGrid = grid([
                [0, 20, encodeLineGrid(1, true)], // MODE 7 header
                [20, 50, encodeLineGrid(4, true)], // MODE 2 playfield
            ]);
            expect(findBands(lineGrid, 0, 50)).toEqual([
                { top: 0, bottom: 20, texelsWide: 1, texelsHigh: 2 },
                { top: 20, bottom: 50, texelsWide: 4, texelsHigh: 2 },
            ]);
        });

        it("breaks a band where rows were never rendered", () => {
            const lineGrid = grid([
                [0, 10, encodeLineGrid(2, true)],
                [20, 30, encodeLineGrid(2, true)],
            ]);
            const bands = findBands(lineGrid, 0, 40);
            expect(bands).toHaveLength(2);
            expect(bands.map((b) => [b.top, b.bottom])).toEqual([
                [0, 10],
                [20, 30],
            ]);
        });

        it("ignores rows outside the requested range", () => {
            const lineGrid = grid([[0, 64, encodeLineGrid(1, false)]]);
            expect(findBands(lineGrid, 5, 9)).toEqual([{ top: 5, bottom: 9, texelsWide: 1, texelsHigh: 1 }]);
        });

        it("finds nothing in a blank frame", () => {
            expect(findBands(new Uint8Array(64), 0, 64)).toEqual([]);
        });
    });

    describe("extractBand", () => {
        const FbWidth = 16;

        /** Build a framebuffer where every logical pixel has a distinct value. */
        function rasterise(pixels, texelsWide, texelsHigh, top) {
            const fb32 = new Uint32Array(FbWidth * 32);
            pixels.forEach((row, y) => {
                row.forEach((value, x) => {
                    for (let dy = 0; dy < texelsHigh; ++dy) {
                        for (let dx = 0; dx < texelsWide; ++dx) {
                            fb32[(top + y * texelsHigh + dy) * FbWidth + x * texelsWide + dx] = value;
                        }
                    }
                });
            });
            return fb32;
        }

        it("recovers the logical pixels from a 4x2 texel grid", () => {
            const pixels = [
                [11, 12, 13],
                [21, 22, 23],
            ];
            const fb32 = rasterise(pixels, 4, 2, 6);
            const band = { top: 6, bottom: 10, texelsWide: 4, texelsHigh: 2 };
            const image = extractBand(fb32, FbWidth, band, 0, 12);
            expect(image.width).toBe(3);
            expect(image.height).toBe(2);
            expect([...image.data]).toEqual([11, 12, 13, 21, 22, 23]);
        });

        it("is the identity when a logical pixel is a single texel", () => {
            const pixels = [[1, 2, 3, 4]];
            const fb32 = rasterise(pixels, 1, 1, 0);
            const image = extractBand(fb32, FbWidth, { top: 0, bottom: 1, texelsWide: 1, texelsHigh: 1 }, 0, 4);
            expect([...image.data]).toEqual([1, 2, 3, 4]);
        });

        it("rounds down rather than inventing a partial pixel", () => {
            const fb32 = rasterise([[1, 2]], 4, 2, 0);
            // Ask for 11 texels of a 4-texel grid and 3 rows of a 2-row grid.
            const image = extractBand(fb32, FbWidth, { top: 0, bottom: 3, texelsWide: 4, texelsHigh: 2 }, 0, 11);
            expect(image.width).toBe(2);
            expect(image.height).toBe(1);
        });

        it("anchors the grid to the framebuffer origin, not to the crop", () => {
            // Character cells start at whole multiples of their width, so an
            // arbitrary crop must be snapped back or every pixel is misread —
            // and the GLSL filter, which has no crop, would disagree.
            const fb32 = rasterise([[1, 2, 3]], 4, 1, 0);
            const image = extractBand(fb32, FbWidth, { top: 0, bottom: 1, texelsWide: 4, texelsHigh: 1 }, 6, 12);
            expect(image.left).toBe(4);
            expect([...image.data]).toEqual([2, 3]);
        });
    });

    it("describes any width the video chips can produce", () => {
        // The BBC's ULA only ever selects powers of two, but the Atom's 6847
        // has its own geometry, so the field must not assume a power of two.
        expect(LineGridWidthMask + 1).toBeGreaterThanOrEqual(8);
        for (let texelsWide = 1; texelsWide <= 8; ++texelsWide) {
            expect(decodeLineGrid(encodeLineGrid(texelsWide, true)).texelsWide).toBe(texelsWide);
        }
    });

    it("keeps the width, doubling and rendered fields out of each other's way", () => {
        const encoded = encodeLineGrid(8, true);
        expect(encoded & LineGridWidthMask).toBe(7);
        expect(encoded & LineGridVerticalDouble).toBe(LineGridVerticalDouble);
        expect(encoded & LineGridRendered).toBe(LineGridRendered);
        // A width of 8 must not bleed into the doubling bit.
        expect(decodeLineGrid(encodeLineGrid(8, false)).texelsHigh).toBe(1);
    });
});
