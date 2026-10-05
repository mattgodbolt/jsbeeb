import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseIndex } from "../../../../src/symbol-sets.js";
import { checkSet, indexOf, readMosSets, readSets, SymbolsDir } from "../../../../tools/symbols/build-index.js";

const MosFile = "sets/mos.json";
const GameFile = "sets/game.json";
const mosSets = [MosFile];

const good = () => ({
    format: 1,
    title: "Game",
    licence: "CC0-1.0",
    source: "https://example.com/game.lst",
    madeFrom: ["0123456789abcdef0123456789abcdef"],
    globals: { lives: "0x70" },
    regions: {
        main: {
            start: "0x1900",
            end: "0x3000",
            minAnchors: 2,
            anchors: [
                { at: "0x1900", bytes: "a9008d01" },
                { at: "0x2000", bytes: "20eeff4c00190000" },
            ],
            symbols: { main_loop: "0x1900" },
        },
    },
});

const problemsWith = (change, file = GameFile) => {
    const json = good();
    change(json);
    return checkSet(json, { file, mosSets });
};

describe("the symbol set build", () => {
    describe("the shipped sets", () => {
        it("all pass the build's checks", () => {
            const sets = readSets();
            expect(sets.length).toBeGreaterThan(0);
            const mos = readMosSets();
            for (const { file, json } of sets) expect(checkSet(json, { file, mosSets: mos }), file).toEqual([]);
        });

        it("are what the index lists", () => {
            const index = JSON.parse(readFileSync(path.join(SymbolsDir, "index.json"), "utf8"));
            expect(index).toEqual(indexOf(readSets()));
            expect(parseIndex(index).map(({ url }) => url)).toEqual(readSets().map(({ file }) => file));
        });

        it("are listed without their names", () => {
            expect(JSON.stringify(indexOf(readSets()))).not.toContain("oswrch");
        });
    });

    describe("a set's checks", () => {
        it("pass a good set", () => {
            expect(problemsWith(() => {})).toEqual([]);
        });

        it.each([
            ["no title", (json) => delete json.title, "no title"],
            ["no licence", (json) => delete json.licence, "no licence"],
            ["a GPL licence", (json) => (json.licence = "GPL-3.0-or-later"), "GPL"],
            ["no source", (json) => delete json.source, "source"],
            ["a link", (json) => (json.link = { url: "https://example.com" }), "linked sets"],
            ["madeFrom that isn't keys", (json) => (json.madeFrom = ["exile.ssd"]), "madeFrom"],
            ["no regions", (json) => (json.regions = {}), "no regions"],
            ["an address that isn't one", (json) => (json.globals.lives = "70"), "lives"],
        ])("reject %s", (_, change, message) => {
            expect(problemsWith(change)).toEqual([expect.stringContaining(message)]);
        });

        it.each([
            ["of three bytes", { at: "0x1900", bytes: "a9008d" }, "3 bytes"],
            ["of nine bytes", { at: "0x1900", bytes: "a9008d010203040506" }, "9 bytes"],
            ["before its region", { at: "0x18fe", bytes: "a9008d01" }, "outside"],
            ["past its region's end", { at: "0x2ffe", bytes: "a9008d01" }, "outside"],
        ])("reject an anchor %s", (_, anchor, message) => {
            expect(problemsWith((json) => (json.regions.main.anchors[0] = anchor))).toEqual([
                expect.stringContaining(message),
            ]);
        });

        it("reject an anchor that reads the I/O at &FC00-&FEFF, even in a region over it", () => {
            const problems = problemsWith((json) => {
                json.regions.main.end = "0x10000";
                json.regions.main.anchors[1] = { at: "0xfefe", bytes: "a9008d01" };
            });
            expect(problems).toEqual([expect.stringContaining("&FC00-&FEFF")]);
        });

        it("reject a region with fewer anchors than its minAnchors, but not one with none", () => {
            expect(problemsWith((json) => (json.regions.main.minAnchors = 3))).toEqual([
                expect.stringContaining("fewer than its minAnchors"),
            ]);
            expect(problemsWith((json) => (json.regions.main.anchors = []))).toEqual([]);
        });

        it("reject a file the debugger wouldn't fetch from the index", () => {
            expect(problemsWith(() => {}, "sets/Exile v1.1.json")).toEqual([expect.stringContaining("Exile v1.1")]);
        });

        it("reject a system set the MOS list doesn't name", () => {
            expect(problemsWith((json) => (json.system = true))).toEqual([expect.stringContaining("mos-sets.json")]);
            expect(problemsWith((json) => (json.system = true), MosFile)).toEqual([]);
        });

        it("reject a region name for an address outside the region", () => {
            expect(problemsWith((json) => (json.regions.main.symbols.later = "0x3000"))).toEqual([
                expect.stringContaining("outside it"),
            ]);
        });

        it("reject a name used twice in the set", () => {
            expect(problemsWith((json) => (json.globals.main_loop = "0x80"))).toEqual([
                expect.stringContaining("main_loop is named in the globals and again in region main"),
            ]);
        });

        it("reject two names for one address in the globals or in a region, but not one in each", () => {
            expect(problemsWith((json) => (json.globals.lives_too = "0x70"))).toEqual([
                expect.stringContaining("&0070 has two names in the globals"),
            ]);
            expect(problemsWith((json) => (json.regions.main.symbols.entry = "0x1900"))).toEqual([
                expect.stringContaining("&1900 has two names in region main"),
            ]);
            expect(problemsWith((json) => (json.globals.table = "0x1900"))).toEqual([]);
        });
    });
});
