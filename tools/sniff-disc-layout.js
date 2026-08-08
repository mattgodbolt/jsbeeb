#!/usr/bin/env node
/**
 * Report what jsbeeb makes of the track layout of a pile of disc images, so a change to the
 * detection can be checked against a corpus (an STH mirror, say) before it reaches anyone.
 *
 * Usage: node tools/sniff-disc-layout.js <directory> [--verbose]
 *
 * Walks the directory for .ssd, .dsd and .zip files, and prints one line per image: the verdict,
 * the path and the reason. Without --verbose only the 40 track verdicts are listed, since they
 * are the ones a change makes or loses.
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { argv, exit, stdout } from "node:process";

import { sniffDfsLayout } from "../src/disc.js";
import { unzipDiscImage } from "../src/utils.js";

const DiscExtensions = new Set([".ssd", ".dsd"]);

async function* discImages(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            yield* discImages(path);
            continue;
        }
        const extension = extname(entry.name).toLowerCase();
        if (extension === ".zip") {
            try {
                const { name, data } = await unzipDiscImage(new Uint8Array(await readFile(path)));
                if (DiscExtensions.has(extname(name).toLowerCase())) yield { path: `${path}!${name}`, name, data };
            } catch (e) {
                stdout.write(`?? ${path}: ${e.message}\n`);
            }
        } else if (DiscExtensions.has(extension)) {
            yield { path, name: entry.name, data: new Uint8Array(await readFile(path)) };
        }
    }
}

async function main() {
    const directory = argv[2];
    const verbose = argv.includes("--verbose");
    if (!directory) {
        stdout.write("Usage: node tools/sniff-disc-layout.js <directory> [--verbose]\n");
        exit(1);
    }
    // The unzipper narrates what it is doing, which would bury the report.
    console.log = () => {};

    const counts = new Map();
    let total = 0;
    for await (const { path, name, data } of discImages(directory)) {
        const { is40Track, reason } = sniffDfsLayout(data, extname(name).toLowerCase() === ".dsd");
        total++;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        if (is40Track || verbose) stdout.write(`${is40Track ? "40" : "80"} ${path}: ${reason}\n`);
    }

    stdout.write(`\n${total} images\n`);
    for (const [reason, count] of [...counts].sort(([, a], [, b]) => b - a)) {
        stdout.write(`${String(count).padStart(6)}  ${reason}\n`);
    }
}

main().catch((e) => {
    stdout.write(`${e.stack}\n`);
    exit(1);
});
