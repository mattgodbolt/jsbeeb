#!/usr/bin/env node
/**
 * Mirror the HFE disc images catalogued by the "BBC discs and fingerprints"
 * sheet into a local directory tree, ready to be uploaded to
 * s3://bbc.xania.org/archive/bbcdiscs/.
 *
 * See tools/README-bbcdiscs-mirror.md for the workflow and manifest format.
 */

import { spawn } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { promisify } from "node:util";

const SchemaVersion = 1;
const CategoryId = "hfe";
const CategoryTitle = "BBC Micro HFE disc images";
const UserAgent = "jsbeeb-mirror (+https://github.com/mattgodbolt/jsbeeb)";
const DriveDownload = "https://drive.usercontent.google.com/download";
const DefaultConcurrency = 4;
const ProgressEvery = 25;
const RetryDelayMs = 1000;
const MaxRetries = 3;
const HfeMagics = ["HXCPICFE", "HXCHFEV3"];

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
        Object.entries(entry).filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0)),
    );

// How the sheet writes "this disc's DFS title is empty", as opposed to `?`,
// which is a real character beebjit substitutes for an unprintable byte.
const EmptyTitleMarkers = new Set(["<blank>", "<empty>"]);

const clean = (value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" || trimmed === "none" || EmptyTitleMarkers.has(trimmed) ? null : trimmed;
};

/**
 * Parse a CSV export into row objects keyed by header name.
 *
 * Fields are looked up by header rather than position, so inserting a column in
 * the sheet doesn't silently shift every value one to the left.
 *
 * @param {string} text raw CSV
 * @returns {Object<string, string>[]}
 */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char !== '"') field += char;
            else if (text[i + 1] === '"') field += text[i++];
            else quoted = false;
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += char;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    const [headers, ...body] = rows;
    if (!headers) return [];
    return body.map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? ""])));
}

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
 * Read the fingerprints out of `beebjit -log disc:fingerprint` output.
 *
 * @param {string} output combined stdout and stderr
 * @returns {{full: ?string, as40: ?string, dfsTitle: ?string, dfsCycle: ?string}[]} one entry per side
 */
export function parseFingerprints(output) {
    const sides = [];
    const at = (index) => {
        if (!sides[index]) sides[index] = { full: null, as40: null, dfsTitle: null, dfsCycle: null };
        return sides[index];
    };
    for (const line of output.split("\n")) {
        const full = /disc side (\d+) CRC32 fingerprint ([0-9A-F]+) title (.*) count ([0-9A-F]+)\s*$/.exec(line);
        if (full) {
            const side = at(Number(full[1]));
            side.full = full[2];
            side.dfsTitle = full[3];
            side.dfsCycle = full[4];
            continue;
        }
        const as40 = /disc side (\d+), as 40 track, CRC32 fingerprint ([0-9A-F]+)\s*$/.exec(line);
        if (as40) at(Number(as40[1])).as40 = as40[2];
    }
    return sides;
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
function checkIsHfe(bytes, entry) {
    const magic = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
    if (!HfeMagics.includes(magic))
        throw new Error(
            `${entry.blob}: expected an HFE image, got ${bytes.length} bytes starting ${JSON.stringify(magic)}. ` +
                `Drive may be refusing the download for ${entry.driveId}.`,
        );
}

async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return null;
    }
}

// So an interrupted run never leaves a truncated file that a later run would
// mistake for complete.
async function writeAtomically(dest, bytes) {
    const partial = `${dest}.part`;
    await writeFile(partial, bytes);
    await rename(partial, dest);
}

// Cache by Drive file id, which is immutable, rather than by anything derived
// from the sheet: a typo fixed in a title must not invalidate the download.
async function fetchDisc(entry, cacheDir) {
    const dest = join(cacheDir, `${entry.driveId}.hfe`);
    if ((await fileSize(dest)) !== null) return { path: dest, downloaded: false };
    const url = `${DriveDownload}?id=${entry.driveId}&export=download`;
    const bytes = new Uint8Array(await (await fetchWithRetry(url)).arrayBuffer());
    checkIsHfe(bytes, entry);
    await writeAtomically(dest, bytes);
    return { path: dest, downloaded: true };
}

// Running many beebjits at once turns up two races that have nothing to do
// with the disc: its JIT arena can find the fixed address already occupied,
// and a run this short can trip an assertion on the way out
// (scarybeasts/beebjit#62). Both pass on a retry; a disc that really disagrees
// with the catalogue fails by returning mismatches, not by exiting badly.
async function runBeebjitWithRetry(beebjitPath, discPath) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await runBeebjit(beebjitPath, discPath);
        } catch (error) {
            if (attempt === MaxRetries) throw error;
            await sleep(RetryDelayMs);
        }
    }
}

const lastLine = (text) => text.trim().split("\n").pop() ?? "";

// beebjit resolves its ROMs relative to the working directory, so run it from
// beside its own binary rather than from wherever the mirror is being built.
function runBeebjit(beebjitPath, discPath) {
    const args = ["-headless", "-fast", "-cycles", "1", "-log", "disc:fingerprint", "-disc", resolve(discPath)];
    return new Promise((resolve_, reject) => {
        const child = spawn(beebjitPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: dirname(beebjitPath) });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) resolve_(text);
            else reject(new Error(`beebjit ${signal ? `died with ${signal}` : `exited ${code}`}: ${lastLine(text)}`));
        });
    });
}

async function writeJson(dest, value) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(value, null, 2) + "\n");
}

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
 * Get a disc's bytes, preferring a blob we already hold over a fresh download.
 *
 * A published blob is the disc, so a mirror seeded from S3 can rebuild its
 * manifests, and reverify, without asking Drive for anything. Decompressing is
 * cheap next to the round trip it saves, and it proves the stored blob is
 * intact rather than assuming it.
 */
async function obtain(entry, blobDir, cacheDir) {
    const blobPath = join(blobDir, entry.blob);
    const published = await fileSize(blobPath);
    if (published !== null) {
        let raw;
        try {
            raw = await decompress(await readFile(blobPath));
        } catch (error) {
            throw new Error(
                `${entry.blob}: stored blob does not decompress. If the mirror was seeded from S3, check the ` +
                    `download did not decode Content-Encoding on the way.`,
                { cause: error },
            );
        }
        checkIsHfe(raw, entry);
        return { raw, size: published, downloaded: false, alreadyPublished: true };
    }
    const { path, downloaded } = await fetchDisc(entry, cacheDir);
    const raw = await readFile(path);
    return { raw, size: null, downloaded, alreadyPublished: false };
}

// A withdrawal has to take the cached original with it, or we quietly keep a
// copy of something we were asked to stop publishing.
async function prune(dir, wanted) {
    const stale = (await readdir(dir)).filter((name) => name.endsWith(".hfe") && !wanted.has(name));
    for (const name of stale) await rm(join(dir, name));
    return stale;
}

function fail(message) {
    stderr.write(`${message}\n`);
    exit(2);
}

function parseArgs(args) {
    const opts = {
        csv: null,
        out: null,
        concurrency: DefaultConcurrency,
        beebjit: env.BEEBJIT ?? null,
        limit: null,
        filter: null,
        checkOnly: false,
        reverify: false,
        source: null,
        credit: null,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--csv") opts.csv = args[++i];
        else if (arg === "--out") opts.out = args[++i];
        else if (arg === "--concurrency") opts.concurrency = Number(args[++i]);
        else if (arg === "--beebjit") opts.beebjit = args[++i];
        else if (arg === "--limit") opts.limit = Number(args[++i]);
        else if (arg === "--filter") opts.filter = args[++i]?.toLowerCase();
        else if (arg === "--check-only") opts.checkOnly = true;
        else if (arg === "--reverify") opts.reverify = true;
        else if (arg === "--source") opts.source = args[++i];
        else if (arg === "--credit") opts.credit = args[++i];
        else if (arg === "-h" || arg === "--help") {
            stdout.write(
                "Usage: mirror-bbcdiscs.js --csv <sheet.csv> --out <dir> [--beebjit <path>]\n" +
                    `       [--concurrency ${DefaultConcurrency}] [--limit N] [--filter <text>]\n` +
                    "       [--check-only] [--reverify] [--source <url>] [--credit <text>]\n",
            );
            exit(0);
        } else fail(`Unknown argument: ${arg}`);
    }
    if (!opts.csv) fail("--csv <sheet.csv> is required");
    if (!opts.out && !opts.checkOnly) fail("--out <dir> is required");
    if (opts.filter === undefined) fail("--filter needs a value");
    if (opts.limit !== null && (!Number.isInteger(opts.limit) || opts.limit < 1))
        fail("--limit must be a positive integer");
    // Publishing a disc means asserting it is the one the catalogue describes,
    // and only beebjit can tell us that, so there is no unverified path to S3.
    if (!opts.beebjit && !opts.checkOnly)
        fail("beebjit is required to verify discs before publishing: set BEEBJIT=<path> or pass --beebjit <path>");
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) fail("--concurrency must be a positive integer");
    return opts;
}

async function main() {
    const opts = parseArgs(argv.slice(2));
    const rows = parseCsv(await readFile(opts.csv, "utf8"));
    const { entries, withheld, problems } = parseCatalogue(rows);

    stderr.write(`${rows.length} rows: ${entries.length} to mirror, ${withheld.length} catalogued but not published\n`);
    for (const problem of problems) stderr.write(`  PROBLEM ${problem}\n`);
    if (problems.length) stderr.write(`${problems.length} row(s) need fixing in the sheet; they are not mirrored\n`);

    if (opts.checkOnly) return;

    // Before the downloading, not after it.
    try {
        await access(opts.beebjit, fsConstants.X_OK);
    } catch {
        fail(`Cannot run beebjit at ${opts.beebjit}: set BEEBJIT=<path> or pass --beebjit <path>`);
    }

    let selected = entries;
    if (opts.filter)
        selected = selected.filter((entry) => `${entry.publisher} ${entry.title}`.toLowerCase().includes(opts.filter));
    if (opts.limit !== null) selected = selected.slice(0, opts.limit);
    const partial = selected.length !== entries.length;
    if (partial) stderr.write(`Selecting ${selected.length} of ${entries.length} discs\n`);

    const cacheDir = join(opts.out, "cache");
    const blobDir = join(opts.out, CategoryId);
    await mkdir(cacheDir, { recursive: true });
    await mkdir(blobDir, { recursive: true });

    const results = new Map();
    const failures = [];
    let downloaded = 0;
    let held = 0;
    await forEachConcurrently(selected, opts.concurrency, async (entry) => {
        try {
            const { raw, size, downloaded: isNew, alreadyPublished } = await obtain(entry, blobDir, cacheDir);
            if (isNew) downloaded++;
            if (alreadyPublished) held++;

            // A published blob has already been checked, and its name is the
            // fingerprint, so a changed CRC32 arrives as a new blob rather than
            // as a disc that needs looking at again.
            if (!alreadyPublished || opts.reverify) {
                const discPath = join(cacheDir, `${entry.driveId}.hfe`);
                if ((await fileSize(discPath)) === null) await writeAtomically(discPath, raw);
                const mismatches = compareFingerprints(
                    entry,
                    parseFingerprints(await runBeebjitWithRetry(opts.beebjit, discPath)),
                );
                if (mismatches.length) {
                    failures.push(
                        `${entry.blob} (${entry.publisher} ${entry.title})\n    ${mismatches.join("\n    ")}`,
                    );
                    return;
                }
            }
            results.set(entry.blob, {
                size: size ?? (await compressTo(join(blobDir, entry.blob), raw)),
                originalSize: raw.length,
            });
        } catch (error) {
            failures.push(`${entry.blob} (${entry.publisher} ${entry.title}): ${error.message}`);
        }
    });

    stderr.write(
        `Downloaded ${downloaded}, already mirrored ${held}, cached from an earlier run ` +
            `${selected.length - downloaded - held}\n`,
    );
    for (const failure of failures) stderr.write(`  FAILED ${failure}\n`);

    const files = selected
        .filter((entry) => results.has(entry.blob))
        .map((entry) => {
            const { size, originalSize } = results.get(entry.blob);
            return withoutEmpties({
                path: entry.blob,
                size,
                originalSize,
                encoding: "br",
                title: entry.title,
                publisher: entry.publisher,
                disc: entry.disc,
                tracks: entry.tracks,
                variant: entry.variant,
                crc32: entry.crc32,
                crc32As40: entry.crc32As40,
                dfsTitle: entry.dfsTitle,
                dfsCycle: entry.dfsCycle,
                grabVersion: entry.grabVersion,
                date: entry.date,
                submitter: entry.submitter,
                notes: entry.notes,
            });
        });

    // Keyed on what the catalogue still asks for, not on what verified: a disc
    // that failed today is withheld from the manifest but keeps whatever blob
    // it already had, where one it no longer lists is gone for good. A changed
    // CRC32 arrives as a new blob name, so the old one falls out of here too.
    let stale = [];
    if (!partial) {
        stale = await prune(blobDir, new Set(selected.map((entry) => entry.blob)));
        await prune(cacheDir, new Set(entries.map((entry) => `${entry.driveId}.hfe`)));
    }
    for (const name of stale) stderr.write(`  WITHDRAWN ${name}\n`);

    // Manifests describe the whole archive, and the upload deletes whatever
    // they leave out, so a run that only looked at some of it must not write
    // them.
    if (partial) {
        stderr.write(`\n${files.length} of ${selected.length} selected discs published; manifests left alone\n`);
        if (failures.length) exit(1);
        return;
    }

    await writeJson(join(blobDir, "manifest.json"), { schemaVersion: SchemaVersion, files });
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const originalBytes = files.reduce((total, file) => total + file.originalSize, 0);
    // Where the catalogue came from and how its owner wants crediting are for
    // whoever runs the mirror to agree with them, not for this repository to
    // assert on their behalf.
    await writeJson(
        join(opts.out, "manifest.json"),
        withoutEmpties({
            schemaVersion: SchemaVersion,
            name: CategoryTitle,
            source: opts.source,
            credit: opts.credit,
            scrapedAt: new Date().toISOString(),
            categories: [
                {
                    id: CategoryId,
                    title: CategoryTitle,
                    manifest: `${CategoryId}/manifest.json`,
                    fileCount: files.length,
                    totalBytes,
                },
            ],
        }),
    );

    stderr.write(
        `\nWrote manifest: ${files.length} discs, ${(totalBytes / 1024 / 1024).toFixed(1)} MB ` +
            `(${(originalBytes / 1024 / 1024).toFixed(1)} MB uncompressed)\n`,
    );
    if (failures.length) exit(1);
}

// Only run the mirror when invoked as a script, so the parsers can be tested.
if (basename(argv[1] ?? "") === "mirror-bbcdiscs.js") {
    main().catch((error) => {
        stderr.write(`\nERROR: ${error.stack ?? error.message ?? error}\n`);
        exit(1);
    });
}
