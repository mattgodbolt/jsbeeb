#!/usr/bin/env node
// Counts which repeated bytes pad the ends of the corpus's sector images, to
// settle whether trimming should accept any repeated byte or only &00 and &E5.
//
//   node tools/registry/fill-survey.js [--corpus .registry-corpus]

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import { isSectorImage, sectorImageSides, trimFill } from "./fingerprint.js";

const index = process.argv.indexOf("--corpus");
const corpus = index > 0 ? process.argv[index + 1] : ".registry-corpus";

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        out.push(...(entry.isDirectory() ? await walk(full) : [full]));
    }
    return out;
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
            if (!isSectorImage(name)) continue;
            for (const side of sectorImageSides(name, bytes)) {
                sides++;
                const { trimmedFill } = trimFill(side, { fillBytes: null });
                for (const [byte, count] of trimmedFill) {
                    const entry = trailing.get(byte) ?? { sides: 0, sectors: 0 };
                    entry.sides++;
                    entry.sectors += count;
                    trailing.set(byte, entry);
                }
            }
        }
    }
    console.log(`${sides} sides of sector images; trailing runs of one repeated byte:`);
    for (const [byte, { sides: n, sectors }] of [...trailing].sort((a, b) => b[1].sides - a[1].sides))
        console.log(`  &${byte.toString(16).padStart(2, "0")}: ${n} sides, ${sectors} sectors`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
