#!/usr/bin/env node
// Computes the findings' numbers that come from the indexes build-index.js writes
// (the rest come from fill-survey.js, check-paths.js and split-diffs.js):
//   index.jsonl            every source, under the proposal's rules
//   hfe-first-draft.jsonl  the HFE mirror under the first draft's (--track-rule strict
//                          --pitch-test headers)
//   hfe-headers.jsonl      the HFE mirror with only the pitch test reverted
//                          (--pitch-test headers)
// plus MAME's bbcb_flop.xml from fetch-corpus.js.
//
//   node tools/registry/analyse.js [--corpus .registry-corpus] [--family exile]
//
// --family lists every image whose title, path or disc title matches, with its
// files, for looking at one game's versions by hand.

import { readFile } from "node:fs/promises";
import path from "node:path";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const family = arg("--family", null);

const readJsonl = async (name) =>
    (await readFile(path.join(corpus, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

const countBy = (items, keyOf) => {
    const counts = new Map();
    for (const item of items) {
        const key = keyOf(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
};
const groupBy = (items, keyOf) => {
    const groups = new Map();
    for (const item of items) {
        const key = keyOf(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
};
const print = (label, value) => console.log(`${label}: ${typeof value === "object" ? JSON.stringify(value) : value}`);

// A title's words, for spotting keys shared by captures whose titles have nothing in common.
const titleWords = (title) =>
    new Set(
        (title ?? "")
            .toLowerCase()
            .split(/\s+/)
            .map((word) => word.replace(/[^a-z0-9]/g, ""))
            .filter(Boolean),
    );
const shareAWord = (a, b) => [...titleWords(a)].some((word) => titleWords(b).has(word));

const catalogueFiles = (row) =>
    (row.catalogues ?? []).filter(Boolean).flatMap((catalogue) => catalogue.files.filter((file) => file.complete));
const fileSetKey = (row) => {
    const files = catalogueFiles(row);
    if (files.length === 0) return null;
    return JSON.stringify(files.map((f) => [f.name, f.load, f.exec, f.hash]).sort());
};

function unrelatedTitleKeys(rows) {
    const out = [];
    for (const group of groupBy(rows, (row) => row.discKey).values()) {
        const titles = [...new Set(group.map((row) => row.meta?.title))];
        const unrelated = titles.some((a, i) => titles.slice(i + 1).some((b) => !shareAWord(a, b)));
        if (unrelated) out.push(titles);
    }
    return out;
}

async function main() {
    const all = await readJsonl("index.jsonl");
    const rows = all.filter((row) => !row.error);
    for (const row of all.filter((r) => r.error)) console.log(`skipped ${row.source}:${row.ref}: ${row.error}`);
    const hfe = rows.filter((row) => row.source === "hfe");

    console.log("== Corpus");
    print("images by source", Object.fromEntries(countBy(rows, (row) => row.source)));
    print("images by source and type", Object.fromEntries(countBy(rows, (row) => `${row.source} ${row.ext}`)));
    for (const source of ["hfe", "sth", "bbcmicro"]) {
        const these = rows.filter((row) => row.source === source);
        print(
            `${source} distinct file keys / disc keys`,
            `${new Set(these.map((r) => r.fileKey)).size} / ${new Set(these.map((r) => r.discKey)).size}`,
        );
    }
    print("all distinct file keys", new Set(rows.map((r) => r.fileKey)).size);
    print("all distinct disc keys", new Set(rows.map((r) => r.discKey)).size);
    print(
        "disc keys covering more than one file",
        [...groupBy(rows, (r) => r.discKey).values()].filter((g) => new Set(g.map((r) => r.fileKey)).size > 1).length,
    );

    console.log("\n== Across sources");
    const sourcesOf = (keyOf) =>
        [...groupBy(rows.filter(keyOf), keyOf).values()]
            .map((group) => [...new Set(group.map((row) => row.source))].sort().join("+"))
            .filter((combo) => combo.includes("+"));
    print(
        "disc keys in more than one source",
        Object.fromEntries(
            countBy(
                sourcesOf((r) => r.discKey),
                (c) => c,
            ),
        ),
    );
    print("file-set keys in more than one source", sourcesOf(fileSetKey).length);

    // Near misses: an HFE capture with exactly the same DFS files (names and contents) as
    // an archive image, but a different disc key. Each is classed by whether the files sit
    // at the same sectors in both, and whether the disc title and cycle number agree.
    const nameAndHash = (row) =>
        JSON.stringify(
            catalogueFiles(row)
                .map((f) => [f.name, f.hash])
                .sort(),
        );
    const archiveByFiles = groupBy(
        rows.filter((row) => row.source !== "hfe" && catalogueFiles(row).length),
        nameAndHash,
    );
    const nearMisses = [];
    for (const capture of hfe) {
        if (!catalogueFiles(capture).length) continue;
        for (const partner of archiveByFiles.get(nameAndHash(capture)) ?? [])
            if (partner.discKey !== capture.discKey) nearMisses.push({ capture, partner });
    }
    const starts = (row) =>
        JSON.stringify(
            catalogueFiles(row)
                .map((f) => [f.name, f.start])
                .sort(),
        );
    const header = (row) => `${row.catalogues[0]?.title}/${row.catalogues[0]?.cycle}`;
    print(
        "HFE captures with an archive image's exact files but another key",
        new Set(nearMisses.map((m) => m.capture.ref)).size,
    );
    print(
        "  of which have a Stairway To Hell partner",
        new Set(nearMisses.filter((m) => m.partner.source === "sth").map((m) => m.capture.ref)).size,
    );
    print(
        "  pairs by layout and catalogue header",
        Object.fromEntries(
            countBy(
                nearMisses,
                ({ capture, partner }) =>
                    `${starts(capture) === starts(partner) ? "same" : "moved"} files, ${header(capture) === header(partner) ? "same" : "different"} title/cycle`,
            ),
        ),
    );
    for (const { capture, partner } of nearMisses)
        console.log(
            `    ${capture.meta?.title} (${capture.ref}) / ${partner.source}: ${starts(capture) === starts(partner) ? "same" : "moved"} files, ${header(capture) === header(partner) ? "same" : "different"} title/cycle`,
        );

    // How often an archive SSD that shares most of a capture's files has put them somewhere else.
    const bigFiles = (row) =>
        new Map(
            catalogueFiles(row)
                .filter((f) => f.length >= 512)
                .map((f) => [f.hash, f.start]),
        );
    const sthRows = rows.filter((row) => row.source === "sth");
    const sthByFile = new Map();
    for (const row of sthRows)
        for (const hash of bigFiles(row).keys()) sthByFile.set(hash, [...(sthByFile.get(hash) ?? []), row]);
    const layouts = { moved: 0, same: 0 };
    for (const capture of hfe) {
        const mine = bigFiles(capture);
        if (mine.size < 2) continue;
        const counts = new Map();
        for (const hash of mine.keys())
            for (const row of sthByFile.get(hash) ?? []) counts.set(row, (counts.get(row) ?? 0) + 1);
        const [best, shared] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
        if (!best || shared * 2 < mine.size) continue;
        const theirs = bigFiles(best);
        const moved = [...mine].some(([hash, start]) => theirs.has(hash) && theirs.get(hash) !== start);
        layouts[moved ? "moved" : "same"]++;
    }
    print("captures sharing at least half their files with an STH SSD, by where the shared files sit", layouts);

    console.log("\n== Wrong-track sectors the first draft dropped from side 0 of the HFE captures");
    const firstDraft = await readJsonl("hfe-first-draft.jsonl");
    print(
        "captures by count",
        Object.fromEntries(
            countBy(firstDraft, (row) => {
                const n = row.flux[0].dropped.wrongTrack;
                return n === 0 ? "none" : n <= 10 ? "1-10" : n <= 100 ? "11-100" : "over 100";
            }),
        ),
    );

    console.log("\n== The first draft's rule against the proposal's");
    const strict = new Map((await readJsonl("hfe-first-draft.jsonl")).map((row) => [row.ref, row]));
    const plain = hfe.filter((row) => strict.get(row.ref).flux[0].dropped.wrongTrack === 0);
    print(
        "captures the first draft dropped no wrong-track sectors from, key unchanged",
        `${plain.filter((row) => strict.get(row.ref).discKey === row.discKey).length} of ${plain.length}`,
    );
    print(
        "distinct keys, first draft / proposal",
        `${new Set([...strict.values()].map((r) => r.discKey)).size} / ${new Set(hfe.map((r) => r.discKey)).size}`,
    );
    const unrelatedStrict = unrelatedTitleKeys([...strict.values()]);
    const unrelatedNow = unrelatedTitleKeys(hfe);
    print("keys shared by titles with no word in common, first draft", unrelatedStrict.length);
    for (const titles of unrelatedStrict) console.log(`    ${titles.join(" / ")}`);
    print("keys shared by titles with no word in common, proposal", unrelatedNow.length);
    for (const titles of unrelatedNow) console.log(`    ${titles.join(" / ")}`);
    const nowKey = new Map(hfe.map((row) => [row.ref, row.discKey]));
    const splits = [...groupBy([...strict.values()], (row) => row.discKey).values()].filter(
        (group) => new Set(group.map((row) => nowKey.get(row.ref))).size > 1,
    );
    print("first-draft groups the proposal's rule splits", splits.length);
    for (const group of splits)
        console.log(
            `    ${group.map((r) => `${r.meta?.title}${r.meta?.variant ? ` (v${r.meta.variant})` : ""}`).join(" / ")}`,
        );

    const headersOnly = await readJsonl("hfe-headers.jsonl");
    {
        console.log("\n== The proposal's pitch test against the first draft's header test");
        const combinedKey = new Map(hfe.map((row) => [row.ref, row.discKey]));
        const headersKey = new Map(headersOnly.map((row) => [row.ref, row.discKey]));
        const splitBy = (from, to) =>
            [...groupBy([...from.keys()], (ref) => from.get(ref)).values()].filter(
                (refs) => new Set(refs.map((ref) => to.get(ref))).size > 1,
            );
        const titleOf = new Map(
            hfe.map((row) => [row.ref, `${row.meta?.title}${row.meta?.variant ? ` (v${row.meta.variant})` : ""}`]),
        );
        const changed = hfe.filter((row) => headersKey.get(row.ref) !== row.discKey);
        print("captures whose key the combined test changes", changed.length);
        for (const row of changed) console.log(`    ${titleOf.get(row.ref)} ${row.ref}`);
        print("header-test groups the combined test splits", splitBy(headersKey, combinedKey).length);
        const merged = splitBy(combinedKey, headersKey);
        print("combined-test groups the header test splits", merged.length);
        for (const refs of merged) console.log(`    ${refs.map((ref) => `${titleOf.get(ref)} ${ref}`).join(" / ")}`);
    }

    console.log("\n== Side keys");
    const twoSided = rows.filter((row) => row.sideKeys.length > 1);
    print("two-sided images", twoSided.length);
    print("two-sided images whose second side trims to nothing", twoSided.filter((r) => r.sideLengths[1] === 0).length);
    const discsBySideKey = new Map();
    for (const row of rows)
        for (const key of row.sideLengths.length === 1 ? [row.sideKeys[0]] : row.sideKeys)
            discsBySideKey.set(key, new Set([...(discsBySideKey.get(key) ?? []), row.discKey]));
    const sharedSideKeys = new Set(
        twoSided.flatMap((row) => row.sideKeys).filter((key) => discsBySideKey.get(key).size > 1),
    );
    print("side keys of two-sided images also found on another disc", sharedSideKeys.size);
    // Archive images have no title but their file name, which is CamelCased or hyphenated.
    const discTitle = (row) =>
        row.meta?.title ??
        row.ref
            .split("#")[0]
            .replace(/^.*\//, "")
            .replace(/\.[a-z]+$/i, "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[-_]/g, " ");
    for (const key of sharedSideKeys) {
        const owners = rows.filter((row) => row.sideKeys.includes(key));
        const titles = [...new Set(owners.map(discTitle))];
        const related = titles.every((a) => titles.every((b) => a === b || shareAWord(a, b)));
        console.log(
            `    ${related ? "same title" : "UNRELATED"}: ${owners.map((row) => `${row.source}:${row.ref}`).join(" / ")}`,
        );
    }

    console.log("\n== MAME");
    const mameXml = await readFile(path.join(corpus, "bbcb_flop.xml"), "utf8");
    const mameSha1s = new Set([...mameXml.matchAll(/sha1="([0-9a-f]{40})"/g)].map((m) => m[1]));
    const matched = rows.filter((row) => mameSha1s.has(row.sha1));
    print("MAME disc images", mameSha1s.size);
    print("MAME images matched by a corpus file", new Set(matched.map((r) => r.sha1)).size);
    print("corpus images matching MAME, by source", Object.fromEntries(countBy(matched, (r) => r.source)));

    if (family) {
        console.log(`\n== Images matching "${family}"`);
        const pattern = new RegExp(family, "i");
        for (const row of rows) {
            const dfsTitle = row.catalogues?.[0]?.title ?? "";
            if (![row.meta?.title, row.ref, dfsTitle].some((text) => pattern.test(text ?? ""))) continue;
            console.log(`${row.source} ${row.ref} | ${row.meta?.title ?? ""} | ${row.discKey.slice(0, 8)}`);
            for (const file of catalogueFiles(row))
                console.log(
                    `    ${file.name.padEnd(10)} load ${file.load.toString(16)} exec ${file.exec.toString(16)} ${file.length} ${file.hash.slice(0, 8)}`,
                );
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
