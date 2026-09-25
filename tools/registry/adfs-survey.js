#!/usr/bin/env node
// Finds the ADFS discs in the corpus (sector images under .registry-corpus/adfs/, and HFE
// captures whose decoded first side has an ADFS root directory) and prints each one's
// keys, so copies of the same disc from different places can be compared. An ADFS root
// directory starts at byte &200 with a sequence number and "Hugo" (old map) or "Nick".
//
//   node tools/registry/adfs-survey.js [--corpus .registry-corpus]

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint, isSectorImage } from "./fingerprint.js";

const index = process.argv.indexOf("--corpus");
const corpus = index > 0 ? process.argv[index + 1] : ".registry-corpus";
const RootDirectory = 0x200;
const isAdfs = (side) =>
    ["Hugo", "Nick"].includes(Buffer.from(side.subarray(RootDirectory + 1, RootDirectory + 5)).toString("latin1"));

async function main() {
    const results = [];
    const adfsDir = path.join(corpus, "adfs");
    for (const name of (await readdir(adfsDir).catch(() => [])).sort()) {
        if (!isSectorImage(name)) continue;
        const bytes = await readFile(path.join(adfsDir, name));
        const fp = fingerprint(name, bytes);
        results.push({ source: "adfs", ref: name, adfs: isAdfs(fp.sides[0]), ...fp });
    }
    const hfeManifest = JSON.parse(await readFile(path.join(corpus, "hfe", "manifest.json"), "utf8")).files;
    for (const entry of hfeManifest) {
        const bytes = await readFile(path.join(corpus, "hfe", entry.path));
        const fp = fingerprint(entry.path, bytes);
        if (isAdfs(fp.sides[0]))
            results.push({ source: "hfe", ref: entry.path, title: entry.title, adfs: true, ...fp });
    }
    for (const r of results)
        console.log(
            `${r.source.padEnd(4)} ${r.adfs ? "ADFS" : "----"} disc ${r.discKey.slice(0, 8)} sides ${r.sideKeys.map((k) => k.slice(0, 8)).join(",")} ` +
                `lengths ${r.sideLengths.join(",")} ${r.title ?? ""} ${r.ref}`,
        );
    const byKey = new Map();
    for (const r of results) byKey.set(r.discKey, [...(byKey.get(r.discKey) ?? []), r.ref]);
    console.log(
        `\n${results.length} images, ${results.filter((r) => r.adfs).length} ADFS, ${byKey.size} distinct disc keys`,
    );
    for (const refs of byKey.values()) if (refs.length > 1) console.log(`  same key: ${refs.join(" / ")}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
