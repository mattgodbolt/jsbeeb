#!/usr/bin/env node
// Downloads the images the registry experiments work from into .registry-corpus/:
// our Stairway To Hell mirror (discs and tapes) and our HFE capture mirror, each as
// published, plus their manifests, and MAME's BBC disc software list (CC0). Files
// already present are skipped, so a rerun only fetches what is new. The mirrors are
// live, so numbers computed from a later fetch can drift from the findings'.
//
//   node tools/registry/fetch-corpus.js [--out .registry-corpus]

import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

const Sources = [
    { name: "sth-disc", base: "https://bbc.xania.org/archive/sth/diskimages/" },
    { name: "sth-tape", base: "https://bbc.xania.org/archive/sth/tapeimages/" },
    { name: "hfe", base: "https://bbc.xania.org/archive/bbcdiscs/hfe/" },
];
const Concurrency = 8;
// Pinned so the findings stay reproducible; the list's last change as of 2026-09-24.
const MameBbcFloppyList =
    "https://raw.githubusercontent.com/mamedev/mame/878a16dda136d6e234ded19527fe914da4488cb3/hash/bbcb_flop.xml";

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex > 0 ? process.argv[outIndex + 1] : ".registry-corpus";

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function mirror({ name, base }) {
    const dir = path.join(outDir, name);
    await mkdir(dir, { recursive: true });
    const manifestBytes = await fetchBytes(`${base}manifest.json`);
    await writeFile(path.join(dir, "manifest.json"), manifestBytes);
    const { files } = JSON.parse(manifestBytes.toString());
    let fetched = 0;
    const queue = [...files];
    const worker = async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
            const file = path.join(dir, entry.path);
            if (path.relative(dir, file).startsWith(".."))
                throw new Error(`${name}: manifest path escapes the corpus: ${entry.path}`);
            if (await exists(file)) continue;
            let bytes = await fetchBytes(base + encodePath(entry.path));
            // fetch() decodes a Content-Encoding it's told about, but the HFE blobs
            // are stored brotli-compressed; decode them here when they arrive raw.
            if (entry.encoding === "br" && bytes.length !== entry.originalSize) bytes = brotliDecompressSync(bytes);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, bytes);
            fetched++;
        }
    };
    await Promise.all(Array.from({ length: Concurrency }, worker));
    console.log(`${name}: ${files.length} in the manifest, ${fetched} fetched`);
}

async function main() {
    for (const source of Sources) await mirror(source);
    await writeFile(path.join(outDir, "bbcb_flop.xml"), await fetchBytes(MameBbcFloppyList));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
