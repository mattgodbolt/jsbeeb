import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkSet, readMosSets, SymbolsDir } from "../../../../tools/symbols/build-index.js";
import {
    baronBuild,
    checkBuildCommit,
    environmentWithoutGit,
    evaluate,
    importBaron,
    operandBase,
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

const namingDump = {
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
    const [set] = importBaron(namingConfig, baronBuild(new Map([["names", namingListing]]), namingDump, [])).sets;

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
        const dumped = { "s.6502": { s: 0x1900, "s.x": 0x1900, x: 0x1902 } };
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
        expect(() => importBaron(stripped, baronBuild(new Map([["s", twice]]), dumped, []))).toThrow(
            "names given twice: x",
        );
    });
});

// The throwaway repository must not sign its commits or run hooks from the user's own git config.
const IsolatedGitConfig = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
];

describe("checkBuildCommit", () => {
    let dir;
    const git = (...args) =>
        execFileSync("git", ["-C", dir, ...IsolatedGitConfig, ...args], {
            encoding: "utf8",
            env: environmentWithoutGit(),
        }).trim();

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "symbols-build-"));
        git("init", "-q");
        writeFileSync(path.join(dir, "source.6502"), "RTS\n");
        git("add", ".");
        git("commit", "-q", "-m", "build");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const pinned = (commit) => ({ source: { repository: "https://example.com/r", commit } });

    it("passes a clean checkout at the config's commit", () => {
        expect(() => checkBuildCommit(pinned(git("rev-parse", "HEAD")), dir)).not.toThrow();
    });

    it("looks at the build's checkout even when run from another repository's git hook", () => {
        const head = git("rev-parse", "HEAD");
        vi.stubEnv("GIT_DIR", path.join(tmpdir(), "no-such-repository"));
        vi.stubEnv("GIT_INDEX_FILE", path.join(tmpdir(), "no-such-index"));
        try {
            expect(() => checkBuildCommit(pinned(head), dir)).not.toThrow();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("refuses a checkout at another commit, or with changes or new files", () => {
        const head = git("rev-parse", "HEAD");
        expect(() => checkBuildCommit(pinned("0".repeat(40)), dir)).toThrow(`is at ${head}`);
        writeFileSync(path.join(dir, "new.6502inc"), "X = 1\n");
        expect(() => checkBuildCommit(pinned(head), dir)).toThrow("has changes");
    });

    it("refuses a directory outside any checkout", () => {
        const outside = mkdtempSync(path.join(tmpdir(), "symbols-loose-"));
        try {
            expect(() => checkBuildCommit(pinned("0".repeat(40)), outside)).toThrow("isn't in a git checkout");
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
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
