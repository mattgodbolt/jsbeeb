import { describe, it, expect } from "vitest";

import {
    parseQueryString,
    parseLocationParams,
    buildUrlFromParams,
    processAutobootParams,
    bootModeOf,
    parseMediaParams,
    processDriveTrackParams,
    guessModelFromHostname,
    DriveTracks,
    ParamTypes,
} from "../../src/url-params.js";

const typesOf = (types) => (name) => types[name];

const BaseUrl = "http://localhost:8080/index.html";
const { ARRAY, BOOL, BOOL_DEFAULT_TRUE, FLOAT, INT, STRING } = ParamTypes;

describe("URL Parameters", () => {
    describe("parseQueryString", () => {
        it.each([
            ["", {}, {}],
            ["model=B&disc=elite.ssd", {}, { model: "B", disc: "elite.ssd" }],
            ["text=Hello%20World&path=file%2Fname.txt", {}, { text: "Hello World", path: "file/name.txt" }],
            [
                "text=Hello%20%26%20World%21&file=file%2Bname%40domain.com",
                {},
                { text: "Hello & World!", file: "file+name@domain.com" },
            ],
            ["debug&verbose&disc=test.ssd", {}, { debug: null, verbose: null, disc: "test.ssd" }],
            ["model=B&disc=archive/sth/", {}, { model: "B", disc: "archive/sth/" }],
            ["a=b=c&data=AAAA==", {}, { a: "b=c", data: "AAAA==" }],
            ["=value", {}, { "": "value" }],
            ["key=", {}, { key: "" }],
            ["&&&", {}, {}],
            ["key&key=value", {}, { key: "value" }],
            [
                "disc1=sth%3AMicropower%2FGhouls.zip&autoboot",
                {},
                { disc1: "sth:Micropower/Ghouls.zip", autoboot: null },
            ],
            ["disc1=sth:Micropower/Ghouls.zip&autoboot", {}, { disc1: "sth:Micropower/Ghouls.zip", autoboot: null }],
            [
                "rom=os.rom&rom=basic.rom&disc=a.ssd&disc=b.ssd",
                { rom: ARRAY, disc: ARRAY },
                { rom: ["os.rom", "basic.rom"], disc: ["a.ssd", "b.ssd"] },
            ],
            ["rom=os.rom&model=B", { rom: ARRAY }, { rom: ["os.rom"], model: "B" }],
            ["rom=&model=B", { rom: ARRAY }, { rom: [""], model: "B" }],
            [
                "debug&verbose=false&noseek=true",
                { debug: BOOL, verbose: BOOL, noseek: BOOL },
                { debug: true, verbose: false, noseek: true },
            ],
            [
                "gl&latency=false&fast=true",
                { gl: BOOL_DEFAULT_TRUE, latency: BOOL_DEFAULT_TRUE, fast: BOOL_DEFAULT_TRUE },
                { gl: true, latency: false, fast: true },
            ],
            [
                "model=B&rom=os.rom&rom=basic.rom&speed=4&volume=0.8&debug",
                { model: STRING, rom: ARRAY, speed: INT, volume: FLOAT, debug: BOOL },
                { model: "B", rom: ["os.rom", "basic.rom"], speed: 4, volume: 0.8, debug: true },
            ],
        ])("reads %j with types %o", (query, types, expected) => {
            expect(parseQueryString(query, typesOf(types))).toEqual(expected);
        });
    });

    describe("parseLocationParams", () => {
        it("reads the parameters in the query and after the hash", () => {
            const location = new URL("https://bbc.example/?disc=elite.ssd&autoboot#frameSkip=2");
            expect(
                parseLocationParams(location, typesOf({ autoboot: ParamTypes.BOOL, frameSkip: ParamTypes.INT })),
            ).toEqual({
                disc: "elite.ssd",
                autoboot: true,
                frameSkip: 2,
            });
        });
    });

    describe("buildUrlFromParams", () => {
        it.each([
            [{}, {}, ""],
            [{ model: "B", disc: "elite.ssd" }, {}, "?model=B&disc=elite.ssd"],
            [{ model: "B", rom: ["os.rom", "basic.rom"] }, { rom: ARRAY }, "?model=B&rom=os.rom&rom=basic.rom"],
            [{ model: "B", disc: "", debug: null, rom: [] }, { rom: ARRAY }, "?model=B"],
            [{ debug: true, noseek: false }, { debug: BOOL, noseek: BOOL }, "?debug"],
            [{ debug: true }, {}, "?debug=true"],
            [
                { gl: true, latency: false, unset: undefined },
                { gl: BOOL_DEFAULT_TRUE, latency: BOOL_DEFAULT_TRUE, unset: BOOL_DEFAULT_TRUE },
                "?gl&latency=false",
            ],
            [{ speed: 0, volume: 0.0 }, { speed: INT, volume: FLOAT }, "?speed=0&volume=0"],
            [{ speed: 4, volume: 0.8 }, { speed: INT, volume: FLOAT }, "?speed=4&volume=0.8"],
            [
                { text: "Hello & World!", file: "file+name@domain.com" },
                {},
                "?text=Hello%20%26%20World!&file=file%2Bname@domain.com",
            ],
            [{ disc1: "sth:Micropower/Ghouls.zip" }, {}, "?disc1=sth:Micropower/Ghouls.zip"],
            [{ punctuation: "!$'()*,;:@/-_.~" }, {}, "?punctuation=!$'()*,;:@/-_.~"],
            [{ dir: "archive/sth/" }, {}, "?dir=archive/sth/"],
            [
                { "a&b": "c=d", "e#f": "g%h", "i+j": "k l", "m?n": "o?p" },
                {},
                "?a%26b=c%3Dd&e%23f=g%25h&i%2Bj=k%20l&m%3Fn=o%3Fp",
            ],
        ])("writes %o with types %o as %j", (params, types, query) => {
            expect(buildUrlFromParams(BaseUrl, params, typesOf(types))).toBe(BaseUrl + query);
        });
    });

    describe("processAutobootParams", () => {
        it.each([
            [{ autoboot: true, other: "value" }, "boot", ""],
            [{ autochain: true }, "chain", ""],
            [{ autorun: true }, "run", ""],
            [{ autotype: "HELLO" }, "type", "HELLO"],
            [{ other: "value" }, "none", ""],
            [{ autoboot: "" }, "boot", ""],
            [{ autochain: "" }, "chain", ""],
            [{ autorun: "" }, "run", ""],
        ])("reads %o as %s", (params, needsAutoboot, autoType) => {
            expect(processAutobootParams(params)).toEqual({ needsAutoboot, autoType });
        });
    });

    describe("bootModeOf", () => {
        it.each([
            [{}, "none"],
            [{ autoboot: true }, "boot"],
            [{ autochain: true }, "chain"],
            [{ autorun: true }, "run"],
            [{ autotype: "HELLO" }, "type"],
            [{ loadBasic: "prog.bas", autorun: true }, "basic"],
            [{ embedBasic: "10 PRINT" }, "basic"],
            [{ loadBasic: "", autoboot: true }, "boot"],
        ])("reads %o as %s", (params, mode) => {
            expect(bootModeOf(params)).toBe(mode);
        });
    });

    describe("parseMediaParams", () => {
        it.each([
            [{ disc: "elite.ssd", disc2: "games.ssd", other: "value" }, ["elite.ssd", "games.ssd", undefined]],
            [{ disc1: "disc1.ssd" }, ["disc1.ssd", undefined, undefined]],
            [{ disc: "old.ssd", disc1: "disc1.ssd" }, ["disc1.ssd", undefined, undefined]],
            [{ mmc: "sdcard.zip" }, [undefined, undefined, "sdcard.zip"]],
        ])("reads %o", (params, [discImage, secondDiscImage, mmcImage]) => {
            expect(parseMediaParams(params)).toEqual({ discImage, secondDiscImage, mmcImage });
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
            expect(parseQueryString(url.substring(1), typesOf({ autoboot: ParamTypes.BOOL }))).toEqual({
                disc1: value,
                autoboot: true,
            });
        });

        it.each(awkwardValues)("should survive a build and parse of %j as a key", (key) => {
            const url = buildUrlFromParams("", { [key]: "value" });
            expect(parseQueryString(url.substring(1))).toEqual({ [key]: "value" });
        });

        it.each(awkwardValues)("should survive a build and parse of %j when it ends the query", (value) => {
            const url = buildUrlFromParams("", { disc1: value });
            expect(parseQueryString(url.substring(1))).toEqual({ disc1: value });
        });
    });

    describe("guessModelFromHostname", () => {
        it.each([
            ["bbc.example.com", "B-DFS1.2"],
            ["bbcmicro.local", "B-DFS1.2"],
            ["master.example.com", "Master"],
            ["mastercompact.local", "Master"],
            ["atom.example.com", "Atom"],
            ["atomulator.local", "Atom"],
            ["example.com", "B-DFS1.2"],
            ["localhost", "B-DFS1.2"],
            ["", "B-DFS1.2"],
        ])("guesses %j is a %s", (hostname, model) => {
            expect(guessModelFromHostname(hostname)).toBe(model);
        });
    });
});
