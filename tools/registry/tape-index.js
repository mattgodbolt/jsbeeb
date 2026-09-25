#!/usr/bin/env node
// Decodes every tape image in the corpus and writes one JSON line per image to tape-index.jsonl:
// where it came from, the tape key and the alternative keys it was compared with, what didn't decode,
// and the files with a hash each (the same hash as dfs.js uses for disc files).
//
//   node tools/registry/tape-index.js [--corpus .registry-corpus] [--nas /nas/BackedUp/BBC]

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "../../src/archive.js";
import { decodeTape, shortHash, tapeKey } from "./tape.js";

const arg = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = arg("--corpus", ".registry-corpus");
const nas = arg("--nas", "/nas/BackedUp/BBC");

const isTape = (name) => /\.(uef|csw)$/i.test(name);

async function* images() {
    const manifest = JSON.parse(await readFile(path.join(corpus, "sth-tape", "manifest.json"), "utf8")).files;
    for (const { path: p } of manifest) {
        const members = await unzip(await readFile(path.join(corpus, "sth-tape", p)));
        for (const [member, bytes] of Object.entries(members))
            if (isTape(member)) yield { source: "sth", ref: `${p}#${member}`, bytes };
    }
    for (const dir of ["UEFs", "CSWs"]) {
        for (const name of (await readdir(path.join(nas, dir))).sort())
            if (isTape(name))
                yield {
                    source: "nas",
                    ref: `${dir}/${name}`,
                    bytes: new Uint8Array(await readFile(path.join(nas, dir, name))),
                };
    }
}

const hashParts = (parts) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest("hex").slice(0, 32);
};

const u32le = (v) => Buffer.from(new Uint32Array([v >>> 0]).buffer);
const u16le = (v) => Buffer.from(new Uint16Array([v]).buffer);

// The alternatives the tape key was chosen over.
function alternativeKeys(decoded) {
    const { runs, blocks, files } = decoded;
    const goodBlocks = blocks.filter((b) => b.complete && b.dataCrcGood);
    const record = (f) =>
        Buffer.concat([
            Buffer.from(f.name, "latin1"),
            Buffer.from([0]),
            u32le(f.load),
            u32le(f.exec),
            u32le(f.data.length),
            f.data,
        ]);
    const complete = files.filter((f) => f.complete);
    const blockRecord = (b) =>
        Buffer.concat([
            Buffer.from(b.name, "latin1"),
            Buffer.from([0]),
            u32le(b.load),
            u32le(b.exec),
            u16le(b.number),
            Buffer.from([b.flags]),
            b.data,
        ]);
    const dedupedBlocks = goodBlocks
        .map(blockRecord)
        .filter((r, i, all) => i === 0 || Buffer.compare(r, all[i - 1]) !== 0);
    return {
        // Complete files only.
        completeFiles: tapeKey(files, { completeFilesOnly: true }),
        // Every decoded byte, stray ones included.
        stream: hashParts(runs.map((r) => Uint8Array.from(r.bytes))),
        // Every good block, header fields and data, in order.
        blocks: goodBlocks.length
            ? hashParts(
                  goodBlocks.map((b) =>
                      Buffer.concat([
                          Buffer.from(b.name, "latin1"),
                          Buffer.from([0]),
                          u32le(b.load),
                          u32le(b.exec),
                          u16le(b.number),
                          Buffer.from([b.flags]),
                          b.data,
                      ]),
                  ),
              )
            : null,
        // Complete files in order, repeats kept.
        filesAll: complete.length ? hashParts(complete.map(record)) : null,
        // The distinct complete files, sorted.
        fileSet: complete.length
            ? hashParts(
                  [...new Set(complete.map((f) => record(f).toString("hex")))].sort().map((h) => Buffer.from(h, "hex")),
              )
            : null,
        // Complete files in order, data only (names and addresses ignored).
        dataOnly: complete.length ? hashParts(complete.map((f) => f.data)) : null,
        // Every good block, with a block that repeats the one before it dropped.
        blocksDeduped: dedupedBlocks.length ? hashParts(dedupedBlocks) : null,
    };
}

function describe(bytes) {
    const decoded = decodeTape(bytes);
    const { format, gzip, notes, runs, blocks, stray, files } = decoded;
    const byteCount = runs.reduce((n, r) => n + r.bytes.length, 0);
    const strayByFraming = {};
    for (const s of stray) strayByFraming[s.framing] = (strayByFraming[s.framing] ?? 0) + s.bytes.length;
    const framings = {};
    for (const r of runs) framings[r.framing] = (framings[r.framing] ?? 0) + r.bytes.length;
    return {
        format,
        gzip,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 32),
        tapeKey: tapeKey(files),
        alt: alternativeKeys(decoded),
        notes,
        bytes: byteCount,
        framings,
        blocks: blocks.length,
        badDataBlocks: blocks.filter((b) => !b.dataCrcGood).length,
        truncatedBlocks: blocks.filter((b) => !b.complete).length,
        // Runs of 1 or 2 bytes are MakeUEF's dummy bytes and the like.
        strayBytes: stray.reduce((n, s) => n + s.bytes.length, 0),
        strayLong: stray.filter((s) => s.bytes.length > 2).reduce((n, s) => n + s.bytes.length, 0),
        strayByFraming,
        strayRuns: decoded.stray
            .filter((r) => r.bytes.length > 2)
            .map((r) => ({ length: r.bytes.length, hash: shortHash(r.bytes) })),
        files: files.map(({ data, goodBlocks, ...f }) => ({
            ...f,
            goodBlocks: goodBlocks.length,
            hash: shortHash(data),
        })),
    };
}

async function main() {
    const lines = [];
    for await (const image of images()) {
        try {
            lines.push({ source: image.source, ref: image.ref, ...describe(image.bytes) });
        } catch (error) {
            lines.push({ source: image.source, ref: image.ref, error: String(error?.message ?? error) });
        }
    }
    const out = path.join(corpus, "tape-index.jsonl");
    await writeFile(out, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    console.log(`${out}: ${lines.length} images`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
