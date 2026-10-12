import { describe, expect, it } from "vitest";

import { checkSet } from "../../../../tools/symbols/build-index.js";
import { assemblyDefinitions, importPy8dis, readDump } from "../../../../tools/symbols/import-py8dis.js";

const code = (at, bytes) => ({ at, bytes, code: true });
const data = (at, bytes) => ({ at, bytes, code: false });

// A binary at &2000 whose bytes from &2018 run at &0900, where the loader at &2010 copies them.
const dump = {
    pieces: [
        {
            binary: 0x2000,
            runtime: 0x2000,
            length: 0x10,
            move: 0,
            statements: [
                code(0x2000, [0xa9, 0x00]),
                code(0x2002, [0x85, 0x70]),
                code(0x2004, [0x20, 0x00, 0x09]),
                code(0x2007, [0x8d, 0x00, 0x30]),
                code(0x200a, [0xa2, 0x05]),
                code(0x200c, [0xe8]),
                code(0x200d, [0x4c, 0x0c, 0x20]),
            ],
        },
        {
            binary: 0x2010,
            runtime: 0x2010,
            length: 0x08,
            move: 0,
            statements: [
                code(0x2010, [0xbd, 0x18, 0x20]),
                code(0x2013, [0x9d, 0x00, 0x09]),
                code(0x2016, [0xe8]),
                code(0x2017, [0x60]),
            ],
        },
        {
            binary: 0x2018,
            runtime: 0x0900,
            length: 0x10,
            move: 1,
            statements: [
                code(0x0900, [0xa5, 0x70]),
                code(0x0902, [0x69, 0x01]),
                code(0x0904, [0x85, 0x70]),
                code(0x0906, [0x20, 0xee, 0xff]),
                code(0x0909, [0x60]),
                data(0x090a, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]),
            ],
        },
    ],
    labels: [
        { name: "counter", address: 0x70, move: 0 },
        { name: "screen", address: 0x3000, move: 0 },
        { name: "start", address: 0x2000, move: 0 },
        { name: "entry", address: 0x2000, move: 0 },
        { name: "loop", address: 0x200c, move: 0 },
        { name: "relocate", address: 0x2010, move: 0 },
        { name: "relocate_store", address: 0x2013, move: 0 },
        { name: "bump", address: 0x0900, move: 1 },
        { name: "table", address: 0x090a, move: 1 },
    ],
};

const config = (set = {}) => ({
    id: "demo",
    licence: "Unlicense",
    source: { repository: "https://example.com/demo", commit: "0123abc", script: "demo.py" },
    py8dis: { repository: "https://example.com/py8dis", commit: "4567def" },
    bytesPerAnchor: 2048,
    spreadAnchors: 4,
    sets: [
        {
            id: "prog",
            title: "Demo",
            moves: ["relocate + 3"],
            regions: [
                { name: "main", from: "start" },
                { name: "low", from: "bump" },
            ],
            ...set,
        },
    ],
});

describe("readDump", () => {
    it("puts each label in the piece of its move that holds it, and looks each name up", () => {
        const { pieces, names } = readDump(dump);
        expect(pieces.map(({ start, end }) => [start, end])).toEqual([
            [0x2000, 0x2010],
            [0x2010, 0x2018],
            [0x0900, 0x0910],
        ]);
        expect(pieces[2].labels).toEqual([
            { address: 0x0900, name: "bump" },
            { address: 0x090a, name: "table" },
        ]);
        expect(names.get("start")).toBe(0x2000);
        expect(names.get("counter")).toBe(0x70);
    });

    it("gives each instruction its operand, and each statement its piece", () => {
        const { pieces } = readDump(dump);
        const [jsr] = pieces[0].statements.filter(({ address }) => address === 0x2004);
        expect(jsr).toMatchObject({ data: [0x20, 0x00, 0x09], code: true, skip: false, base: 0x0900 });
        expect(jsr.section).toBe(pieces[0]);
        expect(pieces[2].statements.at(-1).base).toBeUndefined();
    });
});

describe("importPy8dis", () => {
    it("makes a set the index accepts, with names by region and the rest as globals", () => {
        const { sets, errors } = importPy8dis(config(), dump);
        expect(errors).toEqual([]);
        const [{ file, json }] = sets;
        expect(file).toBe("demo-prog.json");
        expect(checkSet(json, { file: `sets/${file}`, mosSets: [] })).toEqual([]);
        expect(json.source).toBe("https://example.com/demo/tree/0123abc");
        expect(json.regions.main).toMatchObject({ start: "0x2000", end: "0x2010" });
        expect(json.regions.main.symbols).toEqual({ start: "0x2000", loop: "0x200c" });
        expect(json.regions.low).toMatchObject({ start: "0x0900", end: "0x0910" });
        expect(json.regions.low.symbols).toEqual({ bump: "0x0900", table: "0x090a" });
        expect(json.globals).toEqual({ counter: "0x0070", screen: "0x3000" });
        for (const region of Object.values(json.regions)) expect(region.minAnchors).toBe(region.anchors.length);
    });

    it("keeps the first name an address is given, and leaves out what no region holds, saying why", () => {
        const { sets } = importPy8dis(config(), dump);
        expect(sets[0].dropped).toEqual([
            ["entry", 0x2000, "main calls it start"],
            ["relocate", 0x2010, "in no region"],
            ["relocate_store", 0x2013, "in no region"],
        ]);
    });

    it("cuts a region where the config's expressions say", () => {
        const regions = [
            { name: "setup", from: "start", to: "loop" },
            { name: "low", from: "bump" },
        ];
        const { sets } = importPy8dis(config({ regions }), dump);
        expect(sets[0].json.regions.setup).toMatchObject({
            start: "0x2000",
            end: "0x200c",
            symbols: { start: "0x2000" },
        });
        expect(sets[0].dropped).toContainEqual(["loop", 0x200c, "in no region"]);
    });

    it("keeps anchors off what a store reaches unless the store is a move", () => {
        const anchoredIn = (moves) =>
            importPy8dis(config({ moves }), dump).sets[0].regions.find(({ name }) => name === "low").anchors;
        expect(anchoredIn(["relocate + 3"]).length).toBeGreaterThan(0);
        expect(importPy8dis(config({ moves: [] }), dump).errors).toEqual(["prog/low: nothing to anchor on"]);
    });

    describe("a move on a copy loop's label", () => {
        const [main, loader, low] = dump.pieces;
        const looping = {
            ...dump,
            pieces: [
                main,
                {
                    ...loader,
                    statements: [
                        code(0x2010, [0xbd, 0x18, 0x20]),
                        code(0x2013, [0x9d, 0x00, 0x09]),
                        code(0x2016, [0xd0, 0xf8]),
                    ],
                },
                low,
            ],
        };
        const overlay = {
            binary: 0x2028,
            runtime: 0x2010,
            length: 0x06,
            move: 2,
            statements: [data(0x2010, [0x00]), code(0x2011, [0x9d, 0x00, 0x09]), code(0x2014, [0xd0, 0xfa])],
        };
        const lowAnchors = (imported) => imported.sets[0].regions.find(({ name }) => name === "low").anchors;

        it("takes the loop's indexed stores", () => {
            const imported = importPy8dis(config({ moves: ["relocate"] }), looping);
            expect(imported.errors).toEqual([]);
            expect(lowAnchors(imported).length).toBeGreaterThan(0);
        });

        it("takes no loop from another piece run at the same address", () => {
            const imported = importPy8dis(config({ moves: ["relocate"] }), {
                ...looping,
                pieces: [...looping.pieces, overlay],
            });
            expect(imported.errors).toEqual(["prog/low: nothing to anchor on"]);
        });
    });

    it("refuses a move or a table that matches no store, and a region no piece holds", () => {
        expect(() => importPy8dis(config({ moves: ["relocate"] }), dump)).toThrow("matches no store: relocate");
        expect(() => importPy8dis(config({ tableSizes: { loop: "4" } }), dump)).toThrow("matches no store: loop");
        expect(() => importPy8dis(config({ regions: [{ name: "far", from: "screen" }] }), dump)).toThrow(
            "0 pieces of the binary run at &3000",
        );
        expect(() => importPy8dis(config({ regions: [{ name: "long", from: "bump", to: "&0A00" }] }), dump)).toThrow(
            "isn't inside piece 2",
        );
    });

    it("refuses a name given to two addresses, even where one is in no region", () => {
        const twice = (label) => ({ ...dump, labels: [...dump.labels, label] });
        expect(() => importPy8dis(config(), twice({ name: "loop", address: 0x0902, move: 1 }))).toThrow(
            "loop names two addresses, &200C and &0902",
        );
        expect(() => importPy8dis(config(), twice({ name: "bump", address: 0x2016, move: 0 }))).toThrow(
            "bump names two addresses",
        );
    });
});

describe("assemblyDefinitions", () => {
    it("finds each name that starts a line, as a label or a constant, with every line it's on", () => {
        const text = [
            "counter = $70",
            "",
            "    * = $2000",
            "start:",
            "    lda #$00 // a: b = c",
            ".loop",
            "    inx",
            "start = loop+1",
        ].join("\n");
        expect(assemblyDefinitions("demo.s", text)).toEqual(
            new Map([
                ["counter", ["demo.s#L1"]],
                ["start", ["demo.s#L4", "demo.s#L8"]],
                ["loop", ["demo.s#L6"]],
            ]),
        );
    });
});

describe("importPy8dis's links", () => {
    const onGitHub = { ...config(), source: { ...config().source, repository: "https://github.com/someone/demo" } };
    const assembly = ["counter = $70", "screen = $3000", "start:", "entry:", "loop:", "bump:", "table:"].join("\n");

    it("links each name to its line in the repository's assembly, for a repository on GitHub", () => {
        const { sets, errors } = importPy8dis(onGitHub, dump, assemblyDefinitions("demo.s", assembly));
        expect(errors).toEqual([]);
        const [{ file, json }] = sets;
        expect(checkSet(json, { file: `sets/${file}`, mosSets: [] })).toEqual([]);
        expect(json.nameLink).toBe("https://github.com/someone/demo/blob/0123abc/{place}");
        expect(json.places).toEqual({
            bump: "demo.s#L6",
            counter: "demo.s#L1",
            loop: "demo.s#L5",
            screen: "demo.s#L2",
            start: "demo.s#L3",
            table: "demo.s#L7",
        });
    });

    it("fails a set with a name the assembly doesn't define once", () => {
        const definitions = assemblyDefinitions("demo.s", `${assembly}\nloop = start`);
        definitions.delete("table");
        expect(importPy8dis(onGitHub, dump, definitions).errors).toEqual([
            "prog: no one place to link for loop, table",
        ]);
    });

    it("links no names without an assembly, or for a repository not on GitHub", () => {
        for (const json of [
            importPy8dis(onGitHub, dump).sets[0].json,
            importPy8dis(config(), dump, assemblyDefinitions("demo.s", assembly)).sets[0].json,
        ]) {
            expect(json.nameLink).toBeUndefined();
            expect(json.places).toBeUndefined();
        }
    });
});
