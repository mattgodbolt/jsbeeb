#!/usr/bin/env node
/**
 * The corpus check a set's pull request carries ("Symbol sets" in docs/media-registry-proposal.md):
 * for every region, every title in a corpus of disc zips whose files hold all of its anchors at the
 * same addresses, with how much of the region that title's files hold and how much of that is
 * identical. A region that's all or nearly all identical there is the same code (a crack, a
 * compilation); anchors that agree over a region whose other bytes differ are a collision, and the
 * region needs another anchor.
 *
 * Usage: node tools/symbols/corpus-check.js --config symbols-src/pipeline.json --corpus .registry-corpus/sth-disc
 *            [--source <checkout>] [--baron <path>]
 *
 * Each zip is one title. Every complete DFS file on an .ssd or .dsd is placed at its load address,
 * BASIC programs included, since a BASIC program's lines can collide too; a file of one repeated
 * byte, or catalogued to load in page zero (a placeholder, usually), is left out. It builds the title as
 * import-baron.js does, taking `--source` and `--baron` as that does. Prints the report
 * as Markdown, and exits 1 if anything collides.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { unzip } from "../../src/archive.js";
import { dfsCatalogue } from "../registry/dfs.js";
import { extensionOf, sectorImageSides } from "../registry/fingerprint.js";
import { BuildOptions, BuildUsage } from "./baron-build.js";
import { importBaron, withTitle } from "./import-baron.js";

const Page = 0x100;
const AddressLimit = 0x10000;
const IoAddressMask = 0xffff;
const DfsImages = new Set([".ssd", ".dsd"]);
// The share of a region's held bytes that are identical, above which the report calls it the same code.
export const SameCode = 0.9;

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;

function zipsUnder(dir) {
    return readdirSync(dir, { recursive: true })
        .filter((name) => name.endsWith(".zip"))
        .sort();
}

/**
 * Each file worth placing from one title's zip members, once per content and load address.
 * @param {Record<string, Uint8Array>} members
 * @returns {{name: string, load: number, data: Uint8Array}[]}
 */
export function placedFiles(members) {
    const files = [];
    const seen = new Set();
    for (const member of Object.keys(members).sort()) {
        if (!DfsImages.has(extensionOf(member))) continue;
        for (const side of sectorImageSides(member, members[member])) {
            for (const file of dfsCatalogue(side)?.files ?? []) {
                if (!file.complete || file.length === 0 || file.uniform) continue;
                const load = file.load & IoAddressMask;
                if (load < Page || load + file.length > AddressLimit) continue;
                const key = `${load}:${file.hash}:${file.length}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const data = side.subarray(file.start * Page, file.start * Page + file.length);
                files.push({ name: `${path.basename(member)}:${file.name}`, load, data });
            }
        }
    }
    return files;
}

/** @returns {Promise<Map<string, {name: string, load: number, data: Uint8Array}[]>>} title to its files */
export async function readCorpus(dir) {
    const titles = new Map();
    for (const zip of zipsUnder(dir)) {
        const files = placedFiles(await unzip(readFileSync(path.join(dir, zip))));
        if (files.length) titles.set(zip, files);
    }
    return titles;
}

const holds = (file, at, bytes) =>
    at >= file.load &&
    at + bytes.length <= file.load + file.data.length &&
    bytes.every((b, i) => file.data[at - file.load + i] === b);

/**
 * The report's rows for one region: each title holding all its anchors, with what it holds.
 * @param {{start: number, end: number, anchors: {at: number, data: number[]}[], memory: Map<number, number>}} region
 * @param {Map<number, [string, object][]>} byPage - the corpus's files by each page they cover
 */
export function titlesHolding(region, byPage) {
    const holders = new Map();
    for (const { at, data } of region.anchors)
        for (const [title, file] of byPage.get(at >> 8) ?? []) {
            if (!holds(file, at, data)) continue;
            if (!holders.has(title)) holders.set(title, new Map());
            const found = holders.get(title);
            if (!found.has(at)) found.set(at, []);
            found.get(at).push(file);
        }
    const matches = [...holders]
        .filter(([, found]) => found.size === region.anchors.length)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([title, found]) => {
            const files = [...new Set([...found.values()].flat())];
            let held = 0;
            let same = 0;
            for (const [address, byte] of region.memory) {
                const here = files
                    .filter(({ load, data }) => address >= load && address < load + data.length)
                    .map(({ load, data }) => data[address - load]);
                if (here.length) held++;
                if (here.includes(byte)) same++;
            }
            const names = [...new Set(files.map(({ name }) => name))].sort();
            return { title, files: names, held, same, share: held ? same / held : 0 };
        });
    return { holding: holders.size, matches };
}

/** The corpus's files by each page they cover. */
export function filesByPage(titles) {
    const byPage = new Map();
    for (const [title, files] of titles)
        for (const file of files)
            for (let page = file.load >> 8; page <= (file.load + file.data.length - 1) >> 8; page++) {
                if (!byPage.has(page)) byPage.set(page, []);
                byPage.get(page).push([title, file]);
            }
    return byPage;
}

/**
 * The Markdown report for a title's sets, and how many regions collide.
 * @param {{id: string, regions: object[]}[]} sets
 */
export function corpusReport(sets, titles) {
    const byPage = filesByPage(titles);
    const fileCount = [...titles.values()].reduce((total, files) => total + files.length, 0);
    const lines = [
        `${titles.size} titles, ${fileCount} distinct files placed at their load addresses. "Holding one" counts the ` +
            `titles holding any of a region's anchors; "Held" is how many of the region's bytes that title's files hold, ` +
            `and "Identical" how many of those are the same.`,
        "",
    ];
    let collisions = 0;
    for (const { id, regions } of sets) {
        lines.push(`## ${id}`, "");
        lines.push("| Region | Anchors | Holding one | Title holding all | Files | Held | Identical |");
        lines.push("|---|---|---|---|---|---|---|");
        for (const region of regions) {
            const { holding, matches } = titlesHolding(region, byPage);
            const where = `${region.name} ${hex(region.start)}-${hex(region.end - 1)} | ${region.anchors.length} | ${holding}`;
            if (!matches.length) lines.push(`| ${where} | none | | | |`);
            for (const { title, files, held, same, share } of matches) {
                const collides = share < SameCode;
                if (collides) collisions++;
                lines.push(
                    `| ${where} | ${title} | ${files.join(", ")} | ${held} of ${region.memory.size} | ` +
                        `${same} (${(100 * share).toFixed(1)}%)${collides ? " (collision)" : ""} |`,
                );
            }
        }
        lines.push("");
    }
    return { report: lines.join("\n"), collisions };
}

async function main() {
    const { values } = parseArgs({
        options: { config: { type: "string" }, corpus: { type: "string" }, ...BuildOptions },
    });
    if (!values.config || !values.corpus)
        throw new Error(`Usage: corpus-check.js --config <file> --corpus <dir> ${BuildUsage}`);
    const { sets } = await withTitle(values.config, values, ({ config, build }) => importBaron(config, build));
    const { report, collisions } = corpusReport(sets, await readCorpus(values.corpus));
    console.log(report);
    return collisions ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(error.message);
            process.exit(1);
        },
    );
}
