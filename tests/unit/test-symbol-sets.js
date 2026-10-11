import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fake6502 } from "../../src/fake6502.js";
import { loadData } from "../../src/loader.js";
import { findModel } from "../../src/models.js";
import { nameLinkProblems, nameUrl, parseIndex, parseSet, SymbolSets } from "../../src/symbol-sets.js";

const BaseUrl = "https://symbols.example/symbols/";
const IndexUrl = `${BaseUrl}index.json`;
const SetUrl = `${BaseUrl}sets/game.json`;
const RealSymbols = pathToFileURL("public/symbols/").href;
const OsBase = 0xc000;
const OsSize = 0x4000;

const gameRegions = {
    main: { start: "0x2000", end: "0x2100", anchors: [{ at: "0x2000", bytes: "a9008d01" }] },
};
const index = {
    format: 1,
    sets: [
        { url: "sets/game.json", licence: "CC0-1.0", regions: gameRegions },
        {
            url: "sets/other.json",
            licence: "CC0-1.0",
            regions: { main: { start: "0x3000", end: "0x3100", anchors: [{ at: "0x3000", bytes: "a9008d01" }] } },
        },
    ],
};
const game = {
    format: 1,
    title: "Game",
    licence: "CC0-1.0",
    source: "a test",
    regions: { main: { ...gameRegions.main, symbols: { start: "0x2000" } } },
};

describe("symbol sets", () => {
    describe("parsing", () => {
        it("reads a set's addresses, anchors and names", () => {
            const parsed = parseSet({ ...game, system: true, globals: { lives: "0x70" } });
            expect(parsed.system).toBe(true);
            expect(parsed.globals).toEqual(new Map([[0x70, "lives"]]));
            expect(parsed.regions).toEqual([
                {
                    name: "main",
                    start: 0x2000,
                    end: 0x2100,
                    minAnchors: 1,
                    anchors: [{ at: 0x2000, bytes: new Uint8Array([0xa9, 0x00, 0x8d, 0x01]) }],
                    symbols: new Map([[0x2000, "start"]]),
                },
            ]);
        });

        it("lets only a region's end be 0x10000", () => {
            expect(parseSet({ ...game, regions: { top: { start: "0xff00", end: "0x10000" } } }).regions[0].end).toBe(
                0x10000,
            );
            expect(() => parseSet({ ...game, globals: { past: "0x10000" } })).toThrow("global past");
        });

        it.each([
            ["another format", { format: 2 }, "format 2"],
            ["an address that isn't hex", { globals: { lives: "112" } }, "global lives"],
            ["a region that ends before it starts", { regions: { r: { start: "0x2000", end: "0x2000" } } }, "ends"],
            [
                "anchor bytes that aren't whole bytes",
                { regions: { r: { start: "0x2000", end: "0x2100", anchors: [{ at: "0x2000", bytes: "a90" }] } } },
                "anchor 0's bytes",
            ],
            ["a minAnchors of 0", { regions: { r: { start: "0x2000", end: "0x2100", minAnchors: 0 } } }, "minAnchors"],
        ])("rejects %s", (_, change, message) => {
            expect(() => parseSet({ ...game, ...change })).toThrow(message);
        });

        it("takes only sets that sit beside the index", () => {
            expect(parseIndex(index).map(({ url }) => url)).toEqual(["sets/game.json", "sets/other.json"]);
            for (const url of ["https://elsewhere.example/x.json", "/sets/x.json", "../x.json", "sets/../../x.json"])
                expect(() => parseIndex({ format: 1, sets: [{ url, regions: {} }] })).toThrow("beside the index");
        });

        it("reads the author's page, the name link and the places", () => {
            const parsed = parseSet({
                ...game,
                home: "https://acornaeology.uk/",
                nameLink: "https://example.com/{place}",
                places: { start: "src/game.6502#L12" },
            });
            expect(parsed.home).toBe("https://acornaeology.uk/");
            expect(parsed.nameLink).toBe("https://example.com/{place}");
            expect(parsed.places).toEqual(new Map([["start", "src/game.6502#L12"]]));
            expect(parseSet(game).places).toEqual(new Map());
        });
    });

    describe("a name's place on its author's site", () => {
        const withLink = (nameLink, places = {}) => parseSet({ ...game, nameLink, places });

        it.each([
            [
                "an address anchor",
                "https://acornaeology.uk/bbc-basic/2.html#addr-{addr}",
                {},
                "https://acornaeology.uk/bbc-basic/2.html#addr-800E",
            ],
            [
                "a line of a file at a commit",
                "https://github.com/someone/disasm/blob/0123abc/{place}",
                { start: "src/game.6502#L12" },
                "https://github.com/someone/disasm/blob/0123abc/src/game.6502#L12",
            ],
            [
                "a text fragment",
                "https://www.level7.org.uk/miscellany/game.txt#:~:text={name}",
                {},
                "https://www.level7.org.uk/miscellany/game.txt#:~:text=start",
            ],
        ])("links %s", (_, nameLink, places, url) => {
            expect(nameUrl(withLink(nameLink, places), "start", 0x800e)).toBe(url);
        });

        it("pads the address to four hex digits and encodes the name", () => {
            const set = withLink("https://example.com/{addr}/{name}");
            expect(nameUrl(set, "a b&c", 0x70)).toBe("https://example.com/0070/a%20b%26c");
        });

        it("gives no link without a template, or for a name the template wants a place for and has none", () => {
            expect(nameUrl(parseSet(game), "start", 0x2000)).toBeUndefined();
            expect(nameUrl(withLink("https://example.com/{place}"), "start", 0x2000)).toBeUndefined();
        });

        it("gives no link that isn't https, or whose site a placeholder could change", () => {
            expect(nameUrl(withLink("http://example.com/{name}"), "start", 0x2000)).toBeUndefined();
            expect(nameUrl(withLink("javascript:{name}"), "start", 0x2000)).toBeUndefined();
            expect(nameUrl(withLink("https://{place}", { start: "elsewhere.example/" }), "start", 0)).toBeUndefined();
            expect(nameUrl(withLink("https://example.com{place}", { start: ".evil.example/" }), "start", 0)).toBe(
                undefined,
            );
        });

        it.each([
            ["a good template", "https://example.com/{place}", []],
            ["text that isn't", 7, ["isn't text"]],
            ["no https site first", "http://example.com/{name}", ["https site"]],
            ["a placeholder in the site", "https://{place}/x", ["https site"]],
            ["no placeholder", "https://example.com/", ["no placeholder"]],
            ["an unknown placeholder", "https://example.com/{label}", ["{label}"]],
            ["a stray brace", "https://example.com/{name}}", ["brace"]],
        ])("finds the problems with %s", (_, template, problems) => {
            expect(nameLinkProblems(template)).toEqual(problems.map((problem) => expect.stringContaining(problem)));
        });
    });

    describe("fetching", () => {
        let files;
        let load;
        let now;
        let sets;
        let memory;
        const peek = (address) => memory[address];
        const loaded = () => vi.waitFor(() => expect(load.mock.settledResults.at(-1)?.type).not.toBe("incomplete"));

        beforeEach(() => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            files = new Map([
                [IndexUrl, index],
                [SetUrl, game],
            ]);
            load = vi.fn(async (url) => {
                if (!files.has(url)) throw new Error(`no ${url}`);
                return structuredClone(files.get(url));
            });
            now = 0;
            sets = new SymbolSets({ baseUrl: BaseUrl, load, now: () => now });
            memory = new Uint8Array(0x10000);
            memory.set([0xa9, 0x00, 0x8d, 0x01], 0x2000);
        });

        afterEach(() => vi.restoreAllMocks());

        it("fetches the index the first time names are wanted, then only the sets that match", async () => {
            expect(load).not.toHaveBeenCalled();
            expect(sets.names(peek).sets).toEqual([]);
            await loaded();
            expect(sets.names(peek).sets).toEqual([]);
            await loaded();
            expect(sets.names(peek).operand(0x2000, 0x2000).name).toBe("start");
            expect(load.mock.calls.map(([url]) => url)).toEqual([IndexUrl, SetUrl]);
        });

        it("fetches a set once, however often it's asked for", async () => {
            sets.names(peek);
            await loaded();
            sets.names(peek);
            sets.names(peek);
            await loaded();
            sets.names(peek);
            sets.names(peek);
            expect(load.mock.calls.map(([url]) => url)).toEqual([IndexUrl, SetUrl]);
        });

        it("says when a fetch brings something", async () => {
            const onLoaded = vi.fn();
            sets.addEventListener("loaded", onLoaded);
            sets.names(peek);
            await loaded();
            expect(onLoaded).toHaveBeenCalledTimes(1);
            sets.names(peek);
            await loaded();
            expect(onLoaded).toHaveBeenCalledTimes(2);
        });

        it("leaves plain addresses when the index can't be fetched, and retries later and later, up to a limit", async () => {
            files.delete(IndexUrl);
            const attempts = () => load.mock.calls.length;
            const stopAt = async (ms) => {
                now = ms;
                expect(sets.names(peek).sets).toEqual([]);
                await loaded();
            };
            await stopAt(0);
            await stopAt(4999);
            expect(attempts()).toBe(1);
            await stopAt(5000);
            expect(attempts()).toBe(2);
            await stopAt(5000 + 9999);
            expect(attempts()).toBe(2);
            await stopAt(5000 + 10000);
            expect(attempts()).toBe(3);
            for (let i = 0; i < 10; i++) await stopAt(now + 5 * 60 * 1000);
            expect(attempts()).toBe(13);
            files.set(IndexUrl, index);
            await stopAt(now + 5 * 60 * 1000);
            await stopAt(now);
            expect(sets.names(peek).address(0x2000).name).toBe("start");
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(IndexUrl));
        });

        it("counts a set it can't read as a failed fetch, and an index it can't read too", async () => {
            files.set(SetUrl, { ...game, format: 2 });
            sets.names(peek);
            await loaded();
            sets.names(peek);
            await loaded();
            expect(sets.names(peek).sets).toEqual([]);
            expect(load).toHaveBeenCalledTimes(2);
            now = 5000;
            files.set(SetUrl, game);
            expect(sets.names(peek).sets).toEqual([]);
            await loaded();
            expect(sets.names(peek).sets.map(({ title }) => title)).toEqual(["Game"]);

            const broken = new SymbolSets({ baseUrl: BaseUrl, load: async () => ({ format: 1 }), now: () => now });
            expect(broken.names(peek).sets).toEqual([]);
            await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
            expect(broken.names(peek).sets).toEqual([]);
        });

        it("doesn't fetch a file again while it is still on its way", async () => {
            let arrive;
            load.mockImplementationOnce(() => new Promise((resolve) => (arrive = resolve)));
            sets.names(peek);
            sets.names(peek);
            expect(load).toHaveBeenCalledTimes(1);
            arrive(structuredClone(index));
            await loaded();
            sets.names(peek);
            expect(load.mock.calls.map(([url]) => url)).toEqual([IndexUrl, SetUrl]);
        });

        it("doesn't fetch a set whose regions stop matching before it is asked for", async () => {
            sets.names(peek);
            await loaded();
            memory[0x2000] = 0xea;
            sets.names(peek);
            expect(load.mock.calls.map(([url]) => url)).toEqual([IndexUrl]);
        });
    });

    describe("the MOS 1.20 set", () => {
        const loadReal = vi.fn(async (url) => JSON.parse(new TextDecoder().decode(await loadData(url))));

        const namesFor = async (peek) => {
            loadReal.mockClear();
            const sets = new SymbolSets({ baseUrl: RealSymbols, load: loadReal });
            for (let stop = 0; stop < 3; stop++) {
                sets.names(peek);
                await vi.waitFor(() => expect(loadReal.mock.settledResults.at(-1)?.type).not.toBe("incomplete"));
            }
            return sets.names(peek);
        };

        it("names a B's MOS and hardware, reading memory as the CPU sees it", async () => {
            const cpu = fake6502(findModel("B"));
            await cpu.initialise();
            const names = await namesFor((address) => cpu.peekmem(address));
            const nameOf = (at, target) => names.operand(at, target)?.name;
            expect(names.sets.map(({ title }) => title)).toEqual(["BBC Micro MOS 1.20"]);
            expect(nameOf(0x2000, 0xffee)).toBe("oswrch");
            expect(nameOf(0x2000, 0xfe40)).toBe("system_via_register_b");
            expect(nameOf(0xe0a4, 0x20e)).toBe("wrchv");
            expect(nameOf(0x2000, 0xf2)).toBe("os_text_ptr");
            expect(nameOf(0x2000, 0x20f)).toBeUndefined();
            expect(nameOf(0x2000, 0xe0a4)).toBeUndefined();
            expect(names.address(0xfff4)?.name).toBe("osbyte");
        });

        it("leaves a Master's addresses plain", async () => {
            const cpu = fake6502(findModel("Master"));
            await cpu.initialise();
            const names = await namesFor((address) => cpu.peekmem(address));
            expect(names.sets).toEqual([]);
            expect(names.operand(0x2000, 0xffee)).toBeUndefined();
            expect(loadReal.mock.calls.map(([url]) => url)).toEqual([`${RealSymbols}index.json`]);
        });

        it("leaves an Atom's addresses plain", async () => {
            const cpu = fake6502(findModel("Atom"));
            await cpu.initialise();
            const names = await namesFor((address) => cpu.peekmem(address));
            expect(names.sets).toEqual([]);
        });

        it.each(["bpos.rom", "usmos.rom", "os01.rom", "compact/os51.rom"])(
            "leaves %s's addresses plain",
            async (rom) => {
                const memory = new Uint8Array(0x10000);
                memory.set(readFileSync(`public/roms/${rom}`).subarray(0, OsSize), OsBase);
                const names = await namesFor((address) => memory[address]);
                expect(names.sets).toEqual([]);
            },
        );
    });
});
