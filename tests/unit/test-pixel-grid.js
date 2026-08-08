import { describe, it, expect } from "vitest";
import { texelsPerPixel, encodeLineGrid } from "../../src/video-filters/pixel-grid.js";
import { decodeLineGrid, LineGridRendered, LineGridVerticalDouble, LineGridWidthMask } from "../line-grid.js";

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

    it("refuses a width it cannot describe rather than lying about it", () => {
        expect(() => encodeLineGrid(9, false)).toThrow(/cannot be described/);
        expect(() => encodeLineGrid(0, false)).toThrow(/cannot be described/);
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
