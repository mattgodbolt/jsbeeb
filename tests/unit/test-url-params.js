import { describe, it, expect, vi } from "vitest";

import {
    parseQueryString,
    buildUrlFromParams,
    processKeyboardParams,
    processAutobootParams,
    parseMediaParams,
} from "../../src/url-params.js";

describe("URL Parameters", () => {
    describe("parseQueryString", () => {
        it("should parse empty query string", () => {
            expect(parseQueryString("")).toEqual({});
        });

        it("should parse basic query string parameters", () => {
            const qs = "model=B&disc=elite.ssd";
            expect(parseQueryString(qs)).toEqual({
                model: "B",
                disc: "elite.ssd",
            });
        });

        it("should handle URL encoded components", () => {
            const qs = "text=Hello%20World&path=file%2Fname.txt";
            expect(parseQueryString(qs)).toEqual({
                text: "Hello World",
                path: "file/name.txt",
            });
        });

        it("should handle parameters without values", () => {
            const qs = "debug&verbose&disc=test.ssd&noseek";
            expect(parseQueryString(qs)).toEqual({
                debug: null,
                verbose: null,
                disc: "test.ssd",
                noseek: null,
            });
        });

        it("should handle query strings ending with /", () => {
            const qs = "model=B&disc=elite.ssd/";
            expect(parseQueryString(qs)).toEqual({
                model: "B",
                disc: "elite.ssd",
            });
        });

        it("should handle array parameters", () => {
            const qs = "rom=os.rom&rom=basic.rom&rom=dfs.rom&model=B";
            expect(parseQueryString(qs, ["rom"])).toEqual({
                rom: ["os.rom", "basic.rom", "dfs.rom"],
                model: "B",
            });
        });

        it("should handle array parameters with single value", () => {
            const qs = "rom=os.rom&model=B";
            expect(parseQueryString(qs, ["rom"])).toEqual({
                rom: ["os.rom"],
                model: "B",
            });
        });

        it("should handle empty array parameters", () => {
            const qs = "rom=&model=B";
            expect(parseQueryString(qs, ["rom"])).toEqual({
                rom: [""],
                model: "B",
            });
        });

        it("should handle multiple array parameter types", () => {
            const qs = "rom=os.rom&rom=basic.rom&disc=elite.ssd&disc=other.ssd";
            expect(parseQueryString(qs, ["rom", "disc"])).toEqual({
                rom: ["os.rom", "basic.rom"],
                disc: ["elite.ssd", "other.ssd"],
            });
        });
    });
    describe("buildUrlFromParams", () => {
        const baseUrl = "http://localhost:8080/index.html";

        it("should build URL with basic parameters", () => {
            const params = { model: "B", disc: "elite.ssd" };
            expect(buildUrlFromParams(baseUrl, params)).toBe("http://localhost:8080/index.html?model=B&disc=elite.ssd");
        });

        it("should handle array parameters in URL", () => {
            const params = {
                model: "B",
                rom: ["os.rom", "basic.rom", "dfs.rom"],
            };
            expect(buildUrlFromParams(baseUrl, params)).toBe(
                "http://localhost:8080/index.html?model=B&rom=os.rom&rom=basic.rom&rom=dfs.rom",
            );
        });

        it("should skip empty or falsy values", () => {
            const params = {
                model: "B",
                disc: "",
                debug: null,
                rom: [],
            };
            expect(buildUrlFromParams(baseUrl, params)).toBe("http://localhost:8080/index.html?model=B");
        });

        it("should handle mixed parameter types", () => {
            const params = {
                model: "B",
                disc: "test.ssd",
                rom: ["os.rom", "basic.rom"],
            };
            expect(buildUrlFromParams(baseUrl, params)).toBe(
                "http://localhost:8080/index.html?model=B&disc=test.ssd&rom=os.rom&rom=basic.rom",
            );
        });
    });

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
