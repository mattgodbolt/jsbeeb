import { describe, expect, it } from "vitest";

import { FunctionRow, Layers, keyNames, matrixPosition, wantsTouchKeyboard } from "../../src/web/touch-keyboard.js";

describe("touch keyboard", () => {
    it("only presses keys the BBC matrix has", () => {
        for (const name of keyNames()) expect(matrixPosition(name), name).toBeDefined();
    });

    it("offers every key a BBC has between its two layers", () => {
        const names = keyNames();
        for (const name of ["SHIFT", "CTRL", "CAPSLOCK", "RETURN", "DELETE", "ESCAPE", "COPY", "SPACE", "F0", "F9"]) {
            expect(names.has(name), name).toBe(true);
        }
    });

    it("keeps space, cursors and the layer key in the same place on both layers", () => {
        const bottom = (layer) => Layers[layer].at(-1).map((key) => key.key);
        expect(bottom("letters").slice(1)).toEqual(bottom("symbols").slice(1));
    });

    it("puts the Z X * ? RETURN cluster on the main layer, with * over : and ? over /", () => {
        const main = Layers.letters.flat();
        const key = (name) => main.find((def) => def.key === name);
        for (const name of ["Z", "X", "COLON_STAR", "SLASH", "RETURN"]) expect(key(name), name).toBeDefined();
        expect(key("COLON_STAR")).toMatchObject({ label: ":", sub: "*" });
        expect(key("SLASH")).toMatchObject({ label: "/", sub: "?" });
        expect(key("RETURN").rows).toBe(2);
    });

    it("fills every grid row of both layers with twelve columns, counting RETURN's second row", () => {
        for (const rows of Object.values(Layers)) {
            const grid = rows.slice(0, -1);
            const tall = grid.flat().filter((def) => def.rows === 2).length;
            const columns = grid.map((row) => row.reduce((sum, def) => sum + def.w, 0));
            expect(columns.reduce((a, b) => a + b, 0) + tall * 1).toBe(12 * grid.length);
        }
    });

    it("has BREAK only in the function row, set apart from f9", () => {
        expect(
            Object.values(Layers)
                .flat(2)
                .some((key) => key.reset),
        ).toBe(false);
        const index = FunctionRow.findIndex((key) => key.reset);
        expect(FunctionRow[index - 1].spacer).toBe(true);
        expect(FunctionRow.slice(0, index - 1).map((key) => key.key)).toEqual(
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `F${n}`),
        );
    });

    it("gives both layers the same number of rows, so the keyboard does not change height", () => {
        expect(Layers.symbols.length).toBe(Layers.letters.length);
    });

    describe("wantsTouchKeyboard", () => {
        const never = () => false;
        it("is on for a touch screen or a narrow window, or when forced", () => {
            expect(wantsTouchKeyboard("", never)).toBe(false);
            expect(wantsTouchKeyboard("", (q) => q.includes("coarse"))).toBe(true);
            expect(wantsTouchKeyboard("", (q) => q.includes("max-width"))).toBe(true);
            expect(wantsTouchKeyboard("?touchkeys", never)).toBe(true);
        });
    });
});
