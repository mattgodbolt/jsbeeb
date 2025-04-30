import { describe, it, expect, vi } from "vitest";

import { processKeyboardParams, processAutobootParams, parseMediaParams } from "../../src/url-params.js";

describe("URL Parameters", () => {
    describe("processKeyboardParams", () => {
        it("should process keyboard mappings", () => {
            const BBC = { CTRL: "CTRL", SHIFT: "SHIFT" };
            const keyCodes = { A: 65, B: 66 };
            const userKeymap = [];
            const gamepad = { remap: vi.fn() };

            const parsedQuery = {
                "KEY.A": "CTRL",
                "KEY.B": "SHIFT",
                "GP.FIRE2": "RETURN",
                UP: "Q",
                other: "value",
            };

            processKeyboardParams(parsedQuery, BBC, keyCodes, userKeymap, gamepad);

            expect(userKeymap).toEqual([
                { native: "A", bbc: "CTRL" },
                { native: "B", bbc: "SHIFT" },
            ]);

            expect(gamepad.remap).toHaveBeenCalledTimes(2);
            expect(gamepad.remap).toHaveBeenCalledWith("FIRE2", "RETURN");
            expect(gamepad.remap).toHaveBeenCalledWith("UP", "Q");
        });
    });

    describe("processAutobootParams", () => {
        it("should process autoboot parameters", () => {
            const params = {
                autoboot: "",
                other: "value",
            };
            expect(processAutobootParams(params)).toEqual({
                needsAutoboot: "boot",
                autoType: "",
            });

            expect(processAutobootParams({ autochain: "" })).toEqual({
                needsAutoboot: "chain",
                autoType: "",
            });

            expect(processAutobootParams({ autorun: "" })).toEqual({
                needsAutoboot: "run",
                autoType: "",
            });

            expect(processAutobootParams({ autotype: "HELLO" })).toEqual({
                needsAutoboot: "type",
                autoType: "HELLO",
            });

            expect(processAutobootParams({ other: "value" })).toEqual({
                needsAutoboot: false,
                autoType: "",
            });
        });
    });

    describe("parseMediaParams", () => {
        it("should extract disc and tape images from query params", () => {
            const params = {
                disc: "elite.ssd",
                disc2: "games.ssd",
                tape: "welcome.uef",
                other: "value",
            };

            expect(parseMediaParams(params)).toEqual({
                discImage: "elite.ssd",
                secondDiscImage: "games.ssd",
                tapeImage: "welcome.uef",
            });

            expect(parseMediaParams({ disc1: "disc1.ssd" })).toEqual({
                discImage: "disc1.ssd",
                secondDiscImage: undefined,
                tapeImage: undefined,
            });
        });
    });
});
