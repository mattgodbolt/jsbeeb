#!/usr/bin/env node
// Groups the corpus's disc images into families by the files they share, and checks
// the families against the HFE mirror's own titles. Two discs are one family when the
// files they share make up at least half of each by size; when they make up half of only
// the smaller, the bigger one contains the smaller (a compilation, a menu disc, a game
// with extras). A disc whose catalogue lists less than --min-catalogued bytes takes no
// part: many protected discs catalogue only a shared boot loader, and the software lives
// off the catalogue where no file hash can see it.
//
//   node tools/registry/cluster.js [--corpus .registry-corpus] [--containment 0.5] [--min-file 512]
//       [--min-catalogued 8192]
//
// Writes clusters.jsonl (one line per family with more than one image) and prints the
// evaluation.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const containment = Number(arg("--containment", "0.5"));
const minFile = Number(arg("--min-file", "512"));
const minCatalogued = Number(arg("--min-catalogued", "8192"));

// Words that say which part of a release an image is, rather than what it is.
const PartWords = new Set([
    "disc",
    "disk",
    "side",
    "part",
    "the",
    "and",
    "of",
    "a",
    "vol",
    "volume",
    "pictures",
    "picture",
]);
export const titleWords = (title) =>
    new Set(
        (title ?? "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length > 1 && !PartWords.has(word) && !/^v?\d+[a-z]?$/.test(word)),
    );

class UnionFind {
    constructor(n) {
        this.parent = Array.from({ length: n }, (_, i) => i);
    }
    find(i) {
        while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
        return i;
    }
    union(a, b) {
        this.parent[this.find(a)] = this.find(b);
    }
}

async function main() {
    const rows = (await readFile(path.join(corpus, "index.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => !row.error);

    // One node per distinct disc key; its files are those of any image with that key.
    const byKey = new Map();
    for (const row of rows) byKey.set(row.discKey, [...(byKey.get(row.discKey) ?? []), row]);
    const nodes = [...byKey.values()];
    const filesOf = nodes.map((images) => {
        const files = new Map();
        for (const catalogue of images[0].catalogues ?? [])
            for (const file of catalogue?.files ?? [])
                if (file.complete && !file.uniform && file.length >= minFile) files.set(file.hash, file.length);
        const catalogued = [...files.values()].reduce((sum, length) => sum + length, 0);
        return catalogued >= minCatalogued ? files : new Map();
    });

    const discsWithFile = new Map();
    filesOf.forEach((files, node) => {
        for (const hash of files.keys()) discsWithFile.set(hash, [...(discsWithFile.get(hash) ?? []), node]);
    });
    const size = (files) => [...files.values()].reduce((sum, length) => sum + length, 0);

    const union = new UnionFind(nodes.length);
    let links = 0;
    // A disc most of whose files are on a much bigger one: a compilation, a menu disc, or
    // a game with extras added. That's a `contains` relation, not the same software.
    const contains = [];
    filesOf.forEach((files, a) => {
        const shared = new Map();
        for (const [hash, length] of files)
            for (const b of discsWithFile.get(hash)) if (b > a) shared.set(b, (shared.get(b) ?? 0) + length);
        for (const [b, bytes] of shared) {
            const [sizeA, sizeB] = [size(files), size(filesOf[b])];
            if (Math.min(sizeA, sizeB) === 0) continue;
            if (bytes / Math.max(sizeA, sizeB) >= containment) {
                union.union(a, b);
                links++;
            } else if (bytes / Math.min(sizeA, sizeB) >= containment) {
                contains.push(sizeA > sizeB ? [a, b] : [b, a]);
            }
        }
    });

    const families = new Map();
    nodes.forEach((_, node) => {
        const root = union.find(node);
        families.set(root, [...(families.get(root) ?? []), node]);
    });
    const withFiles = nodes.filter((_, node) => filesOf[node].size > 0).length;
    const multi = [...families.values()].filter((members) => members.length > 1);
    const sourcesOf = (members) => new Set(members.flatMap((node) => nodes[node].map((row) => row.source)));

    console.log(
        `disc keys: ${nodes.length}, cataloguing at least ${minCatalogued} bytes in files of ${minFile}+: ${withFiles}`,
    );
    console.log(`links: ${links}, families: ${families.size}, of which with more than one disc: ${multi.length}`);
    console.log(`contains relations (one disc's files mostly on a much bigger one): ${contains.length}`);
    console.log(
        `families spanning more than one source: ${multi.filter((m) => sourcesOf(m).size > 1).length} ` +
            `(discs in them: ${multi.filter((m) => sourcesOf(m).size > 1).reduce((sum, m) => sum + m.length, 0)})`,
    );
    const largest = multi.sort((a, b) => b.length - a.length).slice(0, 5);
    console.log(`largest families: ${largest.map((m) => m.length).join(", ")}`);

    // Evaluation against the HFE mirror's labels, over pairs of distinct disc keys among its
    // captures that hold files. "Same label" is the same title and the same disc and side
    // (the manifest's `disc`, such as D1S1); reconstructions carry no `disc`, so they're
    // compared by title alone.
    const label = (row) => `${row.meta.title.toLowerCase().trim()}|${row.meta.disc ?? ""}`;
    const labelled = nodes
        .map((images, node) => ({ node, row: images.find((row) => row.source === "hfe") }))
        .filter(({ node, row }) => row?.meta?.title && filesOf[node].size > 0);
    const counts = { sameLabelTogether: 0, sameLabelApart: 0, togetherRelated: 0, togetherUnrelated: 0 };
    const apartExamples = [];
    const apartBySharing = { "no shared file": 0, "joined by contains": 0, "some shared files": 0 };
    const containsPairs = new Set(contains.map(([big, small]) => `${big}:${small}`));
    const unrelatedExamples = [];
    for (let i = 0; i < labelled.length; ++i)
        for (let j = i + 1; j < labelled.length; ++j) {
            const [a, b] = [labelled[i], labelled[j]];
            const together = union.find(a.node) === union.find(b.node);
            const sameLabel =
                a.row.meta.disc && b.row.meta.disc
                    ? label(a.row) === label(b.row)
                    : a.row.meta.title.toLowerCase().trim() === b.row.meta.title.toLowerCase().trim();
            if (sameLabel) {
                if (together) counts.sameLabelTogether++;
                else {
                    counts.sameLabelApart++;
                    const theirs = filesOf[b.node];
                    const sharedFiles = [...filesOf[a.node].keys()].filter((hash) => theirs.has(hash)).length;
                    const linked = containsPairs.has(`${a.node}:${b.node}`) || containsPairs.has(`${b.node}:${a.node}`);
                    apartBySharing[
                        sharedFiles === 0 ? "no shared file" : linked ? "joined by contains" : "some shared files"
                    ]++;
                    apartExamples.push(
                        `${a.row.meta.title} [${a.row.ref}] / [${b.row.ref}] shared files ${sharedFiles}`,
                    );
                }
            }
            if (together) {
                const related = [...titleWords(a.row.meta.title)].some((word) =>
                    titleWords(b.row.meta.title).has(word),
                );
                if (related) counts.togetherRelated++;
                else {
                    counts.togetherUnrelated++;
                    unrelatedExamples.push(`${a.row.meta.title} / ${b.row.meta.title}`);
                }
            }
        }
    console.log(`\nlabelled HFE discs with files: ${labelled.length}`);
    console.log(`pairs with the same label: together ${counts.sameLabelTogether}, apart ${counts.sameLabelApart}`);
    console.log(`  apart pairs by what they share: ${JSON.stringify(apartBySharing)}`);
    for (const example of apartExamples.slice(0, 20)) console.log(`    apart: ${example}`);
    console.log(
        `pairs in one family: titles share a word ${counts.togetherRelated}, share none ${counts.togetherUnrelated}`,
    );
    for (const example of unrelatedExamples.slice(0, 20)) console.log(`    unrelated: ${example}`);

    await writeFile(
        path.join(corpus, "contains.jsonl"),
        contains
            .map(([big, small]) =>
                JSON.stringify({ container: nodes[big][0].discKey, contained: nodes[small][0].discKey }),
            )
            .join("\n") + "\n",
    );
    const out = multi.map((members) => ({
        discs: members.map((node) => ({
            discKey: nodes[node][0].discKey,
            images: nodes[node].map((row) => ({ source: row.source, ref: row.ref, title: row.meta?.title })),
        })),
    }));
    await writeFile(path.join(corpus, "clusters.jsonl"), out.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

if (process.argv[1]?.endsWith("cluster.js")) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
