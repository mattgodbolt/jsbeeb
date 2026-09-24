#!/usr/bin/env node
// Checks the fingerprint's two paths agree: every sector image in the corpus is
// loaded by jsbeeb, decoded back through the flux path, and compared with its own
// bytes, trimmed. A mismatch means the spec (or jsbeeb's loader) is wrong before
// real captures come into it.
//
//   node tools/registry/check-paths.js [--corpus .registry-corpus]

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import { discFor } from "../../src/fdc.js";
import { fluxSideBytes, isSectorImage, sectorImageSides, trimFill } from "./fingerprint.js";

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

async function* sectorImages() {
    for (const file of await walk(corpus)) {
        if (isSectorImage(file)) yield [file, await readFile(file)];
        else if (file.toLowerCase().endsWith(".zip"))
            for (const [member, bytes] of Object.entries(await unzip(await readFile(file))))
                if (isSectorImage(member)) yield [`${file}#${member}`, bytes];
    }
}

async function main() {
    const log = console.log;
    let checked = 0;
    const mismatches = [];
    for await (const [name, bytes] of sectorImages()) {
        checked++;
        console.log = () => {};
        let disc;
        try {
            disc = discFor(name.slice(name.lastIndexOf("#") + 1), new Uint8Array(bytes));
        } catch (error) {
            console.log = log;
            mismatches.push({ name, reason: `jsbeeb refused it: ${error.message}` });
            continue;
        } finally {
            console.log = log;
        }
        const raw = sectorImageSides(name, bytes).map((side) => trimFill(side).data);
        const decoded = [false, true]
            .slice(0, raw.length)
            .map((upper) => trimFill(fluxSideBytes(disc, upper).data).data);
        raw.forEach((side, i) => {
            if (!side.equals(decoded[i]))
                mismatches.push({ name, reason: `side ${i}: ${side.length} raw bytes, ${decoded[i].length} decoded` });
        });
    }
    log(`${checked} sector images, ${mismatches.length} mismatched sides`);
    for (const { name, reason } of mismatches.slice(0, 40)) log(`  ${name}: ${reason}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
