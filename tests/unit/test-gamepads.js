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
        it("maps a button to a BBC key", function () {
            const gamepad = bbcGamepad();

            expect(gamepad.remap("A", "COPY")).toBeNull();
            expect(gamepad.gamepadMapping[0]).toEqual(BBC.COPY);
        });

        it("maps the sticks and a face button together for the direction names", function () {
            const gamepad = bbcGamepad();

            expect(gamepad.remap("LEFT", "DELETE")).toBeNull();
            expect(gamepad.gamepadAxisMapping[0][-1]).toEqual(BBC.DELETE); // left stick
            expect(gamepad.gamepadAxisMapping[2][-1]).toEqual(BBC.DELETE); // right stick
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
