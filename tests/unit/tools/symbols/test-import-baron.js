import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkSet, readMosSets, SymbolsDir } from "../../../../tools/symbols/build-index.js";
import { BuildLayout } from "../../../../tools/symbols/baron-build.js";
import {
    baronBuild,
    evaluate,
    importBaron,
    operandBase,
    osBlockTargets,
    readBaronBuild,
    symbolsBySource,
    writeSets,
} from "../../../../tools/symbols/import-baron.js";

const ConfigsDir = new URL("../../../../symbols-src/", import.meta.url);
const SetsDir = path.join(SymbolsDir, "sets");

const BytesWidth = 28;
const hex4 = (address) => address.toString(16).toUpperCase().padStart(4, "0");
const statement = (address, bytes, text = "") =>
    `  ${hex4(address)}  ${bytes
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ")
        .padEnd(BytesWidth)}${text}`;
const label = (address, name) => `  ${hex4(address)}  .${name}`;

const listing = [
    statement(0, [], 'INCLUDE "os.6502inc"'),
    "OSWRCH = 65518 [&FFEE]",
    statement(0, [], 'INCLUDE "zp.6502inc"'),
    "counter = 112 [&70]",
    "buffer = 2304 [&0900]",
    "patch = 6421 [&1915]",
    'SECTION prog, filename="PROG", org=&1900, load=&1900, exec=&1900',
    label(0x1900, "prog"),
    "{",
    label(0x1900, "start"),
    statement(0x1900, [0xa9, 0x00], "LDA #0"),
    statement(0x1902, [0x85, 0x70], "STA counter"),
    statement(0x1904, [0x20, 0xee, 0xff], "JSR OSWRCH"),
    statement(0x1907, [0x8d, 0x00, 0x09], "STA buffer"),
    statement(0x190a, [0xa2, 0x05], "LDX #5"),
    statement(0x190c, [0xa0, 0x07], "LDY #7"),
    statement(0x190e, [0xe8], "INX"),
    label(0x190f, "loop"),
    statement(0x190f, [0xb9, 0x00, 0x09], "LDA buffer, Y"),
    statement(0x1912, [0x99, 0x80, 0x09], "STA buffer + &80, Y"),
    statement(0x1915, [0xc6, 0x70], "DEC counter"),
    statement(0x1917, [0xce, 0x15, 0x19], "DEC patch"),
    statement(0x191a, [0xd0, 0xf3], "BNE loop"),
    statement(0x191c, [0x60], "RTS"),
    "}",
    label(0x191d, "prog_end"),
    "ENDSECTION",
].join("\n");

const progDump = {
    format: 2,
    assemblies: [
        {
            sources: ["src/prog.6502", "src/os.6502inc", "src/zp.6502inc"],
            sections: [
                {
                    parent: null,
                    size: 29,
                    assignments: {
                        OSWRCH: { value: 0xffee },
                        counter: { value: 0x70 },
                        buffer: { value: 0x0900 },
                        patch: { value: 0x1915 },
                    },
                },
                {
                    name: "prog",
                    parent: 0,
                    size: 29,
                    attributes: { filename: "PROG", org: 0x1900, load: 0x1900, exec: 0x1900 },
                    labels: {
                        prog: { value: 0x1900 },
                        "prog.start": { value: 0x1900 },
                        "prog.loop": { value: 0x190f },
                        prog_end: { value: 0x191d },
                    },
                },
            ],
        },
    ],
};
const progSymbols = symbolsBySource(progDump);

const config = (regions = [{ name: "main", section: "prog" }]) => ({
    id: "demo",
    licence: "CC0-1.0",
    source: { repository: "https://example.com/demo", commit: "0123abc" },
    madeFrom: ["0123456789abcdef0123456789abcdef"],
    leftToSystemSets: ["os.6502inc"],
    bytesPerAnchor: 2048,
    spreadAnchors: 4,
    sets: [{ id: "prog", title: "Demo", sources: ["prog"], stripScope: "prog", regions }],
});

const build = () => baronBuild(new Map([["prog", listing]]), progSymbols, []);

describe("operandBase", () => {
    it("is the first name of a memory operand", () => {
        expect(operandBase("menu_keys, X")).toBe("menu_keys");
        expect(operandBase("copy_from - 1, Y")).toBe("copy_from");
        expect(operandBase("(copy_return), Y")).toBe("copy_return");
        expect(operandBase("select_sprite.down_not_0f")).toBe("select_sprite.down_not_0f");
        expect(operandBase("&0D00 + work0")).toBe("work0");
    });

    it("is null for an immediate, a FUNCTION's result, a register or nothing", () => {
        expect(operandBase("#LO(event_handler)")).toBeNull();
        expect(operandBase("tile(CELL_FLOOR), X")).toBeNull();
        expect(operandBase("A")).toBeNull();
        expect(operandBase("")).toBeNull();
    });
});

describe("osBlockTargets", () => {
    it("takes a block handed to the OS with LDX #LO(...) in either case", () => {
        const osListing = [
            "SECTION os, org=&2000",
            statement(0x2000, [0xa2, 0x06], "LDX #lo(block)"),
            statement(0x2002, [0xa2, 0x07], "LDX #LO(other)"),
            label(0x2004, "block"),
            statement(0x2004, [0, 0], "EQUW 0"),
            label(0x2006, "other"),
            statement(0x2006, [0, 0], "EQUW 0"),
            "ENDSECTION",
        ].join("\n");
        const osSymbols = { "src/os.6502": { block: 0x2004, other: 0x2006 } };
        const source = baronBuild(new Map([["os", osListing]]), osSymbols, []).sources.get("os");
        expect(osBlockTargets(source)).toEqual(new Set([0x2004, 0x2006]));
    });
});

describe("evaluate", () => {
    const symbols = { start: 0x1900, "pl.encrypted": 0x43c };
    const lookup = (name) => symbols[name];

    it("works out names, &hex, decimal, + - * / and brackets, truncating at the end", () => {
        expect(evaluate("pl.encrypted - 1", lookup)).toBe(0x43b);
        expect(evaluate("start + &700", lookup)).toBe(0x2000);
        expect(evaluate("(start - 1) / 2 * 2", lookup)).toBe(0x18ff);
        expect(evaluate("-4 + 10", lookup)).toBe(6);
        expect(evaluate("7 / 2", lookup)).toBe(3);
        expect(evaluate(4, lookup)).toBe(4);
    });

    it("refuses a name it can't find, or anything but arithmetic", () => {
        expect(() => evaluate("nowhere + 1", lookup)).toThrow("There's no symbol nowhere");
        expect(() => evaluate("start ; 1", lookup)).toThrow("Can't evaluate");
        expect(() => evaluate("(start", lookup)).toThrow("Can't evaluate");
    });
});

describe("importBaron", () => {
    it("makes a set the index accepts, from labels and the `=` names the code uses", () => {
        const { sets, errors } = importBaron(config(), build());
        expect(errors).toEqual([]);
        const [{ file, json }] = sets;
        expect(file).toBe("demo-prog.json");
        expect(checkSet(json, { file: `sets/${file}`, mosSets: [] })).toEqual([]);
        expect(json.source).toBe("https://example.com/demo/tree/0123abc");
        expect(json.regions.main.symbols).toEqual({ start: "0x1900", loop: "0x190f", patch: "0x1915" });
        expect(json.globals).toEqual({ counter: "0x0070", buffer: "0x0900" });
        expect(json.regions.main.minAnchors).toBe(json.regions.main.anchors.length);
    });

    it("leaves out the end label past its region, saying why", () => {
        const { sets } = importBaron(config(), build());
        expect(sets[0].dropped).toEqual([["prog_end", 0x191d, "in no region"]]);
    });

    it("cuts regions where the config's expressions say", () => {
        const regions = [
            { name: "setup", section: "prog", to: "loop" },
            { name: "body", section: "prog", from: "loop" },
        ];
        const { sets } = importBaron(config(regions), build());
        expect(sets[0].json.regions.setup).toMatchObject({
            start: "0x1900",
            end: "0x190f",
            symbols: { start: "0x1900" },
        });
        expect(sets[0].json.regions.body).toMatchObject({ start: "0x190f", end: "0x191d" });
    });

    it("looks a table up in whichever of a set's sources has it", () => {
        const other = [
            "SECTION other, org=&2000",
            label(0x2000, "table"),
            statement(0x2000, [1, 2, 3, 4], "EQUB 1, 2, 3, 4"),
            label(0x2004, "fill"),
            statement(0x2004, [0x9d, 0x00, 0x20], "STA table, X"),
            statement(0x2007, [0xa9, 0x11], "LDA #&11"),
            statement(0x2009, [0xa2, 0x22], "LDX #&22"),
            statement(0x200b, [0xa0, 0x33], "LDY #&33"),
            statement(0x200d, [0x60], "RTS"),
            "ENDSECTION",
        ].join("\n");
        const both = baronBuild(
            new Map([
                ["other", other],
                ["prog", listing],
            ]),
            { ...progSymbols, "src/other.6502": { table: 0x2000, fill: 0x2004 } },
            [],
        );
        const twoSources = (tableSizes) => ({
            ...config(),
            sets: [
                {
                    ...config().sets[0],
                    sources: ["prog", "other"],
                    tableSizes,
                    regions: [
                        { name: "main", section: "prog" },
                        { name: "other", section: "other", source: "other" },
                    ],
                },
            ],
        });
        const { sets, errors } = importBaron(twoSources({ table: "4" }), both);
        expect(errors).toEqual([]);
        expect(sets[0].json.regions.other.anchors.every(({ at }) => parseInt(at, 16) >= 0x2004)).toBe(true);
        expect(() => importBaron(twoSources({ nowhere: "4" }), both)).toThrow("names no symbol: nowhere");
        expect(() => importBaron(twoSources({ fill: "4" }), both)).toThrow("matches no store: fill");
    });

    it("refuses a config naming an INCLUDE no listing has", () => {
        expect(() => importBaron({ ...config(), leftToSystemSets: ["nowhere.inc"] }, build())).toThrow("nowhere.inc");
    });

    it("refuses a listing whose labels the symbol dump disagrees with", () => {
        const moved = { "src/prog.6502": { ...progSymbols["src/prog.6502"], "prog.loop": 0x1910 } };
        expect(() => baronBuild(new Map([["prog", listing]]), moved, [])).toThrow("prog.loop");
    });
});

const namingListing = [
    "counter = 112 [&70]",
    "lives = 114 [&72]",
    "alias = 114 [&72]",
    "local = 6405 [&1905]",
    "cross = 6426 [&191A]",
    "SECTION zp, org=&0000",
    label(0x0000, "zp_ptr"),
    statement(0x0000, [0x00, 0x00], "EQUW 0"),
    label(0x0002, "zp_end"),
    "ENDSECTION",
    'SECTION names, filename="NAMES", org=&1900, load=&1900, exec=&1900',
    label(0x1900, "sub"),
    "{",
    label(0x1900, "entry"),
    statement(0x1900, [0xa9, 0x01], "LDA #1"),
    "}",
    statement(0x1902, [0x85, 0x70], "STA counter"),
    statement(0x1904, [0xe6, 0x72], "INC lives"),
    statement(0x1906, [0xc6, 0x72], "DEC lives"),
    statement(0x1908, [0xa5, 0x72], "LDA alias"),
    statement(0x190a, [0x8d, 0x05, 0x19], "STA local"),
    statement(0x190d, [0xad, 0x1a, 0x19], "LDA cross"),
    label(0x1910, "first"),
    label(0x1910, "second"),
    statement(0x1910, [0xa2, 0x05], "LDX #5"),
    statement(0x1912, [0xa0, 0x09], "LDY #9"),
    statement(0x1914, [0x8e, 0x00, 0x30], "STX &3000"),
    statement(0x1917, [0x60], "RTS"),
    label(0x1918, "mid"),
    statement(0x1918, [0xa5, 0x70], "LDA counter"),
    statement(0x191a, [0xa2, 0x03], "LDX #3"),
    statement(0x191c, [0xa0, 0x04], "LDY #4"),
    statement(0x191e, [0x8d, 0x00, 0x31], "STA &3100"),
    statement(0x1921, [0x60], "RTS"),
    "ENDSECTION",
].join("\n");

const namingSymbols = {
    "src/names.6502": {
        counter: 0x70,
        lives: 0x72,
        alias: 0x72,
        local: 0x1905,
        cross: 0x191a,
        zp_ptr: 0,
        zp_end: 2,
        sub: 0x1900,
        "sub.entry": 0x1900,
        first: 0x1910,
        second: 0x1910,
        mid: 0x1918,
    },
};

const namingConfig = {
    ...config(),
    leftToSystemSets: [],
    sets: [
        {
            id: "names",
            title: "Names",
            sources: ["names"],
            globalsSections: ["zp"],
            regions: [
                { name: "a", section: "names", to: "mid" },
                { name: "b", section: "names", from: "mid" },
            ],
        },
    ],
};

describe("importBaron's names", () => {
    const [set] = importBaron(namingConfig, baronBuild(new Map([["names", namingListing]]), namingSymbols, [])).sets;

    it("gives an address a scope's own name over the labels inside it, then the label written last", () => {
        expect(set.json.regions.a.symbols).toEqual({ sub: "0x1900", local: "0x1905", second: "0x1910" });
        expect(set.json.regions.b.symbols).toEqual({ mid: "0x1918" });
    });

    it("makes a global of a section's labels, of a name used from several regions, and of one another region's code uses", () => {
        expect(set.json.globals).toEqual({ zp_ptr: "0x0000", counter: "0x0070", lives: "0x0072", cross: "0x191a" });
    });

    it("says why each name is left out, keeping the global most instructions use", () => {
        expect(set.dropped).toEqual(
            expect.arrayContaining([
                ["zp_end", 0x0002, "past its section's end"],
                ["sub.entry", 0x1900, "a calls it sub"],
                ["first", 0x1910, "a calls it second"],
                ["alias", 0x0072, "the globals call it lives"],
            ]),
        );
    });

    it("names the `=` addresses the code of a region from another source uses", () => {
        const other = [
            "ptr = 114 [&72]",
            "SECTION other, org=&2000",
            statement(0x2000, [0x85, 0x72], "STA ptr"),
            statement(0x2002, [0xa9, 0x11], "LDA #&11"),
            statement(0x2004, [0xa2, 0x22], "LDX #&22"),
            statement(0x2006, [0x60], "RTS"),
            "ENDSECTION",
        ].join("\n");
        const both = baronBuild(
            new Map([
                ["other", other],
                ["prog", listing],
            ]),
            { ...progSymbols, "src/other.6502": { ptr: 0x72 } },
            [],
        );
        const regions = [
            { name: "main", section: "prog" },
            { name: "other", source: "other", section: "other" },
        ];
        const { sets } = importBaron(config(regions), both);
        expect(sets[0].json.globals.ptr).toBe("0x0072");
    });

    it("refuses a set whose sources give one global name two addresses", () => {
        const other = [
            "counter = 113 [&71]",
            "SECTION other, org=&2000",
            statement(0x2000, [0x85, 0x71], "STA counter"),
            statement(0x2002, [0x60], "RTS"),
            "ENDSECTION",
        ].join("\n");
        const both = baronBuild(
            new Map([
                ["other", other],
                ["prog", listing],
            ]),
            { ...progSymbols, "src/other.6502": { counter: 0x71 } },
            [],
        );
        const twoSources = { ...config(), sets: [{ ...config().sets[0], sources: ["prog", "other"] }] };
        expect(() => importBaron(twoSources, both)).toThrow("names given twice: counter");
    });

    it("refuses a set that would give one name twice", () => {
        const twice = [
            "SECTION s, org=&1900",
            label(0x1900, "s"),
            "{",
            label(0x1900, "x"),
            statement(0x1900, [0xa9, 0x01], "LDA #1"),
            "}",
            label(0x1902, "x"),
            statement(0x1902, [0x60], "RTS"),
            "ENDSECTION",
        ].join("\n");
        const twiceSymbols = { "s.6502": { s: 0x1900, "s.x": 0x1900, x: 0x1902 } };
        const stripped = {
            ...namingConfig,
            sets: [
                {
                    id: "s",
                    title: "S",
                    sources: ["s"],
                    stripScope: "s",
                    regions: [
                        { name: "head", section: "s", to: "x" },
                        { name: "tail", section: "s", from: "x" },
                    ],
                },
            ],
        };
        expect(() => importBaron(stripped, baronBuild(new Map([["s", twice]]), twiceSymbols, []))).toThrow(
            "names given twice: x",
        );
    });
});

describe("symbolsBySource", () => {
    it("takes every group of every section, by each assembly's root file", () => {
        const twoFiles = {
            format: 2,
            assemblies: [
                {
                    sources: ["src/a.6502", "-D DEBUG=1"],
                    sections: [
                        { parent: null, size: 0, defines: { DEBUG: { value: 1 } } },
                        {
                            name: "code",
                            parent: 0,
                            size: 3,
                            labels: { start: { value: 0x1900 } },
                            za_autos: { ptr: { value: 0x70 } },
                            loop_vars: { "@0:12:0.i": { value: 0 } },
                            params: { "@0:40.n": { value: 2 } },
                        },
                    ],
                },
                {
                    sources: ["src/b.6502"],
                    sections: [{ parent: null, size: 0, assignments: { b: { value: "two" } } }],
                },
            ],
        };
        expect(symbolsBySource(twoFiles)).toEqual({
            "src/a.6502": { DEBUG: 1, start: 0x1900, ptr: 0x70, "@0:12:0.i": 0, "@0:40.n": 2 },
            "src/b.6502": { b: "two" },
        });
    });

    it("refuses the flat dump an older baron wrote, and a format it doesn't know", () => {
        expect(() => symbolsBySource({ "src/prog.6502": { prog: 0x1900 } })).toThrow(
            "the flat one baron wrote before 0.5.0.0",
        );
        expect(() => symbolsBySource({ format: 3, assemblies: [] })).toThrow("format 3");
    });
});

describe("readBaronBuild", () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "symbols-read-"));
        for (const sub of Object.values(BuildLayout)) mkdirSync(path.join(dir, sub));
        writeFileSync(path.join(dir, BuildLayout.listings, "prog.txt"), listing, "latin1");
        writeFileSync(path.join(dir, BuildLayout.symbols, "prog.json"), JSON.stringify(progDump));
        writeFileSync(
            path.join(dir, BuildLayout.symbols, "other.json"),
            JSON.stringify({ format: 2, assemblies: [{ sources: ["src/other.6502"], sections: [] }] }),
        );
        writeFileSync(path.join(dir, BuildLayout.files, "PROG"), Buffer.from([0xa9, 0x00]));
        writeFileSync(path.join(dir, BuildLayout.files, "PROG.inf"), "$.PROG FFFF1900 FFFF1900 000002\n");
        writeFileSync(path.join(dir, BuildLayout.files, "NOINF"), Buffer.from([1]));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("reads each listing against its source's symbols, and each file with an .inf where it loads", () => {
        const { sources, files } = readBaronBuild(dir);
        expect([...sources.keys()]).toEqual(["prog"]);
        expect(sources.get("prog").lookup("prog.loop")).toBe(0x190f);
        expect(files).toEqual([{ name: "PROG", load: 0x1900, data: Buffer.from([0xa9, 0x00]) }]);
    });
});

describe("writeSets", () => {
    let out;
    beforeEach(() => {
        out = mkdtempSync(path.join(tmpdir(), "symbols-out-"));
        writeFileSync(path.join(out, "demo-stale.json"), "{}");
        writeFileSync(path.join(out, "other-kept.json"), "{}");
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));

    const imported = () => importBaron(config(), build());

    it("replaces the title's set files with the new sets, leaving other titles' alone", async () => {
        expect(await writeSets(imported(), { out, titleId: "demo", mosSets: [] })).toEqual([]);
        expect(readdirSync(out).sort()).toEqual(["demo-prog.json", "other-kept.json"]);
        expect(JSON.parse(readFileSync(path.join(out, "demo-prog.json"), "utf8")).title).toBe("Demo");
    });

    it("writes nothing, and removes nothing, when the importer or the index's checks found a problem", async () => {
        const failing = imported();
        failing.sets[0].json.licence = "GPL-3.0-or-later";
        const errors = await writeSets(failing, { out, titleId: "demo", mosSets: [] });
        expect(errors).toEqual([expect.stringContaining("demo-prog.json: its licence is GPL-3.0-or-later")]);
        const refused = await writeSets(
            { ...imported(), errors: ["demo/main: nothing to anchor on"] },
            { out, titleId: "demo", mosSets: [] },
        );
        expect(refused).toEqual(["demo/main: nothing to anchor on"]);
        expect(readdirSync(out).sort()).toEqual(["demo-stale.json", "other-kept.json"]);
    });
});

describe("the curator configs", () => {
    const configs = readdirSync(ConfigsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(new URL(name, ConfigsDir), "utf8")));

    it("each have their sets shipped, made from the commit they name", () => {
        expect(configs.length).toBeGreaterThan(0);
        for (const { id, source, sets } of configs)
            for (const spec of sets) {
                const json = JSON.parse(readFileSync(path.join(SetsDir, `${id}-${spec.id}.json`), "utf8"));
                expect(json.source, `${id}-${spec.id}`).toBe(`${source.repository}/tree/${source.commit}`);
                expect(checkSet(json, { file: `sets/${id}-${spec.id}.json`, mosSets: readMosSets() })).toEqual([]);
            }
    });

    it("account for every set shipped under their ids", () => {
        const expected = configs.flatMap(({ id, sets }) => sets.map((spec) => `${id}-${spec.id}.json`)).sort();
        const shipped = readdirSync(SetsDir).filter((name) => configs.some(({ id }) => name.startsWith(`${id}-`)));
        expect(shipped.sort()).toEqual(expected);
    });
});
