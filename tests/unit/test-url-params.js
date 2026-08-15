import { describe, it, expect, vi } from "vitest";

import {
    parseQueryString,
    buildUrlFromParams,
    processInputParams,
    processAutobootParams,
    parseMediaParams,
    processDriveTrackParams,
    guessModelFromHostname,
    DriveTracks,
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

    describe("processInputParams", () => {
        it("should process keyboard mappings", () => {
            const machineKeys = { CTRL: "CTRL", SHIFT: "SHIFT" };
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

            const warnings = processInputParams(parsedQuery, machineKeys, keyCodes, userKeymap, gamepad);

            expect(userKeymap).toEqual([
                { native: "A", key: "CTRL" },
                { native: "B", key: "SHIFT" },
            ]);
            expect(warnings).toEqual([]);

            expect(gamepad.remap).toHaveBeenCalledTimes(2);
            expect(gamepad.remap).toHaveBeenCalledWith("FIRE2", "RETURN");
            expect(gamepad.remap).toHaveBeenCalledWith("UP", "Q");
        });

        it("should report mappings it can't apply", () => {
            const machineKeys = { CTRL: "CTRL" };
            const keyCodes = { A: 65 };
            const userKeymap = [];
            const gamepad = { remap: vi.fn().mockReturnValue('unknown gamepad control "WIBBLE".') };

            const warnings = processInputParams(
                { "KEY.A": "NOTAKEY", "KEY.NOTAKEY": "CTRL", "GP.WIBBLE": "CTRL" },
                machineKeys,
                keyCodes,
                userKeymap,
                gamepad,
            );

            expect(warnings).toEqual([
                'KEY.A=NOTAKEY: "NOTAKEY" is not a key on the emulated machine.',
                'KEY.NOTAKEY=CTRL: "NOTAKEY" is not a key on your keyboard.',
                'GP.WIBBLE=CTRL: unknown gamepad control "WIBBLE".',
            ]);
            expect(userKeymap).toEqual([]);
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
                mmcImage: undefined,
            });

            expect(parseMediaParams({ disc1: "disc1.ssd" })).toEqual({
                discImage: "disc1.ssd",
                secondDiscImage: undefined,
                tapeImage: undefined,
                mmcImage: undefined,
            });
        });

        it("should extract mmc image for Atom", () => {
            expect(parseMediaParams({ mmc: "sdcard.zip" })).toEqual({
                discImage: undefined,
                secondDiscImage: undefined,
                tapeImage: undefined,
                mmcImage: "sdcard.zip",
            });
        });
    });

    describe("processDriveTrackParams", () => {
        it("leaves every drive to work it out for itself by default", () => {
            expect(processDriveTrackParams({})).toEqual({
                settings: [DriveTracks.auto, DriveTracks.auto],
                warnings: [],
            });
        });

        it("fixes the switch of the drive that was named", () => {
            expect(processDriveTrackParams({ drive1Tracks: "40" })).toEqual({
                settings: [DriveTracks.auto, DriveTracks.forty],
                warnings: [],
            });
            expect(processDriveTrackParams({ drive0Tracks: "80" }).settings[0]).toBe(DriveTracks.eighty);
        });

        it("says what it could not use", () => {
            const { settings, warnings } = processDriveTrackParams({ drive0Tracks: "35" });

            expect(settings[0]).toBe(DriveTracks.auto);
            expect(warnings).toEqual(["drive0Tracks=35: a drive is set to 40, 80 or auto."]);
        });
    });

    describe("round tripping", () => {
        const awkwardValues = [
            "sth:Micropower/Ghouls.zip",
            "!local/My Disc (1984).ssd",
            "|Superior/Repton 3.zip",
            "http://example.com/a b?c=d#e",
            "b64data:AAAAgH8=",
            "a=b=c",
            "100% pure",
            "%41",
            "%2F",
            "one & two",
            "plus+plus",
            "hash#tag",
            "trailing/",
            "line\nbreak",
            "café",
            "日本語",
            "!$'()*,;:@/-_.~",
            "0",
        ];

        it.each(awkwardValues)("should survive a build and parse of %j", (value) => {
            const url = buildUrlFromParams("", { disc1: value, autoboot: true });
            expect(parseQueryString(url.substring(1), { autoboot: ParamTypes.BOOL })).toEqual({
                disc1: value,
                autoboot: true,
            });
        });

        it.each(awkwardValues)("should survive a build and parse of %j as a key", (key) => {
            const url = buildUrlFromParams("", { [key]: "value" });
            expect(parseQueryString(url.substring(1))).toEqual({ [key]: "value" });
        });

        // The parser strips a trailing slash from the whole query string, which only a value in the
        // final position can run into.
        it.each(awkwardValues)("should survive a build and parse of %j when it ends the query", (value) => {
            const url = buildUrlFromParams("", { disc1: value });
            expect(parseQueryString(url.substring(1))).toEqual({ disc1: value });
        });

        it("should parse URLs generated before the encoding was relaxed", () => {
            expect(parseQueryString("disc1=sth%3AMicropower%2FGhouls.zip&model=Master&autoboot")).toEqual({
                disc1: "sth:Micropower/Ghouls.zip",
                model: "Master",
                autoboot: null,
            });
            expect(parseQueryString("disc1=sth:Micropower/Ghouls.zip&model=Master&autoboot")).toEqual({
                disc1: "sth:Micropower/Ghouls.zip",
                model: "Master",
                autoboot: null,
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

        it("should return Atom for hostnames starting with 'atom'", () => {
            expect(guessModelFromHostname("atom.example.com")).toBe("Atom");
            expect(guessModelFromHostname("atomulator.local")).toBe("Atom");
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

        it("should keep everything after the first equals in the value", () => {
            expect(parseQueryString("a=b=c")).toEqual({ a: "b=c" });
            expect(parseQueryString("data=AAAA==&model=B")).toEqual({ data: "AAAA==", model: "B" });
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
            const expected = "http://localhost:8080/index.html?text=Hello%20%26%20World!&file=file%2Bname@domain.com";
            expect(buildUrlFromParams(baseUrl, params)).toBe(expected);
        });

        it("should leave characters the query grammar allows alone", () => {
            expect(buildUrlFromParams(baseUrl, { disc1: "sth:Micropower/Ghouls.zip" })).toBe(
                "http://localhost:8080/index.html?disc1=sth:Micropower/Ghouls.zip",
            );
            expect(buildUrlFromParams(baseUrl, { punctuation: "!$'()*,;:@/-_.~" })).toBe(
                "http://localhost:8080/index.html?punctuation=!$'()*,;:@/-_.~",
            );
        });

        it("should escape everything that delimits, and question marks", () => {
            expect(buildUrlFromParams(baseUrl, { "a&b": "c=d", "e#f": "g%h", "i+j": "k l", "m?n": "o?p" })).toBe(
                "http://localhost:8080/index.html?a%26b=c%3Dd&e%23f=g%25h&i%2Bj=k%20l&m%3Fn=o%3Fp",
            );
        });

        it("should not end a component in the slash the parser strips", () => {
            const url = buildUrlFromParams(baseUrl, { dir: "archive/sth/" });
            expect(url).toBe("http://localhost:8080/index.html?dir=archive/sth%2F");
            expect(parseQueryString(url.substring(url.indexOf("?") + 1))).toEqual({ dir: "archive/sth/" });
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
