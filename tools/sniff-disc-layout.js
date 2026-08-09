#!/usr/bin/env node
/**
 * Report what jsbeeb makes of the track layout of a pile of disc images, so a change to the
 * detection can be checked against a corpus before it reaches anyone.
 *
 * Usage: node tools/sniff-disc-layout.js <directory> [--verbose] [--manifest <path>]
 *
 * Walks the directory for .ssd, .dsd, .hfe and .zip files and prints one line per image: the
 * verdict, the path and the reason. Sector images are judged by their catalogue and flux images by
 * their surface, which is what jsbeeb itself does. Without --verbose only the 40 track verdicts are
 * listed, since they are the ones a change makes or loses.
 *
 * --manifest takes the archive manifest that came with a mirror of flux images and compares each
 * verdict against the tracks its catalogue records, which is the only ground truth there is for
 * this. Disagreements are printed whether or not --verbose is given, and are worth reading: a
 * disc's layout and the row describing it can each be wrong.
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { argv, exit, stdout } from "node:process";

import { Disc, DiscConfig, sniffDfsLayout, sniffSurfaceLayout } from "../src/disc.js";
import { loadHfe, sniffHfeLayout } from "../src/disc-hfe.js";
import { unzipDiscImage } from "../src/utils.js";

const SectorImages = new Set([".ssd", ".dsd"]);
const FluxImages = new Set([".hfe"]);
const known = (name) => SectorImages.has(extname(name).toLowerCase()) || FluxImages.has(extname(name).toLowerCase());

async function* discImages(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            yield* discImages(path);
            continue;
        }
        if (extname(entry.name).toLowerCase() === ".zip") {
            try {
                const { name, data } = await unzipDiscImage(new Uint8Array(await readFile(path)));
                if (known(name)) yield { path: `${path}!${name}`, name, data };
            } catch (e) {
                stdout.write(`?? ${path}: ${e.message}\n`);
            }
        } else if (known(entry.name)) {
            yield { path, name: entry.name, data: new Uint8Array(await readFile(path)) };
        }
    }
}

/** What jsbeeb would make of one image, by the same route discFor takes. */
function sniff({ name, data }) {
    if (SectorImages.has(extname(name).toLowerCase()))
        return sniffDfsLayout(data, extname(name).toLowerCase() === ".dsd");
    const header = sniffHfeLayout(data);
    const disc = new Disc(true, new DiscConfig(), name);
    disc.config.expandTo80 = header.is40Track;
    loadHfe(disc, data);
    return header.is40Track ? header : sniffSurfaceLayout(disc);
}

/** The tracks an archive manifest records for a disc, which is what its cataloguer saw. */
function claimedTracks(manifest, name) {
    const entry = manifest?.files?.find((file) => file.path === name);
    return entry ? ((entry.tracks ?? [])[0] ?? "") : null;
}

async function main() {
    const directory = argv[2];
    const verbose = argv.includes("--verbose");
    const manifestPath = argv[argv.indexOf("--manifest") + 1];
    if (!directory || directory.startsWith("--")) {
        stdout.write("Usage: node tools/sniff-disc-layout.js <directory> [--verbose] [--manifest <path>]\n");
        exit(1);
    }
    const manifest = argv.includes("--manifest") ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
    // The loaders narrate what they are doing, which would bury the report.
    console.log = () => {};

    const counts = new Map();
    const disagreements = [];
    let total = 0;
    let agreed = 0;
    for await (const image of discImages(directory)) {
        let is40Track, reason;
        try {
            ({ is40Track, reason } = sniff(image));
        } catch (e) {
            stdout.write(`?? ${image.path}: ${e.message}\n`);
            continue;
        }
        total++;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
        if (is40Track || verbose) stdout.write(`${is40Track ? "40" : "80"} ${image.path}: ${reason}\n`);
        const claimed = claimedTracks(manifest, image.name);
        if (claimed === null) continue;
        if (claimed.startsWith("40") === is40Track) agreed++;
        else
            disagreements.push(
                `${image.name}: catalogued as "${claimed}", read as ${is40Track ? "40" : "80"} (${reason})`,
            );
    }

    stdout.write(`\n${total} images\n`);
    for (const [reason, count] of [...counts].sort(([, a], [, b]) => b - a)) {
        stdout.write(`${String(count).padStart(6)}  ${reason}\n`);
    }
    if (manifest) {
        stdout.write(`\n${agreed} of ${agreed + disagreements.length} agree with the manifest\n`);
        for (const disagreement of disagreements) stdout.write(`  ${disagreement}\n`);
    }
}

main().catch((e) => {
    stdout.write(`${e.stack}\n`);
    exit(1);
});
