#!/usr/bin/env node
/**
 * Makes public/symbols/sets/bbc-b-mos-1.20.json, the BBC Micro's MOS 1.20 as a system symbol set:
 * the names py8dis's acorn.py gives a BBC Micro (its bbc()), in regions anchored on
 * public/roms/os.rom. Fetches acorn.py and its licence at a fixed commit, and needs python3 to run
 * acorn.py's labelling.
 *
 * Usage: node tools/symbols/make-mos-set.js && node tools/symbols/build-index.js
 *
 * It refuses to write a set whose regions would also match another MOS in public/roms/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cpu6502 } from "../../src/6502.opcodes.js";
import { parseSet } from "../../src/symbol-sets.js";
import { regionMatches } from "../../src/symbol-names.js";
import { formatJson, SymbolsDir } from "./build-index.js";

const Py8disCommit = "5da0ecb47c54ff5afe62a8e62c03eca4ec42ccac";
const Py8disRaw = `https://raw.githubusercontent.com/ZornsLemma/py8dis/${Py8disCommit}`;
const AcornPy = "py8dis/acorn.py";
const SetFile = "sets/bbc-b-mos-1.20.json";

const RomsDir = fileURLToPath(new URL("../../public/roms/", import.meta.url));
const OsRom = "os.rom";
const OtherMosImages = ["bpos.rom", "usmos.rom", "os01.rom", "master/mos3.20", "compact/os51.rom"];
const RomBase = 0xc000;
const RomSize = 0x4000;
const KeyHexDigits = 32;

const MinAnchorBytes = 4;
const MaxAnchorBytes = 8;
const MinAnchors = 2;

// The code anchors start at the reset and IRQ entries, the default RDCHV, WRCHV and FILEV handlers
// and osrdsc's jump; the data anchor is the 6502's NMI, RESET and IRQ vectors.
const Regions = {
    main: { start: 0xc000, end: 0xfc00, codeAnchors: [0xd9cd, 0xdc1c, 0xdec5, 0xe0a4, 0xf27d] },
    "top-page": { start: 0xff00, end: 0x10000, codeAnchors: [0xffb9], dataAnchors: [{ at: 0xfffa, length: 6 }] },
};

const address = (value) => `0x${value.toString(16)}`;
const hexBytes = (bytes) => Buffer.from(bytes).toString("hex");

async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetching ${url} failed with ${response.status}`);
    return response.text();
}

function acornLabels(acornSource) {
    const dir = mkdtempSync(path.join(tmpdir(), "acorn-"));
    try {
        const acornFile = path.join(dir, "acorn.py");
        writeFileSync(acornFile, acornSource);
        const script = fileURLToPath(new URL("acorn-labels.py", import.meta.url));
        return JSON.parse(execFileSync("python3", [script, acornFile], { encoding: "utf8" }));
    } finally {
        rmSync(dir, { recursive: true });
    }
}

/** The longest run of whole instructions from `at` that an anchor can hold. */
function codeAnchor(rom, at) {
    const { disassembler } = Cpu6502({ peekmem: (addr) => rom[addr - RomBase] });
    let end = at;
    let next = disassembler.nextInstruction(at);
    while (next - at <= MaxAnchorBytes) {
        end = next;
        next = disassembler.nextInstruction(next);
    }
    if (end - at < MinAnchorBytes) throw new Error(`The instructions at ${address(at)} don't make an anchor`);
    return { at, length: end - at };
}

function regionsFor(rom, labels) {
    return Object.fromEntries(
        Object.entries(Regions).map(([name, { start, end, codeAnchors, dataAnchors = [] }]) => {
            const anchors = [...codeAnchors.map((at) => codeAnchor(rom, at)), ...dataAnchors].map(({ at, length }) => ({
                at: address(at),
                bytes: hexBytes(rom.subarray(at - RomBase, at - RomBase + length)),
            }));
            const symbols = labels.filter(([value]) => value >= start && value < end);
            return [
                name,
                {
                    start: address(start),
                    end: address(end),
                    minAnchors: MinAnchors,
                    anchors,
                    ...(symbols.length && { symbols: namesOf(symbols) }),
                },
            ];
        }),
    );
}

function namesOf(labels) {
    return Object.fromEntries([...labels].sort(([a], [b]) => a - b).map(([value, name]) => [name, address(value)]));
}

function checkAnchorsUnique(rom, set) {
    for (const region of set.regions) {
        const bytes = Buffer.from(
            rom.subarray(region.start - RomBase, Math.min(region.end, RomBase + RomSize) - RomBase),
        );
        for (const anchor of region.anchors) {
            const first = bytes.indexOf(anchor.bytes);
            if (bytes.indexOf(anchor.bytes, first + 1) !== -1)
                throw new Error(`The anchor at ${address(anchor.at)} appears more than once in region ${region.name}`);
        }
    }
}

function checkOtherMosImagesDontMatch(set) {
    for (const other of OtherMosImages) {
        const rom = readFileSync(path.join(RomsDir, other)).subarray(0, RomSize);
        for (const region of set.regions)
            if (regionMatches(region, (addr) => rom[addr - RomBase]))
                throw new Error(`Region ${region.name} also matches ${other}`);
    }
}

async function main() {
    const [acornSource, licence] = await Promise.all([
        fetchText(`${Py8disRaw}/${AcornPy}`),
        fetchText(`${Py8disRaw}/LICENSE`),
    ]);
    const rom = readFileSync(path.join(RomsDir, OsRom));
    const labels = acornLabels(acornSource);
    const inRegion = ([value]) => Object.values(Regions).some(({ start, end }) => value >= start && value < end);
    const source = `https://github.com/ZornsLemma/py8dis/blob/${Py8disCommit}/${AcornPy}`;
    const json = {
        format: 1,
        title: "BBC Micro MOS 1.20",
        licence: "MIT",
        source,
        notice: `The names are py8dis's, from ${source}, under this licence:\n\n${licence.trim()}`,
        madeFrom: [createHash("sha256").update(rom).digest("hex").slice(0, KeyHexDigits)],
        system: true,
        globals: namesOf(labels.filter((label) => !inRegion(label))),
        regions: regionsFor(rom, labels),
    };
    const set = parseSet(json);
    checkAnchorsUnique(rom, set);
    checkOtherMosImagesDontMatch(set);
    const file = path.join(SymbolsDir, SetFile);
    writeFileSync(file, await formatJson(json, file));
    console.log(`Wrote ${SetFile} with ${labels.length} names`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
