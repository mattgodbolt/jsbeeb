import { describe, expect, it } from "vitest";

import { BBC } from "../../src/keymap.js";
import { FunctionRow, Layers, wantsTouchKeyboard } from "../../src/web/touch-keyboard.js";

const allKeys = [FunctionRow, ...Object.values(Layers).flat()].flat().filter((def) => def.key);
const keysOf = (layer) => Layers[layer].flat().map((def) => def.key);

describe("touch keyboard", () => {
    it("presses only keys the BBC matrix has, and BREAK", () => {
        for (const { key } of allKeys) if (key !== "BREAK") expect(BBC[key], key).toBeDefined();
    });

    it("offers every key a BBC has between its two layers", () => {
        const offered = new Set(allKeys.map((def) => def.key));
        const missing = Object.keys(BBC).filter((key) => !key.startsWith("NUMPAD") && !offered.has(key));
        expect(missing).toEqual([]);
    });

    it("keeps space, cursors and the layer key in the same place on both layers", () => {
        const bottom = (layer) => Layers[layer].at(-1).map((def) => def.key);
        expect(bottom("main")).toEqual(bottom("more"));
    });

    it("puts the Z X * ? RETURN cluster on the main layer", () => {
        expect(keysOf("main")).toEqual(expect.arrayContaining(["Z", "X", "COLON_STAR", "SLASH", "RETURN"]));
    });

    it("fills every grid row of both layers with twelve columns, counting RETURN's second row", () => {
        for (const rows of Object.values(Layers)) {
            const grid = rows.slice(0, -1).flat();
            const cells = grid.reduce((sum, def) => sum + def.w * (def.rows ?? 1), 0);
            expect(cells).toBe(12 * (rows.length - 1));
        }
    });

    it("has BREAK only at the end of the function row, set apart from f9", () => {
        expect([...keysOf("main"), ...keysOf("more")]).not.toContain("BREAK");
        expect(FunctionRow.map((def) => def.key)).toEqual([
            ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `F${n}`),
            undefined,
            "BREAK",
        ]);
    });

    it("gives both layers the same number of rows, so the keyboard does not change height", () => {
        expect(Layers.more.length).toBe(Layers.main.length);
    });

    it("is offered on a touch screen or a narrow window, or when asked for", () => {
        const never = () => false;
        expect(wantsTouchKeyboard("", never)).toBe(false);
        expect(wantsTouchKeyboard("", (query) => query.includes("coarse"))).toBe(true);
        expect(wantsTouchKeyboard("", (query) => query.includes("max-width"))).toBe(true);
        expect(wantsTouchKeyboard("?touchkeys", never)).toBe(true);
    });
});
