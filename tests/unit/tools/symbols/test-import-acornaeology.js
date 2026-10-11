import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseSet } from "../../../../src/symbol-sets.js";
import { regionMatches } from "../../../../src/symbol-names.js";
import { checkSet, readMosSets, SymbolsDir } from "../../../../tools/symbols/build-index.js";
import { importAcornaeology, readDisassembly } from "../../../../tools/symbols/import-acornaeology.js";

const ConfigsDir = new URL("../../../../symbols-src/", import.meta.url);
const Base = 0x8000;
const RomSize = 0x100;
const Pairs = 51;
const OpcodeRts = 0x60;
const SecondHalf = 0x8082;
const LateInLow = 0x8070;

const config = {
    id: "demo",
    importer: "acornaeology",
    title: "Demo ROM",
    licence: "MIT",
    source: {
        repository: "https://github.com/example/demo",
        commit: "0123456789abcdef0123456789abcdef01234567",
        disassembly: "versions/1/output/demo.json",
        licenceFile: "LICENSE",
    },
    rom: "DEMO.ROM",
    globals: [{ start: "0x0000", end: "0x0800" }],
    regions: [
        { name: "low", start: "0x8000", end: "0x8080" },
        { name: "high", start: "0x8080", end: "0x8100" },
    ],
    bytesPerAnchor: 0x80,
    spreadAnchors: 1,
};

/** LDA #n then STA &3000+n, for each n, and an RTS to fill the ROM. */
function items() {
    const out = [];
    for (let n = 0; n < Pairs; n++) {
        out.push({ addr: Base + n * 5, bytes: [0xa9, n], type: "code", mnemonic: "lda" });
        out.push({ addr: Base + n * 5 + 2, bytes: [0x8d, n, 0x30], type: "code", mnemonic: "sta" });
    }
    out.push({ addr: Base + Pairs * 5, bytes: [OpcodeRts], type: "code", mnemonic: "rts" });
    out.find(({ addr }) => addr === Base).labels = ["entry"];
    out.find(({ addr }) => addr === SecondHalf).labels = ["second_half"];
    return out;
}

const disassemblyJson = (overrides = {}) => ({
    meta: { schema_version: 4, load_addr: Base, end_addr: Base + RomSize, title: "Demo" },
    constants: [{ name: "osbyte_read_himem", value: 0x84 }],
    subroutines: [{ addr: Base, name: "entry" }],
    items: items(),
    external_labels: {
        zp_ptr: 0x00,
        zp_ptr_1: 0x01,
        os_text_ptr: 0xf2,
        temps: 0x46c,
        temp1: 0x46c,
        osbyte: 0xfff4,
    },
    memory_map: [
        { addr: 0x00, name: "zp_ptr", length: 2 },
        { addr: 0x46c, name: "temp1", length: 5 },
    ],
    ...overrides,
});

const romOf = (json) => {
    const rom = new Uint8Array(RomSize);
    for (const { addr, bytes } of json.items) rom.set(bytes, addr - Base);
    return rom;
};

const systemGlobals = new Map([[0xf2, "os_text_ptr"]]);

function imported({ json = disassemblyJson(), rom = romOf(json), otherRoms = [] } = {}) {
    return importAcornaeology(config, readDisassembly(json), { rom, otherRoms, systemGlobals, notice: "Notice" });
}

describe("readDisassembly", () => {
    it("reads the statements, the labels and the names outside the ROM", () => {
        const read = readDisassembly(disassemblyJson());
        expect(read.base).toBe(Base);
        expect(read.end).toBe(Base + RomSize);
        expect(read.statements[1]).toEqual({ address: Base + 2, data: [0x8d, 0, 0x30], code: true });
        expect(read.labels).toEqual([
            { address: Base, name: "entry" },
            { address: SecondHalf, name: "second_half" },
        ]);
        expect(read.outside).toContainEqual({ address: 0x46c, name: "temp1", mapped: true });
        expect(read.outside).toContainEqual({ address: 0x46c, name: "temps", mapped: false });
    });

    it("refuses a schema it doesn't know", () => {
        const json = disassemblyJson();
        json.meta.schema_version = 3;
        expect(() => readDisassembly(json)).toThrow("schema version 3, not 4");
    });
});

describe("importAcornaeology", () => {
    it("names each region's addresses from the labels in it", () => {
        const { json, errors } = imported();
        expect(errors).toEqual([]);
        expect(json.regions.low.symbols).toEqual({ entry: "0x8000" });
        expect(json.regions.high.symbols).toEqual({ second_half: "0x8082" });
    });

    it("takes globals only from its ranges, leaving the system sets' addresses to them", () => {
        const { json, dropped } = imported();
        expect(json.globals).toEqual({ zp_ptr: "0x0000", zp_ptr_1: "0x0001", temp1: "0x046c" });
        expect(dropped).toContainEqual(["os_text_ptr", 0xf2, "the system sets call it os_text_ptr"]);
        expect(dropped).toContainEqual(["osbyte", 0xfff4, "it's outside the globals' ranges"]);
    });

    it("prefers the memory map's name for an address with two", () => {
        const { dropped } = imported();
        expect(dropped).toContainEqual(["temps", 0x46c, "the memory map calls it temp1"]);
    });

    it("fails on two names for an address that the memory map doesn't choose between", () => {
        const { errors } = imported({ json: disassemblyJson({ memory_map: [] }) });
        expect(errors).toEqual(["&046C has names temps, temp1 and none to prefer"]);
    });

    it("anchors each region on the ROM's bytes, with as many required as it has", () => {
        const { json } = imported();
        const rom = romOf(disassemblyJson());
        for (const region of parseSet(json).regions) {
            expect(region.anchors.length).toBeGreaterThan(0);
            expect(region.minAnchors).toBe(region.anchors.length);
            expect(regionMatches(region, (address) => rom[address - Base])).toBe(true);
        }
    });

    it("adds an anchor where another ROM differs, in whichever of its banks", () => {
        const anchorsBefore = parseSet(imported().json).regions[0].anchors.length;
        const other = romOf(disassemblyJson());
        other[LateInLow - Base] ^= 0xff;
        const twoBanks = new Uint8Array(RomSize * 2);
        twoBanks.set(other, RomSize);
        const { json, errors } = imported({ otherRoms: [{ name: "BANKS", bytes: twoBanks }] });
        expect(errors).toEqual([]);
        const low = parseSet(json).regions[0];
        expect(low.anchors.length).toBe(anchorsBefore + 1);
        expect(regionMatches(low, (address) => other[address - Base])).toBe(false);
    });

    it("refuses a ROM whose bytes aren't the disassembly's", () => {
        const rom = romOf(disassemblyJson());
        rom[5] ^= 0xff;
        const { json, errors } = imported({ rom });
        expect(json).toBeNull();
        expect(errors).toEqual(["The disassembly's bytes at &8005 aren't DEMO.ROM's"]);
    });

    it("writes a set that passes the index's checks", () => {
        const { json } = imported();
        expect(json.source).toBe(
            `${config.source.repository}/blob/${config.source.commit}/${config.source.disassembly}`,
        );
        expect(checkSet(json, { file: "sets/demo.json", mosSets: [] })).toEqual([]);
    });
});

describe("the acornaeology configs", () => {
    const configs = readdirSync(ConfigsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(new URL(name, ConfigsDir), "utf8")))
        .filter(({ importer }) => importer === "acornaeology");

    it("each have their set shipped, made from the commit they name", () => {
        expect(configs.length).toBeGreaterThan(0);
        for (const { id, source } of configs) {
            const file = `sets/${id}.json`;
            const json = JSON.parse(readFileSync(path.join(SymbolsDir, file), "utf8"));
            expect(json.source, id).toBe(`${source.repository}/blob/${source.commit}/${source.disassembly}`);
            expect(checkSet(json, { file, mosSets: readMosSets() })).toEqual([]);
        }
    });
});
