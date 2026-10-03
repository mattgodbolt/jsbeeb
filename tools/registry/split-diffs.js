#!/usr/bin/env node
// For every group of HFE captures that the first draft's rules gave one key and the
// proposal's rules split, diffs each pair of members that now differ, and prints what
// the mirror's manifest says about them (disc side, tracks, variant, provenance) next to
// how many sectors and bytes differ. This is what the findings' "cost" paragraph rests on.
//
//   node tools/registry/split-diffs.js [--corpus .registry-corpus]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { diffImages } from "./diff-images.js";

const index = process.argv.indexOf("--corpus");
const corpus = index > 0 ? process.argv[index + 1] : ".registry-corpus";

const readJsonl = async (name) =>
    (await readFile(path.join(corpus, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

const describe = ({ ref, meta }) =>
    `${meta?.title} [${ref} ${meta?.provenance ?? ""} ${meta?.disc ?? ""} ${meta?.tracks?.join(",") ?? ""} v${meta?.variant ?? "-"}]`;

async function main() {
    const now = new Map(
        (await readJsonl("index.jsonl")).filter((row) => row.source === "hfe").map((row) => [row.ref, row]),
    );
    const groups = new Map();
    for (const row of await readJsonl("hfe-first-draft.jsonl"))
        groups.set(row.discKey, [...(groups.get(row.discKey) ?? []), row.ref]);
    const log = console.log;
    for (const refs of groups.values()) {
        if (new Set(refs.map((ref) => now.get(ref).discKey)).size < 2) continue;
        log(`== ${refs.map((ref) => now.get(ref).meta?.title).join(" / ")}`);
        for (let i = 0; i < refs.length; ++i)
            for (let j = i + 1; j < refs.length; ++j) {
                const [a, b] = [now.get(refs[i]), now.get(refs[j])];
                if (a.discKey === b.discKey) continue;
                console.log = () => {};
                const report = await diffImages(corpus, a.ref, b.ref);
                console.log = log;
                const sectors = report.flatMap((side) => Object.values(side.differences).flat());
                const bytes = sectors.reduce((sum, entry) => sum + Number(entry.match(/\((\d+) bytes\)/)[1]), 0);
                const lengths = report.map((side) => side.lengths.join(" vs ")).join("; ");
                log(`  ${describe(a)}`);
                log(`  ${describe(b)}`);
                log(`    ${sectors.length} sectors, ${bytes} bytes differ; lengths ${lengths}`);
            }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
