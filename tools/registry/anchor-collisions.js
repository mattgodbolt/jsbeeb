#!/usr/bin/env node
// How often an anchor-sized run of bytes turns up at the same address in another title, which says
// whether anchors identify code or a disc. Every DFS file on the Stairway To Hell discs is placed at
// its load address as a proxy for memory, and each zip is one title. In each file of 1K or more, up to
// three runs are sampled at seeded random offsets, at least 256 bytes apart, each with at least four
// distinct values in its first six bytes so that fill doesn't count. For each run it counts whether
// its first 4, 6 and 8 bytes reappear at the same address in a file of another title. A file's three
// runs, cut to 6 bytes, are then a region's anchors, which match another title only when one of its
// files holds all three. For every match it gives the share of the source file that is identical at the
// same addresses in the matching file.
//
//   node tools/registry/anchor-collisions.js [--corpus .registry-corpus] [--seed 1] [--examples]
//
// --examples lists every region that matches another title, lowest share first.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzip } from "../../src/archive.js";
import { dfsCatalogue } from "./dfs.js";
import { isSectorImage, sectorImageSides, SectorSize } from "./fingerprint.js";

export const RunLengths = [4, 6, 8];
const MaxRunLength = Math.max(...RunLengths);
export const AnchorLength = 6;
export const AnchorsPerRegion = 3;
export const AnchorSpacing = 256;
// Distinct byte values needed in a run's first AnchorLength bytes for it not to count as fill.
export const MinDistinctBytes = 4;
const TriesPerFile = 60;
const MinFileLength = 64;
const MinSampledFileLength = 1024;
const RamTop = 0x8000;
const PageSize = 256;
// Execution addresses of BASIC programs saved by BASIC II and BASIC I: tokenised text, not code.
const BasicExecAddresses = new Set([0x8023, 0x801f]);
const ShareBuckets = [
    { label: ">= 90%", from: 0.9 },
    { label: "50-90%", from: 0.5 },
    { label: "10-50%", from: 0.1 },
    { label: "< 10%", from: 0 },
];

/** A small deterministic generator (mulberry32), so the sample can be drawn again. */
export function seededRandom(seed) {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Up to AnchorsPerRegion offsets in `data` for runs of MaxRunLength bytes that aren't fill. */
export function pickOffsets(data, random) {
    const picks = [];
    for (let tries = 0; picks.length < AnchorsPerRegion && tries < TriesPerFile; tries++) {
        const offset = Math.floor(random() * (data.length - MaxRunLength + 1));
        if (new Set(data.subarray(offset, offset + AnchorLength)).size < MinDistinctBytes) continue;
        if (picks.some((pick) => Math.abs(pick - offset) < AnchorSpacing)) continue;
        picks.push(offset);
    }
    return picks;
}

/** Whether `file` (placed at its `load` address) holds `bytes` at `address`. */
export function holds(file, address, bytes) {
    const offset = address - file.load;
    if (offset < 0 || offset + bytes.length > file.data.length) return false;
    return bytes.every((byte, i) => file.data[offset + i] === byte);
}

/** Files by each 256-byte page they cover, so a lookup at an address only scans files that reach it. */
export function indexByPage(files) {
    const byPage = Array.from({ length: RamTop / PageSize }, () => []);
    for (const file of files)
        for (let page = file.load >> 8; page <= (file.load + file.data.length - 1) >> 8; page++)
            byPage[page].push(file);
    return byPage;
}

/** The titles other than `title` with a file holding `bytes` at `address`. */
export function titlesHolding(byPage, address, bytes, title) {
    const titles = new Set();
    for (const file of byPage[address >> 8])
        if (file.title !== title && holds(file, address, bytes)) titles.add(file.title);
    return titles;
}

/**
 * For each title other than `title`, its files that hold every one of `anchors` ({address, bytes}),
 * so that anchors held by different files of one title don't make a match.
 */
export function regionMatches(byPage, anchors, title) {
    const matches = new Map();
    const [first, ...rest] = anchors;
    for (const file of byPage[first.address >> 8]) {
        if (file.title === title || !holds(file, first.address, first.bytes)) continue;
        if (!rest.every(({ address, bytes }) => holds(file, address, bytes))) continue;
        if (!matches.has(file.title)) matches.set(file.title, []);
        matches.get(file.title).push(file);
    }
    return matches;
}

/** The share of `source`'s bytes that `other` holds at the same addresses. */
export function identicalShare(source, other) {
    const from = Math.max(source.load, other.load);
    const to = Math.min(source.load + source.data.length, other.load + other.data.length);
    let same = 0;
    for (let address = from; address < to; address++)
        if (source.data[address - source.load] === other.data[address - other.load]) same++;
    return same / source.data.length;
}

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.name.toLowerCase().endsWith(".zip")) out.push(full);
    }
    return out;
}

/** Every title's DFS files that load into RAM, one per content and load address, as {title, name, load, data}. */
async function loadTitles(sthDir) {
    const titles = [];
    for (const zip of (await walk(sthDir)).sort()) {
        let members;
        try {
            members = await unzip(await readFile(zip));
        } catch (error) {
            console.error(`Skipping ${zip}: ${error.message}`);
            continue;
        }
        const title = path.relative(sthDir, zip);
        const seen = new Set();
        const files = [];
        for (const name of Object.keys(members).sort()) {
            if (!isSectorImage(name)) continue;
            for (const side of sectorImageSides(name, members[name])) {
                for (const entry of dfsCatalogue(side)?.files ?? []) {
                    const load = entry.load & 0xffff;
                    if (!entry.complete || entry.uniform || entry.length < MinFileLength) continue;
                    if (BasicExecAddresses.has(entry.exec & 0xffff)) continue;
                    const placement = `${entry.hash}@${load}`;
                    if (load < PageSize || load + entry.length > RamTop || seen.has(placement)) continue;
                    seen.add(placement);
                    const data = side.subarray(entry.start * SectorSize, entry.start * SectorSize + entry.length);
                    files.push({ title, name: `${name}:${entry.name}`, load, data });
                }
            }
        }
        if (files.length) titles.push({ title, files });
    }
    return titles;
}

const hex = (value) => `&${value.toString(16).toUpperCase().padStart(4, "0")}`;
const count = (value) => value.toLocaleString("en-GB");

async function main() {
    const arg = (flag, fallback) => {
        const index = process.argv.indexOf(flag);
        return index > 0 ? process.argv[index + 1] : fallback;
    };
    const corpus = arg("--corpus", ".registry-corpus");
    const random = seededRandom(Number(arg("--seed", "1")));
    const titles = await loadTitles(path.join(corpus, "sth-disc"));
    const allFiles = titles.flatMap((t) => t.files);
    const byPage = indexByPage(allFiles);
    console.log(`${count(titles.length)} titles with ${count(allFiles.length)} distinct files in RAM`);

    const runs = Object.fromEntries(RunLengths.map((length) => [length, { hit: 0, titles: 0 }]));
    let sampled = 0;
    let regions = 0;
    const regionHits = [];
    for (const source of allFiles) {
        if (source.data.length < MinSampledFileLength) continue;
        const offsets = pickOffsets(source.data, random);
        for (const offset of offsets) {
            sampled++;
            for (const length of RunLengths) {
                const others = titlesHolding(
                    byPage,
                    source.load + offset,
                    source.data.subarray(offset, offset + length),
                    source.title,
                );
                if (others.size) runs[length].hit++;
                runs[length].titles += others.size;
            }
        }
        if (offsets.length < AnchorsPerRegion) continue;
        regions++;
        const anchors = offsets.map((offset) => ({
            address: source.load + offset,
            bytes: source.data.subarray(offset, offset + AnchorLength),
        }));
        for (const [title, files] of regionMatches(byPage, anchors, source.title)) {
            const best = files.reduce((a, b) => (identicalShare(source, b) > identicalShare(source, a) ? b : a));
            regionHits.push({ source, title, file: best, share: identicalShare(source, best) });
        }
    }

    console.log(`${count(sampled)} runs sampled`);
    for (const length of RunLengths)
        console.log(
            `  ${length} bytes: ${count(runs[length].hit)} reappear at the same address in another title ` +
                `(${count(runs[length].titles)} titles in all)`,
        );
    const sourcesHit = new Set(regionHits.map((hit) => hit.source));
    console.log(
        `${count(regions)} regions of ${AnchorsPerRegion} ${AnchorLength}-byte anchors; ${count(sourcesHit.size)} ` +
            `match in another title (${count(regionHits.length)} matches, one per other title)`,
    );
    console.log("Share of the source file identical at the same addresses in the matching file:");
    for (const [i, { label, from }] of ShareBuckets.entries()) {
        const to = i ? ShareBuckets[i - 1].from : Infinity;
        console.log(`  ${label}: ${count(regionHits.filter((hit) => hit.share >= from && hit.share < to).length)}`);
    }
    if (process.argv.includes("--examples")) {
        for (const { source, title, file, share } of regionHits.sort((a, b) => a.share - b.share))
            console.log(
                `${(share * 100).toFixed(0).padStart(3)}%  ${source.title} ${source.name} ${hex(source.load)} ` +
                    `+${source.data.length}  ->  ${title} ${file.name} ${hex(file.load)} +${file.data.length}`,
            );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
