#!/usr/bin/env node
/**
 * Mirror the HFE disc images catalogued by the "BBC discs and fingerprints"
 * sheet into a local directory tree, ready to be uploaded to
 * s3://bbc.xania.org/archive/bbcdiscs/.
 *
 * See tools/README-bbcdiscs-mirror.md for the workflow and manifest format.
 */

import { createHash } from "node:crypto";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";
import {
    access,
    constants as fsConstants,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { argv, env, exit, stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import Papa from "papaparse";

import { parseFingerprints, runBeebjitWithRetry } from "./beebjit-fingerprint.js";

const SchemaVersion = 1;
const ArchiveName = "BBC Micro HFE disc images";

// Every source's blobs share one directory, so a disc keeps the same link
// whichever source it came from and whatever categories are added later. Named
// for the archive's first and only category, which is what the links say.
const BlobDir = "hfe";
const UserAgent = "jsbeeb-mirror (+https://github.com/mattgodbolt/jsbeeb)";
const DriveDownload = "https://drive.usercontent.google.com/download";
const DefaultConcurrency = 4;
const ProgressEvery = 25;
const RetryDelayMs = 1000;
const MaxRetries = 3;
const HfeMagics = ["HXCPICFE", "HXCHFEV3"];
const PublishedManifest = "https://bbc.xania.org/archive/bbcdiscs/hfe/manifest.json";
const PreflightSample = 10;

const LinkColumn = "HFE link";
const DriveIdPattern = /\/file\/d\/([-\w]{25,})/;

// Cells describing a two-sided disc hold one value per side, comma separated.
// A side left blank keeps its place, or every value after it would be read
// against the wrong side.
const splitCell = (value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? [] : trimmed.split(",").map((part) => part.trim());
};

/**
 * Split a free-text per-side cell, where a comma might be separating the sides
 * or might just be part of what a side says. A DFS title is 12 arbitrary bytes
 * and some of them contain commas, so only trust the split when it produces
 * exactly one value per side; otherwise the cell describes a single side.
 */
const splitPerSide = (value, sides) => {
    const parts = splitCell(value);
    return parts.length === sides ? parts : (value ?? "").trim() === "" ? [] : [(value ?? "").trim()];
};

// Most discs leave most of the sheet's optional columns blank, and a manifest
// of `"notes": null` says nothing.
const withoutEmpties = (entry) =>
    Object.fromEntries(
        Object.entries(entry).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)),
    );

// How the sheet writes "this disc's DFS title is empty", as opposed to `?`,
// which is a real character beebjit substitutes for an unprintable byte.
const EmptyTitleMarkers = new Set(["<blank>", "<empty>"]);

const clean = (value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" || trimmed === "none" || EmptyTitleMarkers.has(trimmed) ? null : trimmed;
};

/**
 * Turn sheet rows into the discs we intend to mirror.
 *
 * A row with no link is withheld, not missing: the link is where the archive's
 * owner says whether an image may be published, so its absence is reported and
 * skipped rather than treated as a fault.
 *
 * @param {Object<string, string>[]} rows
 * @returns {{entries: object[], withheld: object[], problems: string[]}}
 */
export function parseCatalogue(rows) {
    const entries = [];
    const withheld = [];
    const problems = [];
    const byDriveId = new Map();
    const byBlob = new Map();

    for (const [index, row] of rows.entries()) {
        const where = `row ${index + 2} (${row.Publisher} ${row.Title})`;
        const link = (row[LinkColumn] ?? "").trim();
        const title = clean(row.Title);
        if (!title && !link) continue;
        if (!link) {
            withheld.push({ publisher: row.Publisher, title, disc: row.Disc, tracks: row.Tracks });
            continue;
        }

        const driveId = DriveIdPattern.exec(link)?.[1];
        if (!driveId) {
            problems.push(`${where}: cannot find a Drive file id in ${link}`);
            continue;
        }
        const crc32 = splitCell(row.CRC32);
        if (crc32.length === 0 || crc32.some((value) => value === "")) {
            problems.push(`${where}: needs a CRC32 for every side; it is what names the blob`);
            continue;
        }

        const blob = `${crc32.join("-")}.hfe`;
        const firstUse = byDriveId.get(driveId);
        if (firstUse) {
            problems.push(`${where}: reuses the Drive link already claimed by ${firstUse}, so one of them is wrong`);
            continue;
        }
        const blobUse = byBlob.get(blob);
        if (blobUse) {
            problems.push(`${where}: has the same CRC32 as ${blobUse}, so both want the blob ${blob}`);
            continue;
        }
        byDriveId.set(driveId, where);
        byBlob.set(blob, where);

        entries.push({
            driveId,
            blob,
            title,
            publisher: clean(row.Publisher),
            disc: clean(row.Disc),
            tracks: splitCell(row.Tracks),
            variant: clean(row.Variant),
            crc32,
            crc32As40: splitCell(row["CRC32 as 40 tracks (if 80 track disc)"]),
            dfsTitle: splitPerSide(row["DFS title"], crc32.length),
            dfsCycle: splitCell(row["DFS cycle number"]),
            grabVersion: clean(row["HFE Grab version"]),
            date: clean(row["Birthday (YY/MM/DD)"]),
            submitter: clean(row.Submitter),
            notes: clean(row.Notes),
        });
    }
    return { entries, withheld, problems };
}

/**
 * Check a disc against what the sheet claims about it.
 *
 * beebjit reports two fingerprints per side: the whole surface, and the even
 * tracks alone. A 40 track side written to an 80 track surface is double
 * stepped, so its real fingerprint is the even track one; the sheet's `CRC32`
 * column holds whichever of the two matches the side's density, which the
 * `Tracks` column gives per side.
 *
 * @param {object} entry from parseCatalogue
 * @param {ReturnType<parseFingerprints>} sides
 * @returns {string[]} human readable mismatches, empty when the disc verifies
 */
export function compareFingerprints(entry, sides) {
    const problems = [];
    if (sides.length !== entry.crc32.length)
        problems.push(`sheet describes ${entry.crc32.length} side(s), disc has ${sides.length}`);

    for (const [index, expected] of entry.crc32.entries()) {
        const side = sides[index];
        if (!side) continue;
        const is80Track = (entry.tracks[index] ?? entry.tracks[0] ?? "").startsWith("80");
        const actual = is80Track ? side.full : (side.as40 ?? side.full);
        const check = (what, want, got) => {
            if (!want) return;
            if (got === null) problems.push(`side ${index} ${what}: sheet says ${want}, disc reports none`);
            else if (want.toUpperCase() !== got.toUpperCase())
                problems.push(`side ${index} ${what}: sheet says ${want}, disc says ${got}`);
        };
        check("CRC32", expected, actual);
        check("CRC32 as 40 tracks", entry.crc32As40[index], side.as40);
        check("DFS cycle number", entry.dfsCycle[index], side.dfsCycle);
        const claimed = entry.dfsTitle[index];
        if (claimed !== undefined && side.dfsTitle !== null) {
            const wantTitle = EmptyTitleMarkers.has(claimed) ? "" : claimed;
            if (wantTitle !== side.dfsTitle.trim())
                problems.push(`side ${index} DFS title: sheet says "${claimed}", disc says "${side.dfsTitle.trim()}"`);
        }
    }
    return problems;
}

// Immutable, unlike anything derived from the sheet: a typo fixed in a title
// must not invalidate a gigabyte of downloads.
const driveCacheName = (entry) => `${entry.driveId}.hfe`;

// A reconstructed disc is read where it already is, never copied.
const fsdPath = (entry, cacheDir) => join(cacheDir, entry.source);

/**
 * Where discs come from, and what is known about one before it is read.
 *
 * The rest of a run is the same whichever source a disc came from: fetch it,
 * fingerprint it, compress it, name it, write it, prune what is no longer
 * listed. Only these differ.
 *
 * `knownBlob` is what lets a mirror rebuild itself from S3 without fetching
 * anything: a source that can name a disc's blob before reading it can find
 * the published one and stop there. A source that names blobs after their
 * bytes cannot, so it returns null and the disc is read first.
 *
 * Blobs all share one directory, so two sources naming one blob differently
 * is fine and naming it the same is not: `main` checks rather than trusts.
 */
const Sources = {
    hfe: {
        title: "Captured from the discs",
        provenance: "captured",
        option: "csv",
        downloads: true,
        cacheDir: (opts) => join(opts.out, "cache"),
        /** The catalogue names every disc, and says which are published. */
        discover: async (opts) => {
            const { data: rows } = Papa.parse(await readFile(opts.csv, "utf8"), {
                header: true,
                skipEmptyLines: false,
            });
            const { entries, withheld, problems } = parseCatalogue(rows);
            stderr.write(
                `${rows.length} rows: ${entries.length} to mirror, ${withheld.length} catalogued but not published\n`,
            );
            for (const problem of problems) stderr.write(`  PROBLEM ${problem}\n`);
            return entries;
        },
        // The catalogue asserts the fingerprint is the disc's identity, and
        // every disc is checked against it before being published.
        knownBlob: (entry) => entry.blob,
        blobFor: (entry) => entry.blob,
        cachePath: (entry, cacheDir) => join(cacheDir, driveCacheName(entry)),
        read: async (entry, cacheDir) => await fetchDisc(entry, cacheDir),
        verify: (entry, sides) => compareFingerprints(entry, sides),
        cacheKey: driveCacheName,
    },
    fsd: {
        title: "Reconstructed from sector dumps",
        provenance: "reconstructed",
        option: "fsd",
        // The tree is the cache: nothing is fetched, so nothing is kept.
        downloads: false,
        cacheDir: (opts) => opts.fsd,
        /** No catalogue: the tree is the only thing that says what a disc is. */
        discover: async (opts) => {
            const entries = [];
            for await (const rel of hfeFilesUnder(opts.fsd)) entries.push({ source: rel, ...describeFromPath(rel) });
            stderr.write(`${entries.length} images under ${opts.fsd}\n`);
            return entries;
        },
        // Nothing asserts what these are, so a disc is named after its bytes:
        // a fingerprint covers only the sectors that read cleanly, and two
        // discs differing just in their protection share one.
        knownBlob: () => null,
        blobFor: (entry, raw) => `${createHash("sha256").update(raw).digest("hex").slice(0, 16)}.hfe`,
        cachePath: fsdPath,
        read: async (entry, cacheDir) => ({ path: fsdPath(entry, cacheDir), downloaded: false }),
        verify: () => [],
        cacheKey: (entry) => entry.source,
    },
};

// Tokens these filenames carry that describe the capture, not the disc.
const NoiseToken = /^(FSD\d+|HG\d|\d+T|8271|1770|[0-9A-Fa-f]{8}|\d{1,2})$/;

/** The folder is the publisher, and the filename is the title with capture details mixed in. */
export function describeFromPath(relativePath) {
    const publisher = dirname(relativePath).split("/")[0];
    const stem = basename(relativePath, extname(relativePath));
    const parts = stem.split("_");
    return {
        publisher: publisher === "." ? null : publisher,
        title: parts.filter((part) => !NoiseToken.test(part)).join(" ") || stem,
        fsd: parts.find((part) => /^FSD\d+$/.test(part)) ?? null,
    };
}

// Sorted, because the manifest lists discs in the order they were found and
// readdir's order is the filesystem's, not one every machine agrees on.
async function* hfeFilesUnder(root, prefix = "") {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        // A symlink is a directory entry in its own right, and the tree is
        // reached through one already, so ask what it points at.
        const directory = entry.isSymbolicLink() ? (await stat(join(root, rel))).isDirectory() : entry.isDirectory();
        if (directory) yield* hfeFilesUnder(root, rel);
        else if (extname(entry.name).toLowerCase() === ".hfe") yield rel;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} for ${url}`);
        this.status = status;
    }
}

const isTransient = (error) => !(error instanceof HttpError) || error.status === 429 || error.status >= 500;

async function fetchWithRetry(url) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url, { headers: { "user-agent": UserAgent } });
            if (!response.ok) throw new HttpError(response.status, url);
            return response;
        } catch (error) {
            if (attempt === MaxRetries || !isTransient(error)) throw error;
            await sleep(RetryDelayMs * (attempt + 1));
        }
    }
}

// Run `worker` over `items`, at most `concurrency` at a time. The workers share
// one iterator, so each picks up the next item as it finishes.
async function forEachConcurrently(items, concurrency, worker) {
    const remaining = items.values();
    let done = 0;
    const run = async () => {
        for (const item of remaining) {
            await worker(item);
            if (++done % ProgressEvery === 0) stderr.write(`  ${done}/${items.length}\n`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

// Drive serves an HTML interstitial rather than an error status when it won't
// hand over a file, so check what arrived rather than trusting the 200.
function checkIsHfe(bytes, what) {
    const magic = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
    if (!HfeMagics.includes(magic))
        throw new Error(`${what}: expected an HFE image, got ${bytes.length} bytes starting ${JSON.stringify(magic)}`);
}

async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return null;
    }
}

let nextTemp = 0;

// So an interrupted run never leaves a truncated file that a later run would
// mistake for complete. The name is unique per write because two discs with
// the same bytes are published under the same name, by two workers at once.
async function writeAtomically(dest, bytes) {
    const partial = `${dest}.${nextTemp++}.part`;
    await writeFile(partial, bytes);
    await rename(partial, dest);
}

async function fetchDisc(entry, cacheDir) {
    const dest = join(cacheDir, driveCacheName(entry));
    if ((await fileSize(dest)) !== null) return { path: dest, downloaded: false };
    const url = `${DriveDownload}?id=${entry.driveId}&export=download`;
    const bytes = new Uint8Array(await (await fetchWithRetry(url)).arrayBuffer());
    checkIsHfe(bytes, entry);
    await writeAtomically(dest, bytes);
    return { path: dest, downloaded: true };
}

async function writeJson(dest, value) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Put a disc where it will be uploaded from, and say how big it ended up.
 *
 * A blob's name determines its contents, either a fingerprint the disc was
 * checked against or a hash of its bytes, so one already there is the right
 * one. Writing it again would cost a maximum-quality compression and give the
 * upload a newer mtime to re-upload the whole archive over.
 */
const publish = async (dest, raw) => (await fileSize(dest)) ?? (await compressTo(dest, raw));

// Blobs are served with `Content-Encoding: br`, so the browser hands `fetch()`
// the decoded HFE and jsbeeb never sees the compression.
async function compressTo(dest, raw) {
    const brotli = await compress(raw, {
        params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
            [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
    });
    await writeAtomically(dest, brotli);
    return brotli.length;
}

/**
 * Get a disc's bytes, preferring a blob we already hold over a fresh read.
 *
 * A published blob is the disc, so a mirror seeded from S3 can rebuild its
 * manifests, and reverify, without asking its source for anything. That only
 * works for a source that can name a blob before reading it; the rest read
 * first. Decompressing is cheap next to the round trip it saves, and it proves
 * the stored blob is intact rather than assuming it.
 */
async function obtain(entry, source, blobDir, cacheDir) {
    const known = source.knownBlob(entry);
    if (known) {
        const published = await fileSize(join(blobDir, known));
        if (published !== null) {
            let raw;
            try {
                raw = await decompress(await readFile(join(blobDir, known)));
            } catch (error) {
                throw new Error(
                    `${known}: stored blob does not decompress. If the mirror was seeded from S3, check the ` +
                        `download did not decode Content-Encoding on the way.`,
                    { cause: error },
                );
            }
            checkIsHfe(raw, known);
            return { raw, blob: known, size: published, downloaded: false, alreadyPublished: true };
        }
    }
    const { path, downloaded } = await source.read(entry, cacheDir);
    const raw = await readFile(path);
    checkIsHfe(raw, known ?? entry.source ?? "disc");
    return { raw, blob: source.blobFor(entry, raw), size: null, downloaded, alreadyPublished: false };
}

// A withdrawal has to take the cached original with it, or we quietly keep a
// copy of something we were asked to stop publishing.
async function prune(dir, wanted) {
    const names = await readdir(dir);
    const stale = names.filter((name) => name.endsWith(".hfe") && !wanted.has(name));
    // A `.part` is a write that did not finish, and the upload would publish it
    // as immutable alongside the real thing.
    for (const name of [...names.filter((name) => name.endsWith(".part")), ...stale]) await rm(join(dir, name));
    return stale;
}

function fail(message) {
    stderr.write(`${message}\n`);
    exit(2);
}

/**
 * Compare a built manifest with the published one, by blob name.
 *
 * A blob's name determines its contents, so the same name over a different size
 * means one of the two is not what it claims to be: a fault, not a change.
 *
 * @param {{files: object[]}} local what a run just built
 * @param {{files: object[]}} live what is published
 * @returns {{added: object[], removed: object[], suspect: string[], sizeDelta: number}}
 */
export function diffManifests(local, live) {
    const byPath = (manifest) => new Map(manifest.files.map((file) => [file.path, file]));
    const here = byPath(local);
    const there = byPath(live);
    const suspect = [];
    for (const [path, file] of here) {
        const published = there.get(path);
        if (published && published.size !== file.size)
            suspect.push(`${path}: published as ${published.size} bytes, built as ${file.size}`);
    }
    const total = (files) => files.reduce((sum, file) => sum + file.size, 0);
    return {
        added: [...here.values()].filter((file) => !there.has(file.path)),
        removed: [...there.values()].filter((file) => !here.has(file.path)),
        suspect,
        sizeDelta: total(local.files) - total(live.files),
    };
}

/**
 * What the manifest and the directory disagree about.
 *
 * The upload sends the directory, not the manifest, so a file the manifest does
 * not name is published anyway: an abandoned `.part`, or a blob left behind by
 * a run that never got as far as pruning.
 */
export function blobsAndManifestDisagree(manifest, present) {
    const named = new Set(manifest.files.map((file) => file.path));
    return {
        missing: [...named].filter((path) => !present.has(path)),
        unexpected: [...present].filter((name) => name !== "manifest.json" && !named.has(name)),
    };
}

/**
 * Say what uploading would do, and give someone the chance to say no.
 *
 * `aws s3 sync --dryrun` lists the same objects, but by blob name, and it
 * cannot say a manifest promises a disc that is not there, nor stop to ask.
 */
async function preflight(opts) {
    const blobDir = join(opts.out, BlobDir);
    const local = JSON.parse(await readFile(join(blobDir, "manifest.json"), "utf8"));
    const response = await fetch(PublishedManifest);
    // Nothing published yet is a first upload, not a failure.
    if (!response.ok && response.status !== 403 && response.status !== 404)
        fail(`Could not read ${PublishedManifest}: ${response.status}`);
    const live = response.ok ? await response.json() : { files: [] };
    stderr.write(`${local.files.length} discs built, ${live.files.length} published\n`);

    const { missing, unexpected } = blobsAndManifestDisagree(local, new Set(await readdir(blobDir)));
    for (const [what, names] of [
        ["lists discs that are not there to upload", missing],
        ["does not name files that would be uploaded anyway", unexpected],
    ]) {
        if (!names.length) continue;
        stderr.write(`\nThe manifest ${what} (${names.length}):\n`);
        for (const name of names.slice(0, PreflightSample)) stderr.write(`  ${name}\n`);
        exit(1);
    }

    const { added, removed, suspect, sizeDelta } = diffManifests(local, live);
    const describe = (file) =>
        [file.title ?? file.path, file.publisher && `(${file.publisher})`, file.provenance].filter(Boolean).join(" ");
    stderr.write(`\n  ${added.length} to add, ${removed.length} to remove, ${(sizeDelta / 1e6).toFixed(1)} MB net\n\n`);
    // A withdrawal loses something, so those are never abbreviated.
    for (const file of removed) stderr.write(`  - ${describe(file)}\n`);
    for (const file of added.slice(0, PreflightSample)) stderr.write(`  + ${describe(file)}\n`);
    if (added.length > PreflightSample) stderr.write(`  + ... and ${added.length - PreflightSample} more\n`);
    if (suspect.length) {
        stderr.write("\nPublished under a name that should have fixed their contents:\n");
        for (const problem of suspect) stderr.write(`  ${problem}\n`);
        exit(1);
    }

    if (!added.length && !removed.length) return stderr.write("\nNothing to do.\n");
    if (opts.yes) return;
    if (!stdin.isTTY) fail("\nNobody to ask: pass --yes if this is meant to be scripted");
    const rl = createInterface({ input: stdin, output: stderr });
    try {
        if ((await rl.question("\nUpload? [y/N] ")).trim().toLowerCase() !== "y") fail("Nothing uploaded.");
    } finally {
        rl.close();
    }
}

function parseArgs(args) {
    const opts = {
        csv: null,
        fsd: null,
        only: null,
        out: null,
        concurrency: DefaultConcurrency,
        beebjit: env.BEEBJIT ?? null,
        limit: null,
        filter: null,
        checkOnly: false,
        preflight: false,
        yes: false,
        reverify: false,
        credit: null,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--csv") opts.csv = args[++i];
        else if (arg === "--fsd") opts.fsd = args[++i];
        else if (arg === "--only") opts.only = args[++i];
        else if (arg === "--out") opts.out = args[++i];
        else if (arg === "--concurrency") opts.concurrency = Number(args[++i]);
        else if (arg === "--beebjit") opts.beebjit = args[++i];
        else if (arg === "--limit") opts.limit = Number(args[++i]);
        else if (arg === "--filter") opts.filter = args[++i]?.toLowerCase();
        else if (arg === "--check-only") opts.checkOnly = true;
        else if (arg === "--preflight") opts.preflight = true;
        else if (arg === "--yes") opts.yes = true;
        else if (arg === "--reverify") opts.reverify = true;
        else if (arg === "--credit") opts.credit = args[++i];
        else if (arg === "-h" || arg === "--help") {
            stdout.write(
                "Usage: mirror-bbcdiscs.js [--csv <sheet.csv>] [--fsd <dir>] --out <dir> [--beebjit <path>]\n" +
                    `       [--only ${Object.keys(Sources).join("|")}]\n` +
                    `       [--concurrency ${DefaultConcurrency}] [--limit N] [--filter <text>]\n` +
                    "       [--check-only] [--preflight [--yes]] [--reverify] [--credit <text>]\n",
            );
            exit(0);
        } else fail(`Unknown argument: ${arg}`);
    }
    if (!opts.csv && !opts.fsd && !opts.preflight) fail("give --csv <sheet.csv>, --fsd <dir>, or both");
    if (!opts.out && !opts.checkOnly) fail("--out <dir> is required");
    if (opts.only && !Sources[opts.only])
        fail(`Unknown --only: ${opts.only}. Known: ${Object.keys(Sources).join(", ")}`);
    if (opts.filter === undefined) fail("--filter needs a value");
    if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1))
        fail("--limit must be a positive integer");
    // Publishing a disc means asserting it is the one the catalogue describes,
    // and only beebjit can tell us that, so there is no unverified path to S3.
    if (!opts.beebjit && !opts.checkOnly && !opts.preflight)
        fail("beebjit is required to verify discs before publishing: set BEEBJIT=<path> or pass --beebjit <path>");
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) fail("--concurrency must be a positive integer");
    return opts;
}

/** Narrow the catalogue to what this run was asked to look at. */
function select(entries, opts) {
    let selected = entries;
    if (opts.filter)
        selected = selected.filter((entry) => `${entry.publisher} ${entry.title}`.toLowerCase().includes(opts.filter));
    if (opts.limit !== null) selected = selected.slice(0, opts.limit);
    if (selected.length !== entries.length) stderr.write(`Selecting ${selected.length} of ${entries.length} discs\n`);
    return selected;
}

/**
 * Get each disc, check it against its row, and compress the ones that agree.
 *
 * @returns {{sizes: Map<string, {size: number, originalSize: number}>, failures: string[]}}
 */
async function mirrorDiscs(selected, source, opts, blobDir, cacheDir) {
    const mirrored = new Map();
    const failures = [];
    const unfingerprinted = [];
    const duplicates = [];
    let downloaded = 0;
    let held = 0;

    await forEachConcurrently(selected, opts.concurrency, async (entry) => {
        const what = `${entry.publisher ?? "?"} ${entry.title ?? entry.source}`;
        try {
            const {
                raw,
                blob,
                size,
                downloaded: isNew,
                alreadyPublished,
            } = await obtain(entry, source, blobDir, cacheDir);
            if (isNew) downloaded++;
            if (alreadyPublished) held++;

            // A published blob has already been through this. For a catalogued
            // source its name is the fingerprint, so a changed one arrives as a
            // new blob rather than as a disc that needs looking at again.
            let sides = [];
            if (!alreadyPublished || opts.reverify) {
                const discPath = source.cachePath(entry, cacheDir);
                if ((await fileSize(discPath)) === null) await writeAtomically(discPath, raw);
                try {
                    sides = parseFingerprints(await runBeebjitWithRetry(opts.beebjit, discPath));
                } catch (error) {
                    // A disc beebjit cannot read is still worth keeping when
                    // nothing was going to be checked against it anyway.
                    if (source.verify(entry, []).length === 0) unfingerprinted.push(`${what}: ${error.message}`);
                    else throw error;
                }
                const mismatches = source.verify(entry, sides);
                if (mismatches.length) {
                    failures.push(`${blob} (${what})\n    ${mismatches.join("\n    ")}`);
                    return;
                }
            }
            const record = {
                entry,
                sides,
                size: size ?? (await publish(join(blobDir, blob), raw)),
                originalSize: raw.length,
            };
            // Two discs with the same bytes are one blob, and which of them
            // describes it must not depend on which worker finished first.
            const first = mirrored.get(blob);
            if (!first) mirrored.set(blob, record);
            else {
                const [kept, dropped] = first.entry.order < entry.order ? [first, record] : [record, first];
                mirrored.set(blob, kept);
                duplicates.push(`${dropped.entry.source ?? dropped.entry.title} is byte-identical to ${blob}`);
            }
        } catch (error) {
            failures.push(`${what}: ${error.message}`);
        }
    });

    stderr.write(
        `Read ${downloaded}, already mirrored ${held}, cached from an earlier run ` +
            `${selected.length - downloaded - held}\n`,
    );
    for (const failure of failures) stderr.write(`  FAILED ${failure}\n`);
    for (const one of unfingerprinted) stderr.write(`  NO FINGERPRINT ${one}\n`);
    for (const one of duplicates) stderr.write(`  DUPLICATE ${one}\n`);
    return { mirrored, failures };
}

/** What a disc looks like in a manifest: what its source knew, plus what beebjit found. */
const manifestEntry = (blob, { entry, sides, size, originalSize }, source) =>
    withoutEmpties({
        path: blob,
        size,
        originalSize,
        encoding: "br",
        provenance: source.provenance,
        title: entry.title,
        publisher: entry.publisher,
        disc: entry.disc,
        tracks: entry.tracks,
        variant: entry.variant,
        crc32: entry.crc32 ?? sides.map((side) => side.full).filter(Boolean),
        crc32As40: entry.crc32As40,
        dfsTitle: entry.dfsTitle ?? sides.map((side) => (side.dfsTitle ?? "").trim()).filter(Boolean),
        dfsCycle: entry.dfsCycle,
        grabVersion: entry.grabVersion,
        date: entry.date,
        submitter: entry.submitter,
        fsd: entry.fsd,
        notes: entry.notes,
    });

/**
 * The blob one source names the same as another's, if there is one.
 *
 * They share a directory, so a name claimed twice would serve one disc's bytes
 * under the other's name. The two schemes are different lengths and cannot
 * collide, which is exactly the kind of reasoning worth checking not believing.
 *
 * @param {[string, {path: string}[]][]} perSource each source's id and its manifest entries
 * @returns {?{path: string, sources: string[]}}
 */
export function findCollision(perSource) {
    const claimedBy = new Map();
    for (const [id, files] of perSource) {
        for (const { path } of files) {
            const first = claimedBy.get(path);
            if (first) return { path, sources: [first, id] };
            claimedBy.set(path, id);
        }
    }
    return null;
}

/** Mirror one source into the shared blob directory, and say what it puts in the manifest. */
async function mirrorSource(id, source, opts) {
    stderr.write(`\n[${id}] ${source.title}\n`);
    const found = await source.discover(opts);
    if (opts.checkOnly) return null;
    // An emptied source would withdraw everything it ever published. Far more
    // likely is a tree that did not mount, or a catalogue that failed to parse.
    if (!found.length) fail(`[${id}] found no discs at all: refusing to treat that as an archive being emptied`);

    const selected = select(found, opts);
    const partial = selected.length !== found.length;
    const cacheDir = source.cacheDir(opts);
    const blobDir = join(opts.out, BlobDir);
    if (source.downloads) await mkdir(cacheDir, { recursive: true });
    await mkdir(blobDir, { recursive: true });

    // Discovery order, not the order concurrent workers happened to finish in,
    // or the manifest would differ from run to run with nothing having changed.
    selected.forEach((entry, order) => (entry.order = order));
    const { mirrored, failures } = await mirrorDiscs(selected, source, opts, blobDir, cacheDir);
    const files = [...mirrored]
        .sort(([, a], [, b]) => a.entry.order - b.entry.order)
        .map(([blob, held]) => manifestEntry(blob, held, source));

    // Keyed on what the source still lists, not on what verified: a disc that
    // failed today is withheld from the manifest but keeps whatever blob it
    // already had, where one no longer listed is gone for good. The blobs are
    // shared with every source, so only main can say which of those are stale.
    const keep = new Set(files.map((file) => file.path));
    for (const entry of found) {
        const known = source.knownBlob(entry);
        if (known) keep.add(known);
    }
    if (!partial && source.downloads) await prune(cacheDir, new Set(found.map((entry) => source.cacheKey(entry))));
    stderr.write(`${files.length} of ${selected.length} selected discs published\n`);
    return { failures, partial, files, keep };
}

async function main() {
    const opts = parseArgs(argv.slice(2));
    if (opts.preflight) return await preflight(opts);
    const wanted = Object.entries(Sources).filter(([id]) => !opts.only || opts.only === id);
    const runnable = wanted.filter(([, source]) => opts[source.option]);
    if (runnable.length === 0)
        fail(`Nothing to mirror: give ${wanted.map(([, source]) => `--${source.option}`).join(" or ")}`);

    if (!opts.checkOnly) {
        // Before the reading, not after it.
        try {
            await access(opts.beebjit, fsConstants.X_OK);
        } catch {
            fail(`Cannot run beebjit at ${opts.beebjit}: set BEEBJIT=<path> or pass --beebjit <path>`);
        }
    }

    const results = [];
    for (const [id, source] of runnable) results.push([id, await mirrorSource(id, source, opts)]);
    if (opts.checkOnly) return;

    const collision = findCollision(results.map(([id, result]) => [id, result.files]));
    if (collision) fail(`Blob name collision: ${collision.sources.join(" and ")} both claim ${collision.path}`);

    // The manifest describes every disc and the upload deletes whatever it
    // leaves out, so a run that looked at only some of them writes nothing and
    // prunes nothing. Its blobs keep until a full run picks them up.
    const failed = results.some(([, result]) => result.failures.length);
    if (!(runnable.length === Object.keys(Sources).length && results.every(([, result]) => !result.partial))) {
        stderr.write("\nPartial run: the manifest describes every disc, so it is left alone\n");
        exit(failed ? 1 : 0);
    }

    const files = results.flatMap(([, result]) => result.files);
    const stale = await prune(join(opts.out, BlobDir), new Set(results.flatMap(([, r]) => [...r.keep])));
    for (const name of stale) stderr.write(`  WITHDRAWN ${name}\n`);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    await writeJson(join(opts.out, BlobDir, "manifest.json"), { schemaVersion: SchemaVersion, files });
    await writeJson(
        join(opts.out, "manifest.json"),
        withoutEmpties({
            schemaVersion: SchemaVersion,
            name: ArchiveName,
            credit: opts.credit,
            scrapedAt: new Date().toISOString(),
            categories: [
                {
                    id: BlobDir,
                    title: ArchiveName,
                    manifest: `${BlobDir}/manifest.json`,
                    fileCount: files.length,
                    totalBytes,
                },
            ],
        }),
    );

    const byProvenance = Object.values(Sources)
        .map(({ provenance }) => `${files.filter((file) => file.provenance === provenance).length} ${provenance}`)
        .join(", ");
    stderr.write(
        `\n${files.length} discs (${byProvenance}), ${(totalBytes / 1e6).toFixed(1)} MB stored ` +
            `(${(files.reduce((total, file) => total + file.originalSize, 0) / 1e6).toFixed(0)} MB raw)\n`,
    );
    if (failed) exit(1);
}

// Only run the mirror when invoked as a script, so the parsers can be tested.
if (basename(argv[1] ?? "") === "mirror-bbcdiscs.js") {
    main().catch((error) => {
        stderr.write(`\nERROR: ${error.stack ?? error.message ?? error}\n`);
        exit(1);
    });
}
