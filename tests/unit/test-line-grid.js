import { describe, it, expect } from "vitest";
import { findBands } from "../line-grid.js";
import { encodeLineGrid } from "../../src/video-filters/pixel-grid.js";

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
