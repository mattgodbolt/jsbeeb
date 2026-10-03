#!/usr/bin/env node
// Flux captures and FSD dumps whose tracks repeat a sector ID with different contents, their
// disc keys when every copy is kept against when only the first read is, and which images
// either rule gives one key that the other doesn't. `fsd-study.js track` shows the copies.
//
//   node tools/registry/repeated-ids.js [--corpus .registry-corpus] [--fsd-dir /nas/BackedUp/BBC/FSDs]

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint, trimFill } from "./fingerprint.js";
import { fsdSideBytes, parseFsd } from "./fsd.js";

const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = option("--corpus", ".registry-corpus");
const fsdDir = option("--fsd-dir", "/nas/BackedUp/BBC/FSDs");
const Rules = ["all", "first"];
const KeyBytes = 16;

const sha256 = (...parts) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
};

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}

function hfeRow(ref, title, bytes) {
    const keys = {};
    let repeated = [];
    for (const repeats of Rules) {
        const fp = fingerprint(ref, bytes, { repeats });
        keys[repeats] = fp.discKey;
        if (repeats === "all") repeated = fp.flux.flatMap((side) => side.repeated);
    }
    return { ref, title, keys, repeated };
}

function fsdRow(ref, fsd) {
    const keys = {};
    let repeated = [];
    for (const repeats of Rules) {
        const side = fsdSideBytes(fsd, { repeats });
        keys[repeats] = sha256(sha256(trimFill(side.data).data))
            .subarray(0, KeyBytes)
            .toString("hex");
        if (repeats === "all") repeated = side.repeated;
    }
    return { ref, title: fsd.title, keys, repeated };
}

/** Groups of refs that share a key under `rule` but not all under `other`. */
function joinedOnlyBy(rows, rule, other) {
    const groups = new Map();
    for (const row of rows) groups.set(row.keys[rule], [...(groups.get(row.keys[rule]) ?? []), row]);
    return [...groups.values()].filter((group) => new Set(group.map((row) => row.keys[other])).size > 1);
}

async function main() {
    const rows = [];
    const manifest = JSON.parse(await readFile(path.join(corpus, "hfe", "manifest.json"), "utf8")).files;
    for (const { path: ref, title } of manifest)
        rows.push(hfeRow(ref, title, await readFile(path.join(corpus, "hfe", ref))));
    let unparsed = 0;
    for await (const file of walk(fsdDir)) {
        if (path.extname(file).toLowerCase() !== ".fsd") continue;
        try {
            rows.push(fsdRow(path.relative(fsdDir, file), parseFsd(new Uint8Array(await readFile(file)))));
        } catch {
            unparsed++;
        }
    }
    const repeating = rows.filter((row) => row.repeated.length);
    console.log(`images: ${rows.length} (${unparsed} FSDs unparsed)`);
    console.log(`repeating an ID with different contents: ${repeating.length}`);
    for (const row of repeating) {
        const ids = row.repeated.map(({ id, copies }) => `${id.join("/")} x${copies}`).join(", ");
        console.log(`  ${row.ref} (${row.title}): ${ids}`);
    }
    console.log(`keys that differ between the rules: ${rows.filter((r) => r.keys.all !== r.keys.first).length}`);
    for (const [rule, other] of [Rules, [...Rules].reverse()]) {
        const groups = joinedOnlyBy(rows, rule, other);
        console.log(`one key under "${rule}" but not "${other}": ${groups.length}`);
        for (const group of groups) console.log(`  ${group.map((row) => `${row.ref} (${row.title})`).join(" / ")}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
