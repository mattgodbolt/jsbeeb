import { describe, expect, it } from "vitest";

import { powerOfTwoColumnsThatFit, rowsThatFit } from "../../src/web/debug-dom.js";

describe("rowsThatFit", () => {
    it("counts whole rows, rounding down", () => {
        expect(rowsThatFit(256, 16)).toBe(16);
        expect(rowsThatFit(250, 16)).toBe(15);
    });

    it("counts a row that layout rounding has left a fraction of a pixel short", () => {
        expect(rowsThatFit(256 - 1 / 60, 16)).toBe(16);
    });

    it("keeps one row however little room there is", () => {
        expect(rowsThatFit(3, 16)).toBe(1);
    });
});

describe("powerOfTwoColumnsThatFit", () => {
    it.each([
        [10, 8],
        [16 * 4 + 20 - 1, 8],
        [16 * 4 + 20 - 1 / 60, 16],
        [32 * 4 + 20, 32],
        [64 * 4 + 20 - 1, 32],
    ])("fits %d px with 20 px fixed and 4 px a column as %d columns", (width, columns) => {
        expect(powerOfTwoColumnsThatFit(width, 20, 4, 8)).toBe(columns);
    });
});
