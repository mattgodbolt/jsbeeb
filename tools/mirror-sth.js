#!/usr/bin/env node
/**
 * Mirror the Stairway to Hell software archive into a local directory tree,
 * ready to be uploaded as-is to s3://bbc.xania.org/archive/sth/.
 *
 * See tools/README-sth-mirror.md for the manifest format and upload steps.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

const SthRoot = "https://www.stairwaytohell.com";
const UserAgent = "jsbeeb-mirror (+https://github.com/mattgodbolt/jsbeeb)";
const SchemaVersion = 1;
const ProgressEvery = 100;

// Each category is one section of the archive. `id` doubles as the directory
// name under archive/sth/, so the mirror's layout matches STH's own. `files`
// is both where the zips are fetched from and the filter for which links on
// the index page count as downloads — anything resolving outside it (an
// external link, a `../` cross-reference to another category) is ignored.
const Categories = [
    {
        id: "diskimages",
        title: "BBC Disk Images",
        index: `${SthRoot}/bbc/archive/diskimages/reclist.php?sort=name&filter=.zip`,
        files: `${SthRoot}/bbc/archive/diskimages/`,
    },
    {
        id: "tapeimages",
        title: "BBC Tape Images",
        index: `${SthRoot}/bbc/archive/tapeimages/reclist.php?sort=name&filter=.zip`,
        files: `${SthRoot}/bbc/archive/tapeimages/`,
    },
    {
        id: "sthcollection",
        title: "STH Collection",
        index: `${SthRoot}/bbc/sthcollection.html`,
        files: `${SthRoot}/bbc/sthcollection/`,
    },
    {
        id: "other/educational",
        title: "BBC Educational",
        index: `${SthRoot}/bbc/other/educational/reclist.php?sort=name&filter=.zip`,
        files: `${SthRoot}/bbc/other/educational/`,
    },
    {
        id: "roms",
        title: "BBC and Electron ROMs",
        index: `${SthRoot}/roms/homepage.html`,
        files: `${SthRoot}/roms/`,
    },
    {
        id: "electron/uefarchive",
        title: "Electron Tape Images",
        index: `${SthRoot}/electron/uefarchive/reclist.php?sort=name&filter=.zip`,
        files: `${SthRoot}/electron/uefarchive/`,
    },
    {
        id: "electron/dfs",
        title: "Electron DFS Disk Images",
        index: `${SthRoot}/electron/dfs/homepage.html`,
        files: `${SthRoot}/electron/dfs/`,
    },
    {
        id: "electron/adfs",
        title: "Electron ADFS Disk Images",
        index: `${SthRoot}/electron/adfs/homepage.html`,
        files: `${SthRoot}/electron/adfs/`,
    },
    {
        id: "electron/multiplexing",
        title: "Electron Multiplexing",
        index: `${SthRoot}/electron/multiplexing/homepage.html`,
        files: `${SthRoot}/electron/multiplexing/`,
    },
    {
        id: "electron/t2p3",
        title: "Electron T2P3",
        index: `${SthRoot}/electron/t2p3/homepage.html`,
        files: `${SthRoot}/electron/t2p3/`,
    },
];

// Upstream changelogs and index pages, saved verbatim under meta/ as provenance.
const MetaFiles = [
    { url: `${SthRoot}/bbc/disklog.txt`, dest: "meta/bbc-disklog.txt" },
    { url: `${SthRoot}/bbc/tapelog.txt`, dest: "meta/bbc-tapelog.txt" },
    { url: `${SthRoot}/bbc/homepage.html`, dest: "meta/bbc-homepage.html" },
    { url: `${SthRoot}/bbc/diskimages.html`, dest: "meta/bbc-diskimages.html" },
    { url: `${SthRoot}/bbc/tapeimages.html`, dest: "meta/bbc-tapeimages.html" },
    { url: `${SthRoot}/bbc/sthcollection.html`, dest: "meta/bbc-sthcollection.html" },
    { url: `${SthRoot}/bbc/other.html`, dest: "meta/bbc-other.html" },
    { url: `${SthRoot}/roms/homepage.html`, dest: "meta/roms-homepage.html" },
    { url: `${SthRoot}/electron/homepage.html`, dest: "meta/electron-homepage.html" },
    { url: `${SthRoot}/electron/other.html`, dest: "meta/electron-other.html" },
];

/**
 * Find the downloadable zips on a category's index page.
 *
 * STH's index pages come in two flavours — generated `reclist.php` tables and
 * hand-written `homepage.html` link lists — but both boil down to relative
 * anchors pointing at zips in the category's own directory, so one pass over
 * the raw HTML handles both. The `[^"?]` rules out `reclist.php`'s own "sort
 * by size" links, which end in ".zip" only because of the query string.
 *
 * Paths come back relative to `filesUrl` and decoded, matching the hrefs as
 * written upstream — jsbeeb's `sth:` URLs embed these verbatim.
 *
 * @param {string} html raw index page
 * @param {string} indexUrl absolute URL the page was fetched from
 * @param {string} filesUrl absolute URL prefix the category's zips live under
 * @returns {string[]} sorted, deduplicated paths
 */
export function parseZipLinks(html, indexUrl, filesUrl) {
    const paths = new Set();
    for (const [, href] of html.matchAll(/href="([^"?]+\.zip)"/gi)) {
        const resolved = new URL(href, indexUrl).href;
        if (resolved.startsWith(filesUrl)) paths.add(decodeURIComponent(resolved.slice(filesUrl.length)));
    }
    return [...paths].sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// STH is a slow, volunteer-run box that intermittently drops connections, so
// retry transient failures rather than abandon a multi-thousand-file run.
async function fetchWithRetry(url, retries = 3) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url, { headers: { "user-agent": UserAgent } });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return response;
        } catch (error) {
            if (attempt === retries) throw error;
            await sleep(500 * (attempt + 1));
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

// Download to a temporary name and rename into place, so an interrupted run
// never leaves a truncated file that a later run would mistake for complete.
async function download(url, dest) {
    await mkdir(dirname(dest), { recursive: true });
    const response = await fetchWithRetry(url);
    const partial = `${dest}.part`;
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await rename(partial, dest);
}

async function fileSize(path) {
    try {
        return (await stat(path)).size;
    } catch {
        return null;
    }
}

async function index(category) {
    stderr.write(`\n[${category.id}] indexing ${category.index}\n`);
    const html = await (await fetchWithRetry(category.index)).text();
    const paths = parseZipLinks(html, category.index, category.files);
    stderr.write(`[${category.id}] ${paths.length} files\n`);
    return paths;
}

// Downloads whatever is missing and returns manifest entries whose sizes come
// from the files on disk — so the manifest describes what we actually have
// rather than what an index page claimed.
async function downloadCategory(category, paths, outRoot, concurrency) {
    let downloaded = 0;
    const files = [];
    await forEachConcurrently(paths, concurrency, async (path) => {
        const dest = join(outRoot, category.id, path);
        let size = await fileSize(dest);
        if (size === null) {
            await download(category.files + encodeURI(path), dest);
            size = await fileSize(dest);
            downloaded++;
        }
        files.push({ path, size });
    });
    stderr.write(`[${category.id}] downloaded ${downloaded}, already present ${paths.length - downloaded}\n`);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
}

async function writeJson(dest, value) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(value, null, 2) + "\n");
}

async function downloadMetaFiles(outRoot, concurrency) {
    stderr.write(`\n[meta] fetching ${MetaFiles.length} auxiliary files\n`);
    await forEachConcurrently(MetaFiles, concurrency, (meta) => download(meta.url, join(outRoot, meta.dest)));
}

function fail(message) {
    stderr.write(`${message}\n`);
    exit(2);
}

function parseArgs(args) {
    const categoryIds = Categories.map((category) => category.id).join(", ");
    const opts = { out: null, concurrency: 8, category: null, indexOnly: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--out") opts.out = args[++i];
        else if (arg === "--concurrency") opts.concurrency = Number(args[++i]);
        else if (arg === "--category") opts.category = args[++i];
        else if (arg === "--index-only") opts.indexOnly = true;
        else if (arg === "-h" || arg === "--help") {
            stdout.write("Usage: mirror-sth.js --out <dir> [--concurrency 8] [--category <id>] [--index-only]\n");
            stdout.write(`Categories: ${categoryIds}\n`);
            exit(0);
        } else fail(`Unknown argument: ${arg}`);
    }
    if (!opts.out && !opts.indexOnly) fail("--out <dir> is required");
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) fail("--concurrency must be a positive integer");
    if (opts.category && !Categories.some((category) => category.id === opts.category))
        fail(`Unknown --category: ${opts.category}\nCategories: ${categoryIds}`);
    return opts;
}

async function main() {
    const opts = parseArgs(argv.slice(2));
    const categories = opts.category ? Categories.filter((category) => category.id === opts.category) : Categories;

    // --index-only is a cheap check that STH's pages still parse the way we
    // expect; it writes nothing, so it can't leave a half-populated mirror
    // lying around for someone to upload by mistake.
    if (opts.indexOnly) {
        for (const category of categories) await index(category);
        return;
    }

    const summaries = [];
    for (const category of categories) {
        const paths = await index(category);
        const files = await downloadCategory(category, paths, opts.out, opts.concurrency);
        await writeJson(join(opts.out, category.id, "manifest.json"), { schemaVersion: SchemaVersion, files });
        summaries.push({
            id: category.id,
            title: category.title,
            manifest: posix.join(category.id, "manifest.json"),
            source: category.files,
            fileCount: files.length,
            totalBytes: files.reduce((total, file) => total + file.size, 0),
        });
    }

    // A single-category run only knows about its own category, so leave the
    // top-level manifest alone rather than drop the others out of it.
    if (opts.category) {
        stderr.write("\nSingle category: top-level manifest left unchanged\n");
        return;
    }

    await downloadMetaFiles(opts.out, opts.concurrency);
    await writeJson(join(opts.out, "manifest.json"), {
        schemaVersion: SchemaVersion,
        name: "Stairway to Hell BBC Micro Software Archive",
        source: `${SthRoot}/`,
        scrapedAt: new Date().toISOString(),
        categories: summaries,
    });
    const fileCount = summaries.reduce((total, category) => total + category.fileCount, 0);
    const megabytes = summaries.reduce((total, category) => total + category.totalBytes, 0) / 1024 / 1024;
    stderr.write(`\nWrote manifest: ${summaries.length} categories, ${fileCount} files, ${megabytes.toFixed(1)} MB\n`);
}

// Only run the mirror when invoked as a script, so the parser can be tested.
if (argv[1]?.endsWith("mirror-sth.js")) {
    main().catch((error) => {
        stderr.write(`\nERROR: ${error.stack ?? error.message ?? error}\n`);
        exit(1);
    });
}
