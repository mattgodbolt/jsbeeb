#!/usr/bin/env node
/**
 * Mirror the Stairway to Hell BBC Micro software archive into a local
 * directory tree. The output is structured to be sync'd as-is into
 * s3://bbc.xania.org/archive/sth/ — see tools/README-sth-mirror.md and
 * .github/workflows/mirror-sth.yml.
 *
 * Usage:
 *   node tools/mirror-sth.js --out <dir> [--concurrency 8]
 *                            [--source <id>] [--quick]
 *
 * Self-contained: relies only on Node 22 builtins (fetch, fs/promises).
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

const STH_ROOT = "https://www.stairwaytohell.com";
const USER_AGENT = "jsbeeb-mirror (+https://github.com/mattgodbolt/jsbeeb)";
const SCHEMA_VERSION = 1;

// Each "category" is one downloadable section of the STH archive.
//   id       — directory name we use under archive/sth/
//   title    — human-friendly label for the top-level manifest
//   indexUrl — page to fetch to enumerate files
//   indexer  — function that turns the index page into [{ path, size, mtime }]
//   fileBase — URL prefix that .path is resolved against to GET each file
//   source   — URL we record in the manifest as the upstream
const CATEGORIES = [
    {
        id: "diskimages",
        title: "Disk Images",
        indexUrl: `${STH_ROOT}/bbc/archive/diskimages/reclist.php?sort=name&filter=.zip`,
        indexer: parseReclist,
        fileBase: `${STH_ROOT}/bbc/archive/diskimages/`,
        source: `${STH_ROOT}/bbc/archive/diskimages/`,
    },
    {
        id: "tapeimages",
        title: "Tape Images",
        indexUrl: `${STH_ROOT}/bbc/archive/tapeimages/reclist.php?sort=name&filter=.zip`,
        indexer: parseReclist,
        fileBase: `${STH_ROOT}/bbc/archive/tapeimages/`,
        source: `${STH_ROOT}/bbc/archive/tapeimages/`,
    },
    {
        id: "sthcollection",
        title: "STH Collection",
        indexUrl: `${STH_ROOT}/bbc/sthcollection.html`,
        indexer: parseSthCollection,
        fileBase: `${STH_ROOT}/bbc/`,
        source: `${STH_ROOT}/bbc/sthcollection.html`,
    },
    {
        id: "other/educational",
        title: "Educational",
        indexUrl: `${STH_ROOT}/bbc/other/educational/reclist.php?sort=name&filter=.zip`,
        indexer: parseReclist,
        fileBase: `${STH_ROOT}/bbc/other/educational/`,
        source: `${STH_ROOT}/bbc/other/educational/`,
    },
];

// Small auxiliary files saved verbatim under meta/ for provenance.
const META_FILES = [
    { url: `${STH_ROOT}/bbc/disklog.txt`, dest: "meta/disklog.txt" },
    { url: `${STH_ROOT}/bbc/tapelog.txt`, dest: "meta/tapelog.txt" },
    { url: `${STH_ROOT}/bbc/homepage.html`, dest: "meta/homepage.html" },
    { url: `${STH_ROOT}/bbc/diskimages.html`, dest: "meta/diskimages.html" },
    { url: `${STH_ROOT}/bbc/tapeimages.html`, dest: "meta/tapeimages.html" },
    { url: `${STH_ROOT}/bbc/sthcollection.html`, dest: "meta/sthcollection.html" },
    { url: `${STH_ROOT}/bbc/other.html`, dest: "meta/other.html" },
];

function parseArgs(args) {
    const opts = { out: null, concurrency: 8, source: null, quick: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--out") opts.out = args[++i];
        else if (a === "--concurrency") opts.concurrency = Number(args[++i]);
        else if (a === "--source") opts.source = args[++i];
        else if (a === "--quick") opts.quick = true;
        else if (a === "-h" || a === "--help") {
            stdout.write(`Usage: mirror-sth.js --out <dir> [--concurrency 8] [--source <id>] [--quick]\n`);
            exit(0);
        } else {
            stderr.write(`Unknown argument: ${a}\n`);
            exit(2);
        }
    }
    if (!opts.out) {
        stderr.write("--out <dir> is required\n");
        exit(2);
    }
    if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
        stderr.write("--concurrency must be a positive integer\n");
        exit(2);
    }
    return opts;
}

async function fetchWithRetry(url, init = {}, { retries = 2 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                ...init,
                headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
            });
            if (!res.ok) {
                if (res.status >= 500 && attempt < retries) {
                    await sleep(500 * (attempt + 1));
                    continue;
                }
                throw new Error(`HTTP ${res.status} for ${url}`);
            }
            return res;
        } catch (err) {
            lastErr = err;
            if (attempt < retries) await sleep(500 * (attempt + 1));
        }
    }
    throw lastErr;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Strip HTML tags from a fragment.
function stripTags(s) {
    return s.replace(/<[^>]*>/g, "").trim();
}

// Parse a Last-Modified-style date (e.g. "Mar 31 2010 10:33:18") into ISO 8601.
// STH serves these in UTC; we treat them as UTC for stable round-tripping.
function parseStModifiedDate(s) {
    const cleaned = s.replace(/&nbsp;/g, " ").trim();
    const t = Date.parse(cleaned + " UTC");
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
}

// Parse a reclist.php page. Each data row is a <TR> with three <TD>s:
// size, modified-date, and an anchor pointing at the file path (relative
// to the directory the reclist is in). The third <TD> may also contain a
// "(publisher)" link we must ignore — match the FIRST <a href> in the cell,
// matching what jsbeeb's existing scraper does (src/sth.js).
function parseReclist(html) {
    const rows = html.match(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi) ?? [];
    const files = [];
    for (const row of rows) {
        const tds = [...row.matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map((m) => m[1]);
        if (tds.length < 3) continue;
        const sizeText = stripTags(tds[0]);
        const dateText = stripTags(tds[1]);
        if (!/^\d+$/.test(sizeText)) continue; // skip header rows
        const hrefMatch = tds[2].match(/<a\s+[^>]*href="([^"]+)"/i);
        if (!hrefMatch) continue;
        const path = hrefMatch[1];
        if (!path.toLowerCase().endsWith(".zip")) continue;
        files.push({
            path,
            size: Number(sizeText),
            mtime: parseStModifiedDate(dateText),
        });
    }
    return files;
}

// Parse bbc/sthcollection.html — a hand-rolled list of <a href="sthcollection/X.zip">.
// No size/mtime in the index, so size is filled in later via HEAD requests.
function parseSthCollection(html) {
    const hrefs = [...html.matchAll(/href="(sthcollection\/[^"]+\.zip)"/gi)].map((m) => m[1]);
    // Strip the leading "sthcollection/" so paths are relative to the category root,
    // matching how parseReclist returns them.
    return [...new Set(hrefs)].sort().map((href) => ({
        path: href.replace(/^sthcollection\//, ""),
        size: null,
        mtime: null,
    }));
}

// URL-encode the path components in a STH-relative path, preserving slashes.
function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

async function fileExistsWithSize(path, expected) {
    try {
        const s = await stat(path);
        return s.isFile() && (expected == null || s.size === expected);
    } catch {
        return false;
    }
}

async function downloadFile(url, dest) {
    await ensureDir(dirname(dest));
    const res = await fetchWithRetry(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    const lastModified = res.headers.get("last-modified");
    const mtime = lastModified ? new Date(lastModified).toISOString() : null;
    return { size: buf.length, mtime };
}

// A simple bounded-concurrency pool. Returns when every task has settled;
// throws on the first error.
async function runPool(items, concurrency, worker) {
    let next = 0;
    let firstError = null;
    let completed = 0;
    const total = items.length;
    let lastReport = 0;

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            if (firstError) return;
            const i = next++;
            if (i >= items.length) return;
            try {
                await worker(items[i], i);
            } catch (err) {
                if (!firstError) firstError = err;
                return;
            }
            completed++;
            const now = Date.now();
            if (now - lastReport > 2000 || completed === total) {
                lastReport = now;
                stderr.write(`  ${completed}/${total}\n`);
            }
        }
    });
    await Promise.all(runners);
    if (firstError) throw firstError;
}

async function indexCategory(cat) {
    stderr.write(`\n[${cat.id}] indexing ${cat.indexUrl}\n`);
    const res = await fetchWithRetry(cat.indexUrl);
    const html = await res.text();
    const entries = cat.indexer(html);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    stderr.write(`[${cat.id}] ${entries.length} files\n`);
    return entries;
}

async function fillMissingMetadata(cat, entries, concurrency) {
    // sthcollection's index lacks size/mtime — HEAD each file to get them.
    const needs = entries.filter((e) => e.size == null || e.mtime == null);
    if (needs.length === 0) return;
    stderr.write(`[${cat.id}] HEADing ${needs.length} files for size/mtime\n`);
    await runPool(needs, concurrency, async (entry) => {
        const url = cat.fileBase + encodePath(entry.path);
        const res = await fetchWithRetry(url, { method: "HEAD" });
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len)) entry.size = len;
        const lm = res.headers.get("last-modified");
        if (lm) entry.mtime = new Date(lm).toISOString();
    });
}

async function downloadCategory(cat, entries, outRoot, concurrency) {
    const categoryRoot = join(outRoot, cat.id);
    let skipped = 0;
    let downloaded = 0;
    await runPool(entries, concurrency, async (entry) => {
        const dest = join(categoryRoot, entry.path);
        if (await fileExistsWithSize(dest, entry.size)) {
            skipped++;
            return;
        }
        const url = cat.fileBase + encodePath(entry.path);
        const result = await downloadFile(url, dest);
        // Trust the HTTP response if it disagreed with the index — keeps the
        // manifest honest even if STH's reclist gets out of sync.
        if (entry.size == null) entry.size = result.size;
        if (entry.mtime == null) entry.mtime = result.mtime;
        downloaded++;
    });
    stderr.write(`[${cat.id}] downloaded ${downloaded}, skipped ${skipped} (already present)\n`);
}

async function writeCategoryManifest(cat, entries, outRoot) {
    const dest = join(outRoot, cat.id, "manifest.json");
    await ensureDir(dirname(dest));
    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        files: entries.map(({ path, size, mtime }) => ({ path, size, mtime })),
    };
    await writeFile(dest, JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
}

async function downloadMetaFiles(outRoot, concurrency) {
    stderr.write(`\n[meta] fetching ${META_FILES.length} auxiliary files\n`);
    await runPool(META_FILES, concurrency, async (m) => {
        const dest = join(outRoot, m.dest);
        const res = await fetchWithRetry(m.url);
        const buf = Buffer.from(await res.arrayBuffer());
        await ensureDir(dirname(dest));
        await writeFile(dest, buf);
    });
}

async function writeTopLevelManifest(outRoot, perCategory) {
    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        name: "Stairway to Hell BBC Micro Software Archive",
        source: `${STH_ROOT}/bbc/`,
        scrapedAt: new Date().toISOString(),
        categories: perCategory.map(({ cat, entries }) => ({
            id: cat.id,
            title: cat.title,
            manifest: posix.join(cat.id, "manifest.json"),
            source: cat.source,
            fileCount: entries.length,
            totalBytes: entries.reduce((sum, e) => sum + (e.size ?? 0), 0),
        })),
    };
    const dest = join(outRoot, "manifest.json");
    await writeFile(dest, JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
}

async function main() {
    const opts = parseArgs(argv.slice(2));
    const outRoot = opts.out;
    await ensureDir(outRoot);

    const wantedCategories = opts.source ? CATEGORIES.filter((c) => c.id === opts.source) : CATEGORIES;
    if (opts.source && wantedCategories.length === 0) {
        stderr.write(`Unknown --source: ${opts.source}\n`);
        stderr.write(`Known sources: ${CATEGORIES.map((c) => c.id).join(", ")}\n`);
        exit(2);
    }

    const perCategory = [];
    for (const cat of wantedCategories) {
        const entries = await indexCategory(cat);
        if (!opts.quick) {
            await fillMissingMetadata(cat, entries, opts.concurrency);
            await downloadCategory(cat, entries, outRoot, opts.concurrency);
        }
        await writeCategoryManifest(cat, entries, outRoot);
        perCategory.push({ cat, entries });
    }

    if (!opts.quick) await downloadMetaFiles(outRoot, opts.concurrency);

    // Only rewrite the top-level manifest when scraping the full set, so a
    // single-source partial run (e.g. --source diskimages) doesn't drop the
    // other categories out of the index.
    if (!opts.source) {
        const top = await writeTopLevelManifest(outRoot, perCategory);
        stderr.write(
            `\nWrote top-level manifest: ${top.categories.length} categories, ` +
                `${top.categories.reduce((n, c) => n + c.fileCount, 0)} files, ` +
                `${(top.categories.reduce((n, c) => n + c.totalBytes, 0) / 1024 / 1024).toFixed(1)} MB\n`,
        );
    }
}

main().catch((err) => {
    stderr.write(`\nERROR: ${err.stack ?? err.message ?? err}\n`);
    exit(1);
});
