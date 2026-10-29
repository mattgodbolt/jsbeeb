import { describe, expect, it } from "vitest";

import { BBC } from "../../src/keymap.js";
import { FunctionRow, KeyPresses, Layers, wantsTouchKeyboard } from "../../src/web/touch-keyboard.js";

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
        expect(wantsTouchKeyboard(false, never)).toBe(false);
        expect(wantsTouchKeyboard(false, (query) => query.includes("coarse"))).toBe(true);
        expect(wantsTouchKeyboard(false, (query) => query.includes("max-width"))).toBe(true);
        expect(wantsTouchKeyboard(true, never)).toBe(true);
    });

    describe("KeyPresses", () => {
        const recording = () => {
            const sent = [];
            const presses = new KeyPresses((key, down) => sent.push(`${key} ${down ? "down" : "up"}`));
            return { sent, presses };
        };

        it("presses at once and lets go only after 40 ms of machine time", () => {
            const { sent, presses } = recording();
            presses.press(1, "A", 1000);
            expect(sent).toEqual(["A down"]);
            presses.release(1);
            presses.sendDueReleases(1039);
            expect(sent).toEqual(["A down"]);
            presses.sendDueReleases(1040);
            expect(sent).toEqual(["A down", "A up"]);
        });

        it("keeps a key down that another finger has pressed again before its release was sent", () => {
            const { sent, presses } = recording();
            presses.press(1, "A", 1000);
            presses.release(1);
            presses.press(2, "A", 1010);
            presses.sendDueReleases(1100);
            expect(sent).toEqual(["A down", "A down"]);
        });

        it("lets go at once when machine time goes backwards, as a power-on reset makes it", () => {
            const { sent, presses } = recording();
            presses.press(1, "A", 1000);
            presses.release(1);
            presses.sendDueReleases(5);
            expect(sent).toEqual(["A down", "A up"]);
        });

        for (const modifier of ["SHIFT", "CTRL"]) {
            it(`keeps ${modifier} lifted before BREAK down until 100 ms after BREAK goes up`, () => {
                const { sent, presses } = recording();
                presses.press(1, modifier, 1000);
                presses.press(2, "BREAK", 1010);
                presses.release(1);
                presses.sendDueReleases(1060);
                presses.release(2);
                presses.sendDueReleases(1070);
                expect(sent).toEqual([`${modifier} down`, "BREAK down", "BREAK up"]);
                presses.sendDueReleases(1169);
                expect(sent.at(-1)).toBe("BREAK up");
                presses.sendDueReleases(1170);
                expect(sent.at(-1)).toBe(`${modifier} up`);
            });

            it(`keeps ${modifier} lifted just after BREAK down until 100 ms after BREAK went up`, () => {
                const { sent, presses } = recording();
                presses.press(1, modifier, 1000);
                presses.press(2, "BREAK", 1010);
                presses.release(2);
                presses.sendDueReleases(1060);
                presses.release(1);
                presses.sendDueReleases(1080);
                expect(sent).toEqual([`${modifier} down`, "BREAK down", "BREAK up"]);
                presses.sendDueReleases(1160);
                expect(sent.at(-1)).toBe(`${modifier} up`);
            });
        }

        it("holds BREAK for 40 ms of machine time however quick the tap", () => {
            const { sent, presses } = recording();
            presses.press(1, "BREAK", 1000);
            presses.release(1);
            presses.sendDueReleases(1020);
            expect(sent).toEqual(["BREAK down"]);
            presses.sendDueReleases(1040);
            expect(sent).toEqual(["BREAK down", "BREAK up"]);
        });
    });
});
