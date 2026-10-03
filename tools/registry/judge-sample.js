#!/usr/bin/env node
// Draws a reproducible sample of image pairs for the judging pilot, from our own two
// mirrors only: pairs in one family (cluster.js) with different keys, `contains`
// relations, and pairs of HFE captures with the same title that share some files but
// weren't put in one family. Writes judge-sample.jsonl.
//
//   node tools/registry/judge-sample.js [--corpus .registry-corpus] [--per-kind 6] [--seed 1]

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const perKind = Number(arg("--per-kind", "6"));
let seed = Number(arg("--seed", "1"));

// A small deterministic generator (mulberry32), so the sample can be drawn again.
function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (items, count) => {
    const pool = [...items];
    const out = [];
    while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    return out;
};
const readJsonl = async (name) =>
    (await readFile(path.join(corpus, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

async function main() {
    const rows = (await readJsonl("index.jsonl")).filter((row) => !row.error && row.source !== "bbcmicro");
    const byKey = new Map(rows.map((row) => [row.discKey, row]));
    const titleOf = (row) => row.meta?.title ?? row.ref;
    const pair = (kind, a, b) => ({ kind, a: a.ref, b: b.ref, titles: [titleOf(a), titleOf(b)] });

    const familyPairs = [];
    for (const { discs } of await readJsonl("clusters.jsonl")) {
        const members = discs.map((disc) => byKey.get(disc.discKey)).filter(Boolean);
        for (let i = 0; i + 1 < members.length; ++i) familyPairs.push(pair("family", members[i], members[i + 1]));
    }
    const containsPairs = (await readJsonl("contains.jsonl"))
        .map(({ container, contained }) => [byKey.get(container), byKey.get(contained)])
        .filter(([a, b]) => a && b)
        .map(([a, b]) => pair("contains", a, b));

    const fileHashes = (row) =>
        new Set(
            (row.catalogues ?? []).flatMap((c) => (c?.files ?? []).filter((f) => f.length >= 512).map((f) => f.hash)),
        );
    const families = new Map();
    for (const [index, { discs }] of (await readJsonl("clusters.jsonl")).entries())
        for (const disc of discs) families.set(disc.discKey, index);
    const byTitle = new Map();
    for (const row of rows.filter((r) => r.source === "hfe"))
        byTitle.set(row.meta.title.toLowerCase(), [...(byTitle.get(row.meta.title.toLowerCase()) ?? []), row]);
    const apartPairs = [];
    for (const group of byTitle.values())
        for (let i = 0; i < group.length; ++i)
            for (let j = i + 1; j < group.length; ++j) {
                const [a, b] = [group[i], group[j]];
                if (a.discKey === b.discKey) continue;
                const together = families.has(a.discKey) && families.get(a.discKey) === families.get(b.discKey);
                const theirs = fileHashes(b);
                if (!together && [...fileHashes(a)].some((hash) => theirs.has(hash)))
                    apartPairs.push(pair("apart", a, b));
            }

    const sample = [...pick(familyPairs, perKind), ...pick(containsPairs, perKind), ...pick(apartPairs, perKind)];
    await writeFile(path.join(corpus, "judge-sample.jsonl"), sample.map((s) => JSON.stringify(s)).join("\n") + "\n");
    console.log(
        `candidates: ${familyPairs.length} family, ${containsPairs.length} contains, ${apartPairs.length} apart; sampled ${sample.length}`,
    );
    for (const s of sample) console.log(`${s.kind.padEnd(8)} ${s.titles.join(" / ")}  [${s.a} | ${s.b}]`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
