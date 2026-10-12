import { describe, expect, it } from "vitest";

import { PrintPrefix } from "../../../../tools/symbols/beebasm-build.js";
import { checkSet, readMosSets } from "../../../../tools/symbols/build-index.js";
import {
    beebasmBuild,
    discFilesOf,
    importBeebasm,
    osBlockTargets,
    savedStart,
    systemAddresses,
} from "../../../../tools/symbols/import-beebasm.js";

const BytesWidth = 11;
const hex2 = (byte) => byte.toString(16).toUpperCase().padStart(2, "0");
const hex4 = (address) => address.toString(16).toUpperCase().padStart(4, "0");
const instruction = (address, bytes, text) =>
    `     ${hex4(address)}   ${bytes.map(hex2).join(" ").padEnd(BytesWidth)}${text}`;
const data = (address, bytes) => `     ${hex4(address)}   ${bytes.map(hex2).join(" ")}`;
const printed = (name, value) => `${PrintPrefix}:${name}:${value} `;

// PROG at &1900, then OVER assembled over PROG's last bytes (after a CLEAR) and saved from there.
const prog = [
    0xa9, 0x05, 0x85, 0x70, 0x20, 0xee, 0xff, 0xa2, 0x18, 0xa0, 0x19, 0x8d, 0x17, 0x19, 0x4c, 0x16, 0x19, 0x60, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x00, 0x00, 0x00,
];
const over = [0xa0, 0x07, 0x88, 0xd0, 0xfd, 0x60];
const listing = [
    ".start",
    instruction(0x1900, [0xa9, 0x05], "LDA #&05"),
    instruction(0x1902, [0x85, 0x70], "STA &70"),
    ".loop",
    instruction(0x1904, [0x20, 0xee, 0xff], "JSR &FFEE"),
    instruction(0x1907, [0xa2, 0x18], "LDX #&18"),
    instruction(0x1909, [0xa0, 0x19], "LDY #&19"),
    instruction(0x190b, [0x8d, 0x17, 0x19], "STA &1917"),
    instruction(0x190e, [0x4c, 0x16, 0x19], "JMP &1916"),
    ".inner",
    instruction(0x1911, [0x60], "RTS"),
    ".pad",
    ".block",
    data(0x1918, [0x01]),
    data(0x1919, [0x02]),
    ".text",
    "     191A   48 45 4C ...",
    ".work",
    "     191F",
    ".prog_end",
    "Saving file 'PROG'",
    ".over",
    instruction(0x191a, [0xa0, 0x07], "LDY #&07"),
    instruction(0x191c, [0x88], "DEY"),
    instruction(0x191d, [0xd0, 0xfd], "BNE &191C"),
    instruction(0x191f, [0x60], "RTS"),
    "Saving file 'out/OVER'",
    printed("ptr", 112),
    printed("ALIAS", 112),
    printed("buf", 6423),
    printed("jump_to", 6422),
    printed("OSWRCH", 65518),
    printed("KEY", 16),
    `${PrintPrefix}:greeting:hi`,
    `${PrintPrefix}:blank: `,
].join("\n");
const dump =
    "[{'.start':6400L,'.start.loop':6404L,'._3.inner':6417L,'.pad':6422L,'.block':6424L,'.text':6426L,'.work':6431L," +
    "'.prog_end':6434L,'.over':6426L}]";
const made = (operandNames = ["ptr", "buf", "OSWRCH", "jump_to"]) => ({
    listing,
    dump,
    saved: new Map([
        ["PROG", Uint8Array.from(prog)],
        ["out/OVER", Uint8Array.from(over)],
    ]),
    names: ["ptr", "ALIAS", "buf", "jump_to", "OSWRCH", "KEY", "greeting", "blank"],
    operandNames: new Set(operandNames),
    definitions: new Map([
        ["start", ["src/prog.asm#L3"]],
        ["loop", ["src/prog.asm#L6"]],
        ["pad", ["src/prog.asm#L12"]],
        ["block", ["src/prog.asm#L13"]],
        ["text", ["src/prog.asm#L15"]],
        ["work", ["src/prog.asm#L16"]],
        ["ptr", ["src/zp.asm#L1"]],
        ["buf", ["src/zp.asm#L2", "src/other.asm#L9"]],
    ]),
});

const config = (regions = [{ name: "main", file: "PROG" }]) => ({
    id: "demo",
    licence: "CC0-1.0",
    source: { repository: "https://example.com/demo", commit: "0123abc", assembler: "beebasm" },
    bytesPerAnchor: 2048,
    spreadAnchors: 4,
    sets: [{ id: "prog", title: "Demo", regions }],
});
const system = new Set([0xffee]);

describe("beebasmBuild", () => {
    const build = beebasmBuild(made());
    const progFile = build.files.get("PROG");
    const overFile = build.files.get("out/OVER");

    it("finds where each saved file starts, and keeps its SAVE's name", () => {
        expect([progFile.start, progFile.end]).toEqual([0x1900, 0x1922]);
        expect([overFile.start, overFile.end]).toEqual([0x191a, 0x1920]);
    });

    it("gives each file the statements in memory when it was saved", () => {
        expect(progFile.statements.map((s) => s.address)).toEqual([
            0x1900, 0x1902, 0x1904, 0x1907, 0x1909, 0x190b, 0x190e, 0x1911, 0x1918, 0x1919, 0x191a, 0x191f,
        ]);
        expect(overFile.statements.map((s) => s.address)).toEqual([0x191a, 0x191c, 0x191d, 0x191f]);
        expect(overFile.statements.every((s) => s.section === overFile)).toBe(true);
    });

    it("takes the bytes the listing cuts short from the file, up to the next statement or label", () => {
        const text = progFile.statements.find((s) => s.address === 0x191a);
        expect(text.data).toEqual([0x48, 0x45, 0x4c, 0x4c, 0x4f]);
        const work = progFile.statements.find((s) => s.address === 0x191f);
        expect(work).toMatchObject({ skip: true, data: [0, 0, 0] });
    });

    it("puts each label in the file whose statement follows it, or ends with it", () => {
        expect(progFile.labels.map(({ name }) => name)).toEqual([
            "start",
            "start.loop",
            "_3.inner",
            "pad",
            "block",
            "text",
            "work",
        ]);
        expect(overFile.labels.map(({ name }) => name)).toEqual(["over"]);
    });

    it("keeps the `=` names whose values are numbers", () => {
        expect([...build.constants]).toEqual([
            ["ptr", 0x70],
            ["ALIAS", 0x70],
            ["buf", 0x1917],
            ["jump_to", 0x1916],
            ["OSWRCH", 0xffee],
            ["KEY", 0x10],
        ]);
    });

    it("refuses a dump that doesn't agree with the listing's labels", () => {
        expect(() => beebasmBuild({ ...made(), dump: dump.replace("'.block'", "'.blob'") })).toThrow("is .blob");
        expect(() => beebasmBuild({ ...made(), dump: "[{'.start':6400L}]" })).toThrow("labels");
    });
});

describe("savedStart", () => {
    const statement = (address, bytes) => ({ address, bytes });
    const inMemory = [statement(0x2000, [1, 2]), statement(0x2002, [3, 4]), statement(0x2004, [5, 6])];

    it("is the start that agrees with and covers the most statements", () => {
        expect(savedStart("F", Uint8Array.from([1, 2, 3, 4, 5, 6]), inMemory, [])).toBe(0x2000);
        expect(savedStart("F", Uint8Array.from([3, 4, 5, 6]), inMemory, [])).toBe(0x2002);
        expect(savedStart("F", Uint8Array.from([0, 0, 1, 2]), inMemory, [0x1ffe])).toBe(0x1ffe);
    });

    it("refuses a file that agrees with nothing, or that could start in more than one place", () => {
        expect(() => savedStart("F", Uint8Array.from([9, 9]), inMemory, [])).toThrow("F agrees with no statement");
        const repeated = [statement(0x2000, [1, 2]), statement(0x2002, [1, 2])];
        expect(() => savedStart("F", Uint8Array.from([1, 2]), repeated, [])).toThrow("could start at any of");
    });
});

describe("osBlockTargets", () => {
    it("takes an LDX #lo and LDY #hi together, in either order, that make a label's address", () => {
        const file = beebasmBuild(made()).files.get("PROG");
        expect(osBlockTargets(file, new Set([0x1918]))).toEqual(new Set([0x1918]));
        expect(osBlockTargets(file, new Set([0x1919]))).toEqual(new Set());
        const swapped = {
            statements: [
                { address: 0x2000, code: true, data: [0xa0, 0x19] },
                { address: 0x2002, code: true, data: [0xa2, 0x18] },
            ],
        };
        expect(osBlockTargets(swapped, new Set([0x1918]))).toEqual(new Set([0x1918]));
    });
});

describe("importBeebasm", () => {
    const imported = (options = {}) =>
        importBeebasm(config(options.regions), beebasmBuild(made(options.operandNames)), { system });

    it("names a region from its file's labels, leaving out those in scopes beebasm named", () => {
        const { sets, errors } = imported();
        expect(errors).toEqual([]);
        const { json, dropped } = sets[0];
        expect(json.regions.main.symbols).toEqual({
            start: "0x1900",
            "start.loop": "0x1904",
            pad: "0x1916",
            buf: "0x1917",
            block: "0x1918",
            text: "0x191a",
            work: "0x191f",
        });
        expect(dropped).toContainEqual(["_3.inner", 0x1911, "in a scope beebasm names itself"]);
    });

    it("takes a `=` name the source writes as a memory operand whose value the set's code uses", () => {
        const { json, dropped } = imported().sets[0];
        expect(json.globals).toEqual({ ptr: "0x0070" });
        expect(json.regions.main.symbols.buf).toBe("0x1917");
        expect(dropped).toContainEqual(["OSWRCH", 0xffee, "left to the MOS set"]);
        expect(dropped).toContainEqual(["jump_to", 0x1916, "a label names its address"]);
        expect(dropped.map(([name]) => name)).not.toContain("KEY");
    });

    it("puts a `=` name in the globals when code outside its region uses it", () => {
        const regions = [
            { name: "code", file: "PROG", to: "pad" },
            { name: "data", file: "PROG", from: "pad" },
        ];
        const { json } = imported({ regions, operandNames: ["ptr", "buf"] }).sets[0];
        expect(json.globals).toEqual({ ptr: "0x0070", buf: "0x1917" });
        expect(json.regions.data.symbols.buf).toBeUndefined();
    });

    it("leaves out every name of a value two such names share", () => {
        const { json, dropped } = imported({ operandNames: ["ptr", "ALIAS", "buf"] }).sets[0];
        expect(json.globals).toEqual({});
        expect(dropped).toContainEqual(["ALIAS", 0x70, "ptr, ALIAS have the same value"]);
    });

    it("cuts a region with expressions in the source's names", () => {
        const { json } = imported({ regions: [{ name: "code", file: "PROG", to: "block" }] }).sets[0];
        expect([json.regions.code.start, json.regions.code.end]).toEqual(["0x1900", "0x1918"]);
        expect(json.regions.code.symbols).toEqual({
            start: "0x1900",
            "start.loop": "0x1904",
            pad: "0x1916",
            buf: "0x1917",
        });
    });

    it("makes a set the index's checks accept, anchored away from its OS block", () => {
        const { json, regions } = imported().sets[0];
        expect(checkSet(json, { file: "sets/demo-prog.json", mosSets: readMosSets() })).toEqual([]);
        const covered = regions[0].anchors.flatMap(({ at, data }) => data.map((_, i) => at + i));
        expect(covered).not.toContain(0x1918);
        expect(covered).not.toContain(0x1919);
    });

    it("refuses a region outside its file, and a file nothing saves", () => {
        expect(() => imported({ regions: [{ name: "x", file: "PROG", to: "prog_end + 1" }] })).toThrow("isn't inside");
        expect(() => imported({ regions: [{ name: "x", file: "NOPE" }] })).toThrow("Nothing is saved as NOPE");
    });

    it("adds an anchor where a file of the original disc that holds the others differs", () => {
        const plain = imported().sets[0].regions[0].anchors;
        const covered = new Set(plain.flatMap(({ at, data }) => data.map((_, i) => at + i)));
        const changed = 0x190f;
        expect(covered.has(changed)).toBe(false);
        const disc = Uint8Array.from(prog);
        disc[changed - 0x1900] ^= 0xff;
        const discFiles = [{ name: "d.ssd:$.PROG", load: 0x1900, data: disc }];
        const { sets, reasons } = importBeebasm(config(), beebasmBuild(made()), { discFiles, system });
        const anchors = sets[0].regions[0].anchors;
        expect(anchors).toHaveLength(plain.length + 1);
        expect(anchors.some(({ at, data }) => changed >= at && changed < at + data.length)).toBe(true);
        expect(reasons).toEqual([expect.stringContaining("for disc d.ssd:$.PROG")]);
        const same = [{ name: "d.ssd:$.PROG", load: 0x1900, data: Uint8Array.from(prog) }];
        expect(importBeebasm(config(), beebasmBuild(made()), { discFiles: same, system }).reasons).toEqual([]);
    });

    describe("for a repository on GitHub", () => {
        const onGitHub = {
            ...config(),
            source: { ...config().source, repository: "https://github.com/someone/demo" },
        };
        const placed = () => {
            const build = beebasmBuild(made());
            build.definitions.set("buf", ["src/zp.asm#L2"]);
            return importBeebasm(onGitHub, build, { system });
        };

        it("links each name to the line that defines it, a scoped one by its label", () => {
            const { sets, errors } = placed();
            expect(errors).toEqual([]);
            const [{ file, json }] = sets;
            expect(checkSet(json, { file: `sets/${file}`, mosSets: readMosSets() })).toEqual([]);
            expect(json.nameLink).toBe("https://github.com/someone/demo/blob/0123abc/{place}");
            expect(json.places).toEqual({
                block: "src/prog.asm#L13",
                buf: "src/zp.asm#L2",
                pad: "src/prog.asm#L12",
                ptr: "src/zp.asm#L1",
                start: "src/prog.asm#L3",
                "start.loop": "src/prog.asm#L6",
                text: "src/prog.asm#L15",
                work: "src/prog.asm#L16",
            });
        });

        it("fails a set with a name defined in more than one place", () => {
            expect(importBeebasm(onGitHub, beebasmBuild(made()), { system }).errors).toEqual([
                "prog: no one place to link for buf",
            ]);
        });
    });

    it("links no names for a repository not on GitHub", () => {
        const { json } = imported().sets[0];
        expect(json.nameLink).toBeUndefined();
        expect(json.places).toBeUndefined();
    });

    it("makes no sets from a config with no licence", () => {
        const { licence: _licence, ...unlicensed } = config();
        expect(() => importBeebasm(unlicensed, beebasmBuild(made()), { system })).toThrow("gives no licence");
    });
});

describe("discFilesOf", () => {
    it("has nothing for a config that names no disc", () => {
        expect(discFilesOf(config(), "/nowhere")).toEqual([]);
    });
});

describe("systemAddresses", () => {
    it("holds what the MOS set names", () => {
        const addresses = systemAddresses();
        expect(addresses.has(0xffee)).toBe(true);
        expect(addresses.has(0xfe40)).toBe(true);
    });
});
