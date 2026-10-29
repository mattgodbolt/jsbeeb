import { describe, expect, it } from "vitest";

import { Layers, keyNames, matrixPosition, wantsTouchKeyboard } from "../../src/web/touch-keyboard.js";

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

    it("keeps BREAK out of the letters layer, and apart from the function keys on the symbols layer", () => {
        expect(Layers.letters.flat().some((key) => key.reset)).toBe(false);
        const row = Layers.symbols[0];
        const index = row.findIndex((key) => key.reset);
        expect(row[index - 1].spacer).toBe(true);
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
