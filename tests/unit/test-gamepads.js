import { describe, it, expect, vi } from "vitest";

import { GamePad } from "../../src/web/gamepads.js";
import { BBC } from "../../src/keymap.js";
import { ATOM } from "../../src/keymap-atom.js";
import { findModel } from "../../src/models.js";

const bbcGamepad = () => new GamePad(findModel("B-DFS1.2"));

describe("GamePad", function () {
    it("presses the emulated machine's keys, by default and when remapped", function () {
        const gamepad = new GamePad(findModel("Atom"));

        expect(gamepad.gamepadMapping[14]).toEqual(ATOM.K3);
        expect(gamepad.remap("A", "LOCK")).toBeNull();
        expect(gamepad.gamepadMapping[0]).toEqual(ATOM.LOCK);
    });

    describe("remap", function () {
        const leftStick = { up: [1, -1], down: [1, 1], left: [0, -1], right: [0, 1] };
        const rightStick = { up: [3, -1], down: [3, 1], left: [2, -1], right: [2, 1] };

        it.each([
            ["A", [0], []],
            ["B", [1], []],
            ["X", [2], []],
            ["Y", [3], []],
            ["LB", [4], []],
            ["RB", [5], []],
            ["LT", [6], []],
            ["RT", [7], []],
            ["BACK", [8], []],
            ["START", [9], []],
            ["FIRE1", [10], []],
            ["FIRE2", [11], []],
            ["FIRE", [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11], []],
            ["UP", [12], [leftStick.up, rightStick.up]],
            ["DOWN", [13], [leftStick.down, rightStick.down]],
            ["LEFT", [14], [leftStick.left, rightStick.left]],
            ["RIGHT", [15], [leftStick.right, rightStick.right]],
            ["UP1", [], [leftStick.up]],
            ["DOWN1", [], [leftStick.down]],
            ["LEFT1", [], [leftStick.left]],
            ["RIGHT1", [], [leftStick.right]],
            ["UP2", [], [rightStick.up]],
            ["DOWN2", [], [rightStick.down]],
            ["LEFT2", [], [rightStick.left]],
            ["RIGHT2", [], [rightStick.right]],
            ["UP3", [0], []],
            ["DOWN3", [2], []],
            ["LEFT3", [3], []],
            ["RIGHT3", [1], []],
        ])("GP.%s sets buttons %j and stick directions %j", (control, buttons, axes) => {
            const gamepad = bbcGamepad();

            expect(gamepad.remap(control, "COPY")).toBeNull();
            const buttonsSet = gamepad.gamepadMapping.flatMap((key, button) => (key === BBC.COPY ? [button] : []));
            const axesSet = gamepad.gamepadAxisMapping.flatMap((byDirection, axis) =>
                [-1, 1]
                    .filter((direction) => byDirection[direction] === BBC.COPY)
                    .map((direction) => [axis, direction]),
            );
            expect(buttonsSet).toEqual(buttons);
            expect(axesSet.sort()).toEqual([...axes].sort());
        });

        it("accepts digits with or without the K prefix", function () {
            const gamepad = bbcGamepad();

            expect(gamepad.remap("A", "0")).toBeNull();
            expect(gamepad.gamepadMapping[0]).toEqual(BBC.K0);

            expect(gamepad.remap("B", "K9")).toBeNull();
            expect(gamepad.gamepadMapping[1]).toEqual(BBC.K9);
            expect(gamepad.remapped).toEqual({ A: "K0", B: "K9" });
        });

        it("reports an unknown key without changing anything", function () {
            const gamepad = bbcGamepad();
            const before = gamepad.gamepadMapping[0];

            expect(gamepad.remap("A", "NOTAKEY")).toMatch(/not a key on the emulated machine/);
            expect(gamepad.gamepadMapping[0]).toEqual(before);
            expect(gamepad.remapped).toEqual({});
        });

        it("reports an unknown gamepad control", function () {
            const gamepad = bbcGamepad();

            expect(gamepad.remap("WIBBLE", "COPY")).toMatch(/unknown gamepad control/);
        });
    });

    describe("fire buttons", () => {
        const pad = (pressed) => ({
            buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: !!pressed[i] })),
            axes: [0, 0, 0, 0],
        });

        it.each([
            ["no gamepads", [null, null], [false, false]],
            ["FIRE1 on the only gamepad", [{ 10: true }], [true, false]],
            ["FIRE2 on the only gamepad", [{ 11: true }], [false, true]],
            ["FIRE1 on the second gamepad", [{}, { 10: true }], [false, true]],
            ["FIRE2 on the first of two gamepads", [{ 11: true }, {}], [false, true]],
        ])("latches %s into the System VIA", (_, pads, expected) => {
            const sysvia = { setGamepadFire: vi.fn() };
            const polled = pads.map((pressed) => pressed && pad(pressed));
            bbcGamepad().update({ keyboardInterface: {}, sysvia, config: { getGamepads: () => polled } });
            expect(sysvia.setGamepadFire).toHaveBeenCalledWith(...expected);
        });
    });
});
