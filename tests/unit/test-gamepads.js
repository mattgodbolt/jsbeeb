import { describe, it, expect } from "vitest";

import { GamePad } from "../../src/gamepads.js";
import { BBC } from "../../src/utils.js";

describe("GamePad", function () {
    describe("remap", function () {
        it("maps a button to a BBC key", function () {
            const gamepad = new GamePad();

            expect(gamepad.remap("A", "COPY")).toBeNull();
            expect(gamepad.gamepadMapping[0]).toEqual(BBC.COPY);
        });

        it("maps the sticks and a face button together for the direction names", function () {
            const gamepad = new GamePad();

            expect(gamepad.remap("LEFT", "DELETE")).toBeNull();
            expect(gamepad.gamepadAxisMapping[0][-1]).toEqual(BBC.DELETE); // left stick
            expect(gamepad.gamepadAxisMapping[2][-1]).toEqual(BBC.DELETE); // right stick
        });

        it("accepts digits with or without the K prefix", function () {
            const gamepad = new GamePad();

            expect(gamepad.remap("A", "0")).toBeNull();
            expect(gamepad.gamepadMapping[0]).toEqual(BBC.K0);

            expect(gamepad.remap("B", "K9")).toBeNull();
            expect(gamepad.gamepadMapping[1]).toEqual(BBC.K9);
        });

        it("reports an unknown BBC key without changing anything", function () {
            const gamepad = new GamePad();
            const before = gamepad.gamepadMapping[0];

            expect(gamepad.remap("A", "NOTAKEY")).toMatch(/unknown BBC key/);
            expect(gamepad.gamepadMapping[0]).toEqual(before);
        });

        it("reports an unknown gamepad control", function () {
            const gamepad = new GamePad();

            expect(gamepad.remap("WIBBLE", "COPY")).toMatch(/unknown gamepad control/);
        });
    });
});
