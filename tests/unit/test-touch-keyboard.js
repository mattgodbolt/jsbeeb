// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BBC } from "../../src/keymap.js";
import {
    dpadKeysAt,
    followingGamepad,
    FunctionRow,
    keysPerLine,
    KeyPresses,
    Layers,
    PadPresets,
    placeGroups,
    PromptGroups,
    wantsTouchKeyboard,
} from "../../src/web/touch-keyboard.js";

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

    describe("pad presets", () => {
        const presets = Object.values(PadPresets);
        const actionsOf = ({ groups }) => groups.flatMap((each) => each.actions);

        it("press only keys the BBC matrix has, each once, from groups of a known shape, side and use", () => {
            for (const preset of presets) {
                const keys = actionsOf(preset).map((one) => one.key);
                for (const key of keys) expect(BBC[key], `${preset.title} ${key}`).toBeDefined();
                expect(new Set(keys).size, preset.title).toBe(keys.length);
                for (const { name, shape, side, use } of preset.groups) {
                    expect(["dpad", "buttons", "column", "row"], name).toContain(shape);
                    expect(["left", "right"], name).toContain(side);
                    expect(["core", "often"], name).toContain(use);
                }
            }
        });

        it("each give the left thumb a d-pad of four directions and the right a fire button, and no thumb two", () => {
            for (const preset of presets) {
                const { left, right } = placeGroups(preset.groups);
                expect(left.thumb.shape, preset.title).toBe("dpad");
                expect(left.thumb.actions.map((one) => one.role)).toEqual(["left", "right", "up", "down"]);
                expect(right.thumb.actions.map((one) => one.role)).toContain("fire");
                const thumbs = preset.groups.filter(
                    (each) => each.use === "core" && ["dpad", "buttons"].includes(each.shape),
                );
                expect(thumbs, preset.title).toHaveLength(2);
            }
        });

        it("keep the prompt keys unless they drop them, as Exile does for its own keys", () => {
            const hasPrompts = (preset) => PromptGroups.every((prompt) => preset.groups.includes(prompt));
            expect(hasPrompts(PadPresets.classic)).toBe(true);
            expect(hasPrompts(PadPresets.zxmkl)).toBe(true);
            expect(actionsOf(PadPresets.exile).map((one) => one.key)).not.toContain("K1");
        });

        it("place Exile's aim as a column beside the fire button, its hand as a row below, and its often keys above", () => {
            const { left, right } = placeGroups(PadPresets.exile.groups);
            const names = (groups) => groups.map((each) => each.name);
            expect({
                left: [names(left.often), left.thumb.name, names(left.columns), names(left.rows)],
                right: [names(right.often), right.thumb.name, names(right.columns), names(right.rows)],
            }).toEqual({
                left: [["body"], "move", [], []],
                right: [["weapons"], "fire", ["aim"], ["hand"]],
            });
            expect(right.columns[0].actions.map((one) => one.role)).toEqual(["up", "centre", "down"]);
        });

        it.each([
            [1, 1],
            [3, 3],
            [5, 5],
            [6, 3],
            [7, 4],
            [10, 5],
        ])("puts a row of %i keys %i to a line, so its lines come out even", (count, perLine) => {
            expect(keysPerLine(count)).toBe(perLine);
        });

        it("take the keys the URL gives a gamepad's directions, FIRE and START, and only those", () => {
            const keysOf = (preset) =>
                Object.fromEntries(actionsOf(preset).map((one) => [one.role ?? one.key, one.key]));
            const classic = keysOf(PadPresets.classic);
            expect(keysOf(followingGamepad(PadPresets.classic, {}))).toEqual(classic);
            const zalaga = { LEFT: "CAPSLOCK", RIGHT: "CTRL", FIRE: "SHIFT", START: "K1", A: "COPY" };
            expect(keysOf(followingGamepad(PadPresets.classic, zalaga))).toEqual({
                ...classic,
                left: "CAPSLOCK",
                right: "CTRL",
                fire: "SHIFT",
                second: "K1",
            });
        });
    });

    describe("the d-pad", () => {
        const box = { left: 100, top: 200, width: 90, height: 90 };
        const keyFor = { left: "Z", right: "X", up: "COLON_STAR", down: "SLASH" };
        it.each([
            ["the middle", 145, 245, []],
            ["the left arm", 110, 245, ["Z"]],
            ["the top right corner", 180, 210, ["X", "COLON_STAR"]],
            ["the bottom left corner", 110, 280, ["Z", "SLASH"]],
            ["past the right edge", 400, 245, ["X"]],
            ["past the top left corner", 0, 0, ["Z", "COLON_STAR"]],
        ])("presses for a touch at %s", (_, x, y, keys) => {
            expect(dpadKeysAt(box, x, y, keyFor)).toEqual(keys);
        });
    });

    describe("KeyPresses", () => {
        const recording = () => {
            const sent = [];
            const presses = new KeyPresses((key, down) => sent.push(`${key} ${down ? "down" : "up"}`));
            return { sent, presses };
        };

        it("presses at once and lets go only after 40 ms of machine time", () => {
            const { sent, presses } = recording();
            presses.hold(1, ["A"], 1000);
            expect(sent).toEqual(["A down"]);
            presses.release(1);
            presses.sendDueReleases(1039);
            expect(sent).toEqual(["A down"]);
            presses.sendDueReleases(1040);
            expect(sent).toEqual(["A down", "A up"]);
        });

        it("keeps a key down that another finger has pressed again before its release was sent", () => {
            const { sent, presses } = recording();
            presses.hold(1, ["A"], 1000);
            presses.release(1);
            presses.hold(2, ["A"], 1010);
            presses.sendDueReleases(1100);
            expect(sent).toEqual(["A down", "A down"]);
        });

        it("lets go at once when machine time goes backwards, as a power-on reset makes it", () => {
            const { sent, presses } = recording();
            presses.hold(1, ["A"], 1000);
            presses.release(1);
            presses.sendDueReleases(5);
            expect(sent).toEqual(["A down", "A up"]);
        });

        for (const modifier of ["SHIFT", "CTRL"]) {
            it(`keeps ${modifier} lifted before BREAK down until 100 ms after BREAK goes up`, () => {
                const { sent, presses } = recording();
                presses.hold(1, [modifier], 1000);
                presses.hold(2, ["BREAK"], 1010);
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
                presses.hold(1, [modifier], 1000);
                presses.hold(2, ["BREAK"], 1010);
                presses.release(2);
                presses.sendDueReleases(1060);
                presses.release(1);
                presses.sendDueReleases(1080);
                expect(sent).toEqual([`${modifier} down`, "BREAK down", "BREAK up"]);
                presses.sendDueReleases(1160);
                expect(sent.at(-1)).toBe(`${modifier} up`);
            });
        }

        it("moves one pointer's keys as it slides, keeping those it stays on and letting go of the rest after 40 ms", () => {
            const { sent, presses } = recording();
            expect(presses.hold(1, ["Z"], 1000)).toBe(true);
            expect(presses.hold(1, ["Z", "COLON_STAR"], 1010)).toBe(true);
            expect(presses.hold(1, ["COLON_STAR"], 1050)).toBe(false);
            presses.sendDueReleases(1060);
            expect(sent).toEqual(["Z down", "COLON_STAR down", "Z up"]);
            presses.hold(1, [], 1060);
            presses.sendDueReleases(1060);
            expect(sent.at(-1)).toBe("COLON_STAR up");
        });

        it("lets go of every key of every pointer at once, as turning the phone does", () => {
            const { sent, presses } = recording();
            presses.hold(1, ["Z", "COLON_STAR"], 1000);
            presses.hold(2, ["RETURN"], 1000);
            presses.releaseAll();
            presses.sendDueReleases(1040);
            expect(sent.slice(3).sort()).toEqual(["COLON_STAR up", "RETURN up", "Z up"]);
            expect(presses.held.size).toBe(0);
        });

        it("holds BREAK for 40 ms of machine time however quick the tap", () => {
            const { sent, presses } = recording();
            presses.hold(1, ["BREAK"], 1000);
            presses.release(1);
            presses.sendDueReleases(1020);
            expect(sent).toEqual(["BREAK down"]);
            presses.sendDueReleases(1040);
            expect(sent).toEqual(["BREAK down", "BREAK up"]);
        });
    });
});
