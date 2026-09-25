#!/usr/bin/env node
// Prints the tape numbers from tape-index.jsonl, and how tape files line up with the disc index.
//
//   node tools/registry/tape-analyse.js [--corpus .registry-corpus] [--examples]

import { readFile } from "node:fs/promises";
import path from "node:path";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const examples = process.argv.includes("--examples");
const MinSharedFileLength = 512;

const readJsonl = async (name) =>
    (await readFile(path.join(corpus, name), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

const countBy = (items, keyOf) => {
    const counts = new Map();
    for (const item of items) {
        const key = keyOf(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts].sort());
};

const groupBy = (items, keyOf) => {
    const groups = new Map();
    for (const item of items) {
        const key = keyOf(item);
        if (key == null) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
};

const kind = (t) => `${t.source}-${t.format}`;
const nasTitle = (ref) =>
    ref
        .replace(/^(UEFs|CSWs)\//, "")
        .replace(/\.(uef|csw)$/i, "")
        .replace(/[-.]hq$/, "");

const IgnoredTitleWords = new Set(["the", "tape", "side", "run", "hq", "lab", "unlab", "bbc", "elec", "and"]);

/** The words of an image's title, for spotting keys shared by unrelated tapes. */
function titleWords(ref) {
    const base = ref
        .split(/[/#]/)
        .at(-1)
        .replace(/\.(uef|csw)$/i, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/([a-z])([A-Z0-9])/g, "$1 $2");
    return new Set(
        base
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length > 1 && !IgnoredTitleWords.has(w)),
    );
}

function relatedTitles(a, b) {
    const wordsA = titleWords(a);
    const wordsB = titleWords(b);
    return [...wordsA].some((w) => wordsB.has(w)) || [...wordsA].join("") === [...wordsB].join("");
}

function section(title) {
    console.log(`\n## ${title}`);
}

function decoding(tapes) {
    section("Decoding");
    console.log(
        "images:",
        countBy(tapes, (t) => (t.error ? `error: ${t.error}` : kind(t))),
    );
    const ok = tapes.filter((t) => !t.error);
    console.log(
        "with a tape key:",
        countBy(ok, (t) => `${kind(t)} ${t.tapeKey ? "key" : "no key"}`),
    );
    console.log(
        "every file complete:",
        countBy(ok, (t) => `${kind(t)} ${t.files.every((f) => f.complete) ? "all" : "some incomplete"}`),
    );
    console.log(
        "blocks with bad data CRC:",
        countBy(ok, (t) => `${kind(t)} ${t.badDataBlocks ? "some" : "none"}`),
    );
    console.log(
        "bytes outside MOS blocks (runs over 2 bytes):",
        countBy(ok, (t) => `${kind(t)} ${t.strayLong === 0 ? "none" : t.strayLong <= 1024 ? "1-1024" : "over 1024"}`),
    );
    const uefs = ok.filter((t) => t.format === "uef");
    console.log(
        "UEF framing other than 8N1:",
        countBy(uefs, (t) => (Object.keys(t.framings).some((f) => f !== "8N1") ? "yes" : "8N1 only")),
    );
    console.log(
        "UEF chunks used by at least one image:",
        countBy(
            uefs.flatMap((t) => Object.keys(t.notes.chunks)),
            (c) => c,
        ),
    );
    const files = ok.flatMap((t) => t.files);
    console.log("files:", files.length, "complete:", files.filter((f) => f.complete).length);
    console.log("locked files:", files.filter((f) => f.locked).length);
    const incomplete = files.filter((f) => !f.complete);
    console.log(
        "incomplete files:",
        countBy(incomplete, (f) =>
            f.badBlocks ? "bad block" : f.firstBlock !== 0 ? "doesn't start at block 0" : "no last block",
        ),
    );
    if (examples) {
        console.log("most bytes outside blocks:");
        for (const t of [...ok].sort((a, b) => b.strayLong - a.strayLong).slice(0, 15))
            console.log(`  ${t.strayLong} ${t.ref} files ${t.files.map((f) => f.name).join(",")}`);
    }
}

function keys(tapes) {
    section("Keys");
    const keyed = tapes.filter((t) => t.tapeKey);
    for (const source of ["sth", "nas", "all"]) {
        const set = keyed.filter((t) => source === "all" || t.source === source);
        console.log(`${source}: ${set.length} images with a key, ${new Set(set.map((t) => t.tapeKey)).size} distinct`);
    }
    const byKey = groupBy(keyed, (t) => t.tapeKey);
    const shared = [...byKey.values()].filter((g) => g.length > 1);
    console.log(
        "keys shared by more than one image, by the kinds of image:",
        countBy(shared, (g) => [...new Set(g.map(kind))].sort().join("+")),
    );
    const mixedBytes = shared.filter((g) => new Set(g.map((t) => t.sha256)).size > 1);
    console.log(`shared keys whose images are not byte-identical: ${mixedBytes.length}`);
    const sthGroups = shared.filter((g) => g.filter((t) => t.source === "sth").length > 1);
    console.log(`keys shared by two or more STH images: ${sthGroups.length}`);
    if (examples) for (const g of sthGroups.slice(0, 20)) console.log("  ", g.map((t) => t.ref).join(" = "));
    const unrelated = shared.filter((g) => g.some((a) => g.some((b) => !relatedTitles(a.ref, b.ref))));
    console.log(`shared keys whose images' titles have no word in common: ${unrelated.length}`);
    for (const g of unrelated) console.log("  ", g.map((t) => t.ref).join(" | "));
    console.log(
        "images whose key includes blocks outside complete files:",
        countBy(keyed, (t) => `${kind(t)} ${t.files.some((f) => f.goodBlocks) ? "yes" : "no"}`),
    );
    const reasonOf = (f) =>
        f.firstBlock !== 0 ? "a file not starting at block 0" : f.badBlocks ? "a bad block" : "no last block";
    const withBlockRecords = keyed.filter((t) => t.files.some((f) => f.goodBlocks));
    console.log(
        `FINDINGS: images whose key includes blocks that aren't part of a complete file: ${withBlockRecords.length}` +
            ` (${new Set(withBlockRecords.map((t) => t.tapeKey)).size} distinct keys)`,
    );
    const reasons = ["a file not starting at block 0", "a bad block", "no last block"];
    console.log(
        "FINDINGS: of those, by the first reason that applies (in this order):",
        countBy(withBlockRecords, (t) => {
            const found = new Set(t.files.filter((f) => f.goodBlocks).map(reasonOf));
            return reasons.find((r) => found.has(r));
        }),
    );
    console.log(
        "FINDINGS: of those, with at least one such file for each reason:",
        Object.fromEntries(
            reasons.map((r) => [
                r,
                withBlockRecords.filter((t) => t.files.some((f) => f.goodBlocks && reasonOf(f) === r)).length,
            ]),
        ),
    );
    const blind = keyed.filter((t) => t.strayLong > 1024);
    console.log(
        `images with over 1K of bytes outside MOS blocks, which the key can't see: ${blind.length}, ` +
            `${new Set(blind.map((t) => t.tapeKey)).size} distinct keys; of those images, the key covers ` +
            `under half the decoded bytes for ${blind.filter((t) => t.strayLong > t.bytes / 2).length}`,
    );

    section("What the alternative keys would have done");
    for (const alt of ["completeFiles", "blocksDeduped", "blocks", "stream", "filesAll", "fileSet", "dataOnly"]) {
        const groups = groupBy(
            keyed.filter((t) => t.alt[alt]),
            (t) => t.alt[alt],
        );
        let splits = 0;
        let merges = 0;
        for (const g of byKey.values()) if (new Set(g.map((t) => t.alt[alt])).size > 1) splits++;
        for (const g of groups.values()) if (new Set(g.map((t) => t.tapeKey)).size > 1) merges++;
        console.log(
            `${alt}: ${groups.size} distinct; splits ${splits} tape-key groups, merges ${merges} groups of different tape keys`,
        );
    }
    const streamSplits = [...byKey.values()].filter((g) => new Set(g.map((t) => t.alt.stream)).size > 1);
    console.log(
        "tape-key groups the raw byte stream splits, by kinds:",
        countBy(streamSplits, (g) => [...new Set(g.map(kind))].sort().join("+")),
    );
    const blockSplits = [...byKey.values()].filter((g) => new Set(g.map((t) => t.alt.blocks)).size > 1);
    if (examples) {
        console.log("tape-key groups the block key splits:");
        for (const g of blockSplits.slice(0, 10)) console.log("  ", g.map((t) => t.ref).join(" | "));
        const byData = groupBy(
            keyed.filter((t) => t.alt.dataOnly),
            (t) => t.alt.dataOnly,
        );
        console.log("groups with the same data but different names or addresses:");
        for (const g of [...byData.values()].filter((g) => new Set(g.map((t) => t.tapeKey)).size > 1).slice(0, 10))
            console.log("  ", g.map((t) => t.ref).join(" | "));
    }
}

function uefVsCsw(tapes) {
    section("UEF against CSW on the NAS");
    const nas = tapes.filter((t) => t.source === "nas");
    const byTitle = groupBy(nas, (t) => nasTitle(t.ref));
    const pairs = [...byTitle.values()]
        .map((g) => [g.find((t) => t.format === "uef"), g.find((t) => t.format === "csw")])
        .filter(([u, c]) => u && c);
    const agree = pairs.filter(([u, c]) => u.tapeKey && u.tapeKey === c.tapeKey);
    console.log(`pairs by title: ${pairs.length}; same tape key: ${agree.length}`);
    for (const alt of ["completeFiles", "blocksDeduped", "blocks", "stream", "filesAll", "fileSet"])
        console.log(`  same ${alt} key: ${pairs.filter(([u, c]) => u.alt[alt] && u.alt[alt] === c.alt[alt]).length}`);
    const cswKeys = new Set(nas.filter((t) => t.format === "csw" && t.tapeKey).map((t) => t.tapeKey));
    const uefKeys = new Set(nas.filter((t) => t.format === "uef" && t.tapeKey).map((t) => t.tapeKey));
    console.log(
        `NAS UEF keys also a NAS CSW key: ${[...uefKeys].filter((k) => cswKeys.has(k)).length} of ${uefKeys.size}`,
    );
    for (const [u, c] of pairs.filter(([u, c]) => !(u.tapeKey && u.tapeKey === c.tapeKey))) {
        const describe = (t) =>
            `${t.files.filter((f) => f.complete).length}/${t.files.length} complete, ${t.badDataBlocks} bad blocks`;
        console.log(`  differs: ${nasTitle(u.ref)}: UEF ${describe(u)}; CSW ${describe(c)}`);
    }
    const sthKeys = new Set(tapes.filter((t) => t.source === "sth" && t.tapeKey).map((t) => t.tapeKey));
    const nasKeys = new Set(nas.filter((t) => t.tapeKey).map((t) => t.tapeKey));
    console.log(`NAS keys also an STH key: ${[...nasKeys].filter((k) => sthKeys.has(k)).length} of ${nasKeys.size}`);
}

async function discOverlap(tapes) {
    section("Tape files on discs");
    const discs = await readJsonl("index.jsonl");
    const discFiles = discs.flatMap((d) =>
        (d.catalogues ?? []).flatMap((c) => (c?.files ?? []).filter((f) => f.complete).map((f) => ({ ...f, disc: d }))),
    );
    const bareName = (name) => name.replace(/^.\./, "").toUpperCase();
    const byHash = groupBy(discFiles, (f) => f.hash);
    const byNameHash = new Set(discFiles.map((f) => `${bareName(f.name)}|${f.hash}`));
    const keyed = tapes.filter((t) => t.tapeKey);
    const distinct = [...groupBy(keyed, (t) => t.tapeKey).values()].map((g) => g[0]);
    const tapeFiles = distinct.flatMap((t) =>
        t.files.filter((f) => f.complete && f.length >= MinSharedFileLength).map((f) => ({ ...f, tape: t })),
    );
    const distinctTapeFiles = [...groupBy(tapeFiles, (f) => f.hash).values()].map((g) => g[0]);
    const onDisc = distinctTapeFiles.filter((f) => byHash.has(f.hash));
    const sameName = distinctTapeFiles.filter((f) => byNameHash.has(`${f.name.slice(0, 7).toUpperCase()}|${f.hash}`));
    console.log(
        `distinct tape files of ${MinSharedFileLength} bytes or more: ${distinctTapeFiles.length}; ` +
            `same bytes on a disc: ${onDisc.length}; and the same name (first 7 characters): ${sameName.length}`,
    );
    const shares = distinct.map((t) => {
        const big = t.files.filter((f) => f.complete && f.length >= MinSharedFileLength);
        const found = big.filter((f) => byHash.has(f.hash));
        return { t, big: big.length, found: found.length, bytes: found.reduce((n, f) => n + f.length, 0) };
    });
    console.log(
        "distinct tapes by how many of their files (512 bytes or more) are on some disc:",
        countBy(shares, ({ big, found }) =>
            big === 0 ? "no such files" : found === 0 ? "none" : found === big ? "all" : "some",
        ),
    );
    const bySource = countBy(
        onDisc.flatMap((f) => [...new Set(byHash.get(f.hash).map((d) => d.disc.source))]),
        (s) => s,
    );
    console.log("the discs they are on, by source (a file can count for several):", bySource);
    const onOneDisc = shares.filter(({ t, big }) => {
        if (!big) return false;
        const counts = new Map();
        for (const f of t.files.filter((f) => f.complete && f.length >= MinSharedFileLength && byHash.has(f.hash)))
            for (const disc of new Set(byHash.get(f.hash).map((d) => d.disc)))
                counts.set(disc, (counts.get(disc) ?? 0) + 1);
        return Math.max(0, ...counts.values()) === big;
    });
    console.log(
        `distinct tapes whose files of ${MinSharedFileLength} bytes or more are all on one disc image: ${onOneDisc.length}`,
    );
    const lengths = onDisc.map((f) => f.length).sort((a, b) => a - b);
    console.log(
        `lengths of shared files: median ${lengths[lengths.length >> 1]}, over 8K: ${lengths.filter((n) => n > 8192).length}`,
    );
    const addressesDiffer = onDisc.filter((f) =>
        byHash
            .get(f.hash)
            .every((d) => (d.load & 0x3ffff) !== (f.load & 0x3ffff) || (d.exec & 0x3ffff) !== (f.exec & 0x3ffff)),
    );
    console.log(`shared files whose load or exec address differs on every disc: ${addressesDiffer.length}`);
    if (examples) {
        for (const { t, big, found } of shares.filter((s) => s.found).slice(0, 15)) {
            const discRefs = new Set(
                t.files
                    .filter((f) => byHash.has(f.hash))
                    .flatMap((f) =>
                        byHash
                            .get(f.hash)
                            .filter((d) => d.disc.source !== "bbcmicro")
                            .map((d) => d.disc.ref),
                    ),
            );
            console.log(`  ${t.ref}: ${found}/${big} -> ${[...discRefs].slice(0, 3).join(", ")}`);
        }
    }
}

async function main() {
    const tapes = await readJsonl("tape-index.jsonl");
    decoding(tapes);
    keys(tapes);
    uefVsCsw(tapes);
    await discOverlap(tapes);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
