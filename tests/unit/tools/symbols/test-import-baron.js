import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkSet, readMosSets, SymbolsDir } from "../../../../tools/symbols/build-index.js";
import { baronBuild, evaluate, importBaron, operandBase } from "../../../../tools/symbols/import-baron.js";

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

const dump = {
    "src/prog.6502": {
        OSWRCH: 0xffee,
        counter: 0x70,
        buffer: 0x0900,
        patch: 0x1915,
        prog: 0x1900,
        "prog.start": 0x1900,
        "prog.loop": 0x190f,
        prog_end: 0x191d,
    },
};

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

const build = () => baronBuild(new Map([["prog", listing]]), dump, []);

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

    it("refuses a config naming an INCLUDE no listing has", () => {
        expect(() => importBaron({ ...config(), leftToSystemSets: ["nowhere.inc"] }, build())).toThrow("nowhere.inc");
    });

    it("refuses a listing whose labels the symbol dump disagrees with", () => {
        const moved = { "src/prog.6502": { ...dump["src/prog.6502"], "prog.loop": 0x1910 } };
        expect(() => baronBuild(new Map([["prog", listing]]), moved, [])).toThrow("prog.loop");
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
