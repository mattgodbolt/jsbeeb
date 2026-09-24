#!/usr/bin/env node
// Compares two images sector by sector, after each has been turned into its
// sides' bytes the way the fingerprint does, and says where the differences sit
// in DFS terms: the catalogue, a file (by name), or free space.
//
//   node tools/registry/diff-images.js <ref> <ref> [--corpus .registry-corpus]
//
// A ref is a path under the corpus, with `#member` for a file inside a zip.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import { dfsCatalogue } from "./dfs.js";
import { imageSides, SectorSize, trimFill } from "./fingerprint.js";

export async function loadRef(corpus, ref) {
    const [file, member] = ref.split("#");
    const candidates = ["", "hfe", "sth-disc", "bbcmicro"].map((dir) => path.join(corpus, dir, file));
    for (const candidate of candidates) {
        let bytes;
        try {
            bytes = await readFile(candidate);
        } catch {
            continue;
        }
        if (!member) return { name: file, bytes };
        return { name: member, bytes: (await unzip(bytes))[member] };
    }
    throw new Error(`No such image in the corpus: ${ref}`);
}

function owner(catalogue, sector) {
    if (sector < 2) return "catalogue";
    for (const file of catalogue?.files ?? []) {
        const sectors = Math.ceil(file.length / SectorSize);
        if (sector >= file.start && sector < file.start + sectors) return file.name;
    }
    return "free space";
}

export async function diffImages(corpus, refA, refB) {
    const [a, b] = await Promise.all([loadRef(corpus, refA), loadRef(corpus, refB)]);
    const sidesA = imageSides(a.name, a.bytes).sides;
    const sidesB = imageSides(b.name, b.bytes).sides;
    const report = [];
    for (let side = 0; side < Math.max(sidesA.length, sidesB.length); ++side) {
        const bytesA = trimFill(sidesA[side] ?? Buffer.alloc(0)).data;
        const bytesB = trimFill(sidesB[side] ?? Buffer.alloc(0)).data;
        const catalogue = dfsCatalogue(bytesA) ?? dfsCatalogue(bytesB);
        const sectors = Math.max(bytesA.length, bytesB.length) / SectorSize;
        const where = new Map();
        for (let sector = 0; sector < sectors; ++sector) {
            const sa = bytesA.subarray(sector * SectorSize, (sector + 1) * SectorSize);
            const sb = bytesB.subarray(sector * SectorSize, (sector + 1) * SectorSize);
            if (Buffer.compare(sa, sb) === 0) continue;
            const key = owner(catalogue, sector);
            where.set(key, [...(where.get(key) ?? []), sector]);
        }
        report.push({ side, lengths: [bytesA.length, bytesB.length], differences: Object.fromEntries(where) });
    }
    return report;
}

async function main() {
    const args = process.argv.slice(2);
    const corpusIndex = args.indexOf("--corpus");
    const corpus = corpusIndex >= 0 ? args.splice(corpusIndex, 2)[1] : ".registry-corpus";
    const log = console.log;
    console.log = () => {};
    const report = await diffImages(corpus, args[0], args[1]);
    console.log = log;
    console.log(JSON.stringify(report, null, 1));
}

if (process.argv[1]?.endsWith("diff-images.js")) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
