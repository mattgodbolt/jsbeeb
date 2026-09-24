#!/usr/bin/env node
// Fingerprints every disc image in the corpus and writes one JSON line per image:
// where it came from, its keys, what trimming removed, what the flux decode
// dropped, and the DFS catalogue with a hash per file where there is one.
//
//   node tools/registry/build-index.js [--corpus .registry-corpus] [--shard 0/4] [--sources hfe,sth]
//       [--track-rule physical|strict] [--pitch-test combined|headers] [--name index]
//
// Shards let several processes share the work; each writes <name>-<shard>.jsonl.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import { dfsCatalogue } from "./dfs.js";
import { fingerprint, isDiscImage, extensionOf } from "./fingerprint.js";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const [shard, shards] = arg("--shard", "0/1").split("/").map(Number);
const trackRule = arg("--track-rule", "physical");
const pitchTest = arg("--pitch-test", "combined");
const onlySources = arg("--sources", "hfe,sth,bbcmicro").split(",");
const outName = arg("--name", "index");
if (!["physical", "strict"].includes(trackRule)) throw new Error(`Unknown --track-rule ${trackRule}`);
if (!["combined", "headers"].includes(pitchTest)) throw new Error(`Unknown --pitch-test ${pitchTest}`);

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
    }
    return out;
}

async function* images() {
    const hfeManifest = JSON.parse(await readFile(path.join(corpus, "hfe", "manifest.json"), "utf8")).files;
    for (const entry of hfeManifest) {
        const { path: p, ...meta } = entry;
        yield { source: "hfe", ref: p, name: p, read: () => readFile(path.join(corpus, "hfe", p)), meta };
    }
    for (const file of (await walk(path.join(corpus, "sth-disc"))).sort()) {
        if (!file.toLowerCase().endsWith(".zip")) continue;
        const ref = path.relative(path.join(corpus, "sth-disc"), file);
        yield { source: "sth", ref, name: ref, zip: () => readFile(file) };
    }
    for (const file of (await walk(path.join(corpus, "bbcmicro"))).sort()) {
        const ref = path.relative(path.join(corpus, "bbcmicro"), file);
        if (isDiscImage(file)) yield { source: "bbcmicro", ref, name: ref, read: () => readFile(file) };
        else if (file.toLowerCase().endsWith(".zip"))
            yield { source: "bbcmicro", ref, name: ref, zip: () => readFile(file) };
    }
}

function describe(name, bytes) {
    const fp = fingerprint(name, bytes, { trackRule, pitchTest });
    const { sides } = fp;
    const isDfs = [".ssd", ".dsd", ".hfe"].includes(extensionOf(name));
    return {
        ext: extensionOf(name),
        size: bytes.length,
        sha1: sha1(bytes),
        fileKey: fp.fileKey,
        discKey: fp.discKey,
        sideKeys: fp.sideKeys,
        sideLengths: fp.sideLengths,
        trimmedFill: fp.trimmedFill.map((m) => Object.fromEntries([...m].map(([k, v]) => [k.toString(16), v]))),
        flux: fp.flux?.map(({ is40Track, dropped, sizes }) => ({
            is40Track,
            dropped,
            sizes: Object.fromEntries(sizes),
        })),
        catalogues: isDfs ? sides.map((side) => dfsCatalogue(side)) : null,
    };
}

async function main() {
    const lines = [];
    let index = 0;
    for await (const image of images()) {
        if (!onlySources.includes(image.source) || index++ % shards !== shard) continue;
        try {
            if (image.zip) {
                const members = await unzip(await image.zip());
                for (const [member, bytes] of Object.entries(members)) {
                    if (!isDiscImage(member)) continue;
                    lines.push({ source: image.source, ref: `${image.ref}#${member}`, ...describe(member, bytes) });
                }
            } else {
                const bytes = await image.read();
                lines.push({ source: image.source, ref: image.ref, meta: image.meta, ...describe(image.name, bytes) });
            }
        } catch (error) {
            lines.push({ source: image.source, ref: image.ref, error: String(error?.message ?? error) });
        }
    }
    const out = path.join(corpus, `${outName}-${shard}.jsonl`);
    await writeFile(out, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    console.log(`${out}: ${lines.length} images`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
