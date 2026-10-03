#!/usr/bin/env node
// For reconstructions whose FSD has tracks it could read only IDs from, and which share a
// title with a capture: which way of treating those tracks gives the capture's key.
//
//   node tools/registry/fsd-unreadable.js [--corpus .registry-corpus] [--fsd-dir /nas/BackedUp/BBC/FSDs]
//
// Needs fsd-titles.jsonl and fsd-match.jsonl from fsd-study.js; writes fsd-unreadable.jsonl.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { trimFill } from "./fingerprint.js";
import { fsdSideBytes, parseFsd } from "./fsd.js";

const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = option("--corpus", ".registry-corpus");
const fsdDir = option("--fsd-dir", "/nas/BackedUp/BBC/FSDs");
const sha256 = (data) => createHash("sha256").update(data).digest();
const discKeyOf = (side) =>
    sha256(sha256(trimFill(side).data))
        .subarray(0, 16)
        .toString("hex");
const readJsonl = async (name) =>
    (await readFile(path.join(corpus, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

async function main() {
    const index = new Map(
        (await readJsonl("index.jsonl")).filter((r) => r.source === "hfe").map((r) => [r.ref, r.discKey]),
    );
    const rows = [];
    const Modes = ["drop", "fill-declared", "fill-beebjit"];
    for (const row of await readJsonl("fsd-titles.jsonl")) {
        if (!row.nasFsd) continue;
        const fsd = parseFsd(await readFile(path.join(fsdDir, row.nasFsd)));
        if (fsd.tracks.every((t) => t.readable || t.sectors.length === 0)) continue;
        const captureKeys = new Map(row.captures.map((c) => [index.get(c), c]));
        const result = { title: row.title, fsd: row.nasFsd, reconstructionMatchesCapture: row.matchesCapture };
        for (const unreadable of Modes)
            result[unreadable] = captureKeys.get(discKeyOf(fsdSideBytes(fsd, { unreadable }).data)) ?? null;
        rows.push(result);
        console.log(JSON.stringify(result));
    }
    await writeFile(path.join(corpus, "fsd-unreadable.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const count = (mode) => rows.filter((r) => r[mode]).length;
    console.log(`${rows.length} FSDs with unreadable tracks and a capture of the same title`);
    for (const mode of Modes) console.log(`  ${mode}: ${count(mode)} match a capture`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
