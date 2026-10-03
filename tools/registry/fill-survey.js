#!/usr/bin/env node
// Counts which repeated bytes pad the ends of the corpus's sector images, to
// settle whether trimming should accept any repeated byte or only &00 and &E5.
// DFS images only by default; --adfs surveys the ADFS images instead, and the flux captures
// under <corpus>/adfs-hfe (scarybeasts' Master Compact archive) whose first side is ADFS.
//
//   node tools/registry/fill-survey.js [--corpus .registry-corpus] [--adfs]

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import {
    extensionOf,
    imageSides,
    isAdfsSide,
    isFluxImage,
    isSectorImage,
    sectorImageSides,
    trimFill,
} from "./fingerprint.js";

const index = process.argv.indexOf("--corpus");
const corpus = index > 0 ? process.argv[index + 1] : ".registry-corpus";

const DfsExtensions = [".ssd", ".dsd"];
const wantAdfs = process.argv.includes("--adfs");
const surveyed = (name) => isSectorImage(name) && DfsExtensions.includes(extensionOf(name)) !== wantAdfs;

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        out.push(...(entry.isDirectory() ? await walk(full) : [full]));
    }
    return out;
}

function tally(trailing, side) {
    for (const [byte, count] of trimFill(side, { fillBytes: null }).trimmedFill) {
        const entry = trailing.get(byte) ?? { sides: 0, sectors: 0 };
        entry.sides++;
        entry.sectors += count;
        trailing.set(byte, entry);
    }
}

function report(what, sides, trailing) {
    console.log(`${sides} sides of ${what}; trailing runs of one repeated byte:`);
    for (const [byte, { sides: n, sectors }] of [...trailing].sort((a, b) => b[1].sides - a[1].sides))
        console.log(`  &${byte.toString(16).padStart(2, "0")}: ${n} sides, ${sectors} sectors`);
}

async function main() {
    const trailing = new Map();
    let sides = 0;
    for (const file of await walk(corpus)) {
        const members = isSectorImage(file)
            ? { [file]: await readFile(file) }
            : file.toLowerCase().endsWith(".zip") && !file.includes("sth-tape")
              ? await unzip(await readFile(file))
              : {};
        for (const [name, bytes] of Object.entries(members)) {
            if (!surveyed(name)) continue;
            for (const side of sectorImageSides(name, bytes)) {
                sides++;
                tally(trailing, side);
            }
        }
    }
    report("sector images", sides, trailing);
    if (!wantAdfs) return;

    const captured = new Map();
    let capturedSides = 0;
    let discs = 0;
    const compactDir = path.join(corpus, "adfs-hfe");
    for (const name of await readdir(compactDir).catch(() => [])) {
        if (!isFluxImage(name)) continue;
        const { sides: fluxSides } = imageSides(name, await readFile(path.join(compactDir, name)));
        if (!isAdfsSide(fluxSides[0])) continue;
        discs++;
        for (const side of fluxSides) {
            capturedSides++;
            tally(captured, side);
        }
    }
    report(`${discs} flux captures of ADFS discs`, capturedSides, captured);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
