import { describe, it, expect, vi } from "vitest";

import {
    parseQueryString,
    buildUrlFromParams,
    processKeyboardParams,
    processAutobootParams,
    parseMediaParams,
    guessModelFromHostname,
    ParamTypes,
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
            expect(parseQueryString(qs, { rom: ParamTypes.ARRAY })).toEqual({
                rom: ["os.rom", "basic.rom", "dfs.rom"],
                model: "B",
            });
        });

        it("should handle array parameters with single value", () => {
            const qs = "rom=os.rom&model=B";
            expect(parseQueryString(qs, { rom: ParamTypes.ARRAY })).toEqual({
                rom: ["os.rom"],
                model: "B",
            });
        });

        it("should handle empty array parameters", () => {
            const qs = "rom=&model=B";
            expect(parseQueryString(qs, { rom: ParamTypes.ARRAY })).toEqual({
                rom: [""],
                model: "B",
            });
        });

        it("should handle multiple array parameter types", () => {
            const qs = "rom=os.rom&rom=basic.rom&disc=elite.ssd&disc=other.ssd";
            expect(parseQueryString(qs, { rom: ParamTypes.ARRAY, disc: ParamTypes.ARRAY })).toEqual({
                rom: ["os.rom", "basic.rom"],
                disc: ["elite.ssd", "other.ssd"],
            });
        });

        // Tests for new parameter types
        it("should parse parameter types - string", () => {
            const qs = "name=jsbeeb&title=BBC%20Emulator";
            expect(parseQueryString(qs, { name: ParamTypes.STRING, title: ParamTypes.STRING })).toEqual({
                name: "jsbeeb",
                title: "BBC Emulator",
            });
        });

        it("should parse parameter types - int", () => {
            const qs = "speed=100&cycles=50";
            expect(parseQueryString(qs, { speed: ParamTypes.INT, cycles: ParamTypes.INT })).toEqual({
                speed: 100,
                cycles: 50,
            });
        });

        it("should parse parameter types - float", () => {
            const qs = "volume=0.5&zoom=1.25";
            expect(parseQueryString(qs, { volume: ParamTypes.FLOAT, zoom: ParamTypes.FLOAT })).toEqual({
                volume: 0.5,
                zoom: 1.25,
            });
        });

        it("should parse parameter types - bool", () => {
            const qs = "debug&verbose=false&noseek=true";
            expect(
                parseQueryString(qs, { debug: ParamTypes.BOOL, verbose: ParamTypes.BOOL, noseek: ParamTypes.BOOL }),
            ).toEqual({
                debug: true,
                verbose: false,
                noseek: true,
            });
        });

        it("should handle mixed parameter types", () => {
            const qs = "model=B&rom=os.rom&rom=basic.rom&speed=4&volume=0.8&debug";
            const paramTypes = {
                model: ParamTypes.STRING,
                rom: ParamTypes.ARRAY,
                speed: ParamTypes.INT,
                volume: ParamTypes.FLOAT,
                debug: ParamTypes.BOOL,
            };

            expect(parseQueryString(qs, paramTypes)).toEqual({
                model: "B",
                rom: ["os.rom", "basic.rom"],
                speed: 4,
                volume: 0.8,
                debug: true,
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
            expect(buildUrlFromParams(baseUrl, params, { rom: ParamTypes.ARRAY })).toBe(
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
            expect(buildUrlFromParams(baseUrl, params, { rom: ParamTypes.ARRAY })).toBe(
                "http://localhost:8080/index.html?model=B",
            );
        });

        it("should handle mixed parameter types", () => {
            const params = {
                model: "B",
                disc: "test.ssd",
                rom: ["os.rom", "basic.rom"],
            };
            expect(buildUrlFromParams(baseUrl, params, { rom: ParamTypes.ARRAY })).toBe(
                "http://localhost:8080/index.html?model=B&disc=test.ssd&rom=os.rom&rom=basic.rom",
            );
        });

        // Tests for new parameter types with buildUrlFromParams
        it("should build URL with typed parameters", () => {
            const params = {
                model: "B",
                rom: ["os.rom", "basic.rom"],
                speed: 4,
                volume: 0.8,
                debug: true,
                noseek: false, // Should be omitted as it's false
            };

            const paramTypes = {
                model: ParamTypes.STRING,
                rom: ParamTypes.ARRAY,
                speed: ParamTypes.INT,
                volume: ParamTypes.FLOAT,
                debug: ParamTypes.BOOL,
                noseek: ParamTypes.BOOL,
            };

            expect(buildUrlFromParams(baseUrl, params, paramTypes)).toBe(
                "http://localhost:8080/index.html?model=B&rom=os.rom&rom=basic.rom&speed=4&volume=0.8&debug",
            );
        });

        it("should handle zero values correctly", () => {
            const params = {
                speed: 0,
                volume: 0.0,
            };

            const paramTypes = {
                speed: ParamTypes.INT,
                volume: ParamTypes.FLOAT,
            };

            expect(buildUrlFromParams(baseUrl, params, paramTypes)).toBe(
                "http://localhost:8080/index.html?speed=0&volume=0",
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
        it("should process autoboot parameters with boolean values", () => {
            const params = {
                autoboot: true,
                other: "value",
            };
            expect(processAutobootParams(params)).toEqual({
                needsAutoboot: "boot",
                autoType: "",
            });

            expect(processAutobootParams({ autochain: true })).toEqual({
                needsAutoboot: "chain",
                autoType: "",
            });

            expect(processAutobootParams({ autorun: true })).toEqual({
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

        it("should handle legacy autoboot parameters (backward compatibility)", () => {
            // For backward compatibility, handle string values from parseQueryString legacy mode
            expect(processAutobootParams({ autoboot: "" })).toEqual({
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

    describe("guessModelFromHostname", () => {
        it("should return B-DFS1.2 for hostnames starting with 'bbc'", () => {
            expect(guessModelFromHostname("bbc.example.com")).toBe("B-DFS1.2");
            expect(guessModelFromHostname("bbcmicro.local")).toBe("B-DFS1.2");
        });

        it("should return Master for hostnames starting with 'master'", () => {
            expect(guessModelFromHostname("master.example.com")).toBe("Master");
            expect(guessModelFromHostname("mastercompact.local")).toBe("Master");
        });

        it("should return default model for other hostnames", () => {
            expect(guessModelFromHostname("example.com")).toBe("B-DFS1.2");
            expect(guessModelFromHostname("localhost")).toBe("B-DFS1.2");
            expect(guessModelFromHostname("")).toBe("B-DFS1.2");
        });
    });

    describe("parseQueryString additional tests", () => {
        it("should handle invalid/malformed query strings", () => {
            expect(parseQueryString("=value")).toEqual({ "": "value" });
            expect(parseQueryString("key=")).toEqual({ key: "" });
            expect(parseQueryString("&&&")).toEqual({});
            expect(parseQueryString("key&key=value")).toEqual({ key: "value" });
        });

        it("should handle special characters in query parameters", () => {
            const qs = "text=Hello%20%26%20World%21&file=file%2Bname%40domain.com";
            expect(parseQueryString(qs)).toEqual({
                text: "Hello & World!",
                file: "file+name@domain.com",
            });
        });
    });

    describe("buildUrlFromParams additional tests", () => {
        const baseUrl = "http://localhost:8080/index.html";

        it("should handle empty parameter object", () => {
            expect(buildUrlFromParams(baseUrl, {})).toBe(baseUrl);
        });

        it("should encode special characters in URL parameters", () => {
            const params = {
                text: "Hello & World!",
                file: "file+name@domain.com",
            };
            const expected = "http://localhost:8080/index.html?text=Hello%20%26%20World!&file=file%2Bname%40domain.com";
            expect(buildUrlFromParams(baseUrl, params)).toBe(expected);
        });

        it("should handle explicit parameter types", () => {
            const params = {
                name: "jsbeeb",
                roms: ["os.rom", "basic.rom"],
                debug: true,
            };

            // With ARRAY type for roms - we should get separate parameters
            expect(buildUrlFromParams(baseUrl, params, { roms: ParamTypes.ARRAY })).toBe(
                "http://localhost:8080/index.html?name=jsbeeb&roms=os.rom&roms=basic.rom&debug=true",
            );

            // With BOOL type for debug and ARRAY type for roms
            expect(
                buildUrlFromParams(baseUrl, params, {
                    debug: ParamTypes.BOOL,
                    roms: ParamTypes.ARRAY,
                }),
            ).toBe("http://localhost:8080/index.html?name=jsbeeb&roms=os.rom&roms=basic.rom&debug");
        });
    });
});
