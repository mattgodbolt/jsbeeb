#!/usr/bin/env node
// Experiments with FSD sector dumps against the HFE mirror's reconstructions of them.
//
//   node tools/registry/fsd-study.js pairs    the findings' three capture/reconstruction pairs,
//                                             sector by sector, with the FSD's view of each
//   node tools/registry/fsd-study.js match    fingerprints every FSD under --fsd-dir, and each
//                                             mirror reconstruction with the same FSD number
//   node tools/registry/fsd-study.js titles   for titles with both a capture and a
//                                             reconstruction, whether their keys agree
//
// Options: --corpus .registry-corpus, --fsd-dir /nas/BackedUp/BBC/FSDs. Results go to
// <corpus>/fsd-<command>.jsonl.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint, fluxSideBytes, loadFlux, trimFill } from "./fingerprint.js";
import { describeFsdError, fsdSideBytes, parseFsd } from "./fsd.js";

const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const corpus = option("--corpus", ".registry-corpus");
const fsdDir = option("--fsd-dir", "/nas/BackedUp/BBC/FSDs");
const MaxPhysicalTracks = 84;
const KeyBytes = 16;

const sha256 = (...parts) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
};
const toKey = (digest) => digest.subarray(0, KeyBytes).toString("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** The same walk as fingerprint.js's fluxSideBytes, keeping where each sector came from. */
function fluxSectors(disc, upper) {
    const { is40Track } = fluxSideBytes(disc, upper);
    const step = is40Track ? 2 : 1;
    const kept = new Map();
    const bad = [];
    for (let physical = 0; physical < MaxPhysicalTracks; physical += step) {
        const logical = physical / step;
        for (const sector of disc.getTrack(upper, physical).findSectors(() => {})) {
            const where = { physical, logical, track: sector.trackNumber, sector: sector.sectorNumber };
            if (sector.hasHeaderCrcError || sector.hasDataCrcError || !sector.sectorData) {
                bad.push(where);
                continue;
            }
            const id = (logical << 16) | (sector.trackNumber << 8) | sector.sectorNumber;
            if (!kept.has(id)) kept.set(id, { ...where, data: Buffer.from(sector.sectorData) });
        }
    }
    return { is40Track, bad, sectors: [...kept.entries()].sort(([a], [b]) => a - b).map(([, s]) => s) };
}

/** The fingerprint's disc key from one side's untrimmed bytes. */
const discKeyOf = (side) => toKey(sha256(sha256(trimFill(side).data)));

async function readManifest() {
    return JSON.parse(await readFile(path.join(corpus, "hfe", "manifest.json"), "utf8")).files;
}

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}

async function fsdFiles() {
    const files = [];
    for await (const file of walk(fsdDir)) if (path.extname(file).toLowerCase() === ".fsd") files.push(file);
    return files.sort();
}

const fsdNumberOf = (file) => {
    const match = path.basename(file).match(/^(-?)(\d+)/);
    return match ? Number(match[2]) : null;
};

async function hfeSides(file) {
    const bytes = await readFile(path.join(corpus, "hfe", file));
    const disc = loadFlux(file, bytes);
    return { disc, bytes };
}

function fsdFingerprint(fsd, options) {
    const side = fsdSideBytes(fsd, options);
    return { ...side, discKey: discKeyOf(side.data) };
}

const Pairs = [
    {
        title: "Hopper",
        capture: "0978E13E.hfe",
        reconstruction: "543ffebe6a2cf0b5.hfe",
        fsd: "Acornsoft/008 Hopper 40-80.FSD",
    },
    {
        title: "The Empire Strikes Back",
        capture: "08566B89.hfe",
        reconstruction: "164eb9623f221f87.hfe",
        fsd: "DOMARK/355 THE EMPIRE STRIKES BACK.FSD",
    },
    {
        title: "Philosophers Quest",
        capture: "DD1E387D.hfe",
        reconstruction: "56058d40c33fce9c.hfe",
        fsd: "Topologika/318 Philosopher's Quest.FSD",
    },
];

const sectorLabel = (s) =>
    `logical ${s.logical} ID track ${s.track} sector ${s.sector}${s.physical !== undefined ? ` (physical ${s.physical})` : ""}`;

async function pairs() {
    const rows = [];
    for (const pair of Pairs) {
        const capture = fluxSectors((await hfeSides(pair.capture)).disc, false);
        const reconstruction = fluxSectors((await hfeSides(pair.reconstruction)).disc, false);
        const fsd = parseFsd(await readFile(path.join(fsdDir, pair.fsd)));
        const fsdSectors = new Map();
        for (const { track: logical, sectors } of fsd.tracks)
            for (const s of sectors) {
                const id = `${logical}/${s.track}/${s.sector}`;
                fsdSectors.set(id, [...(fsdSectors.get(id) ?? []), s]);
            }
        const byId = (list) => new Map(list.sectors.map((s) => [`${s.logical}/${s.track}/${s.sector}`, s]));
        const [a, b] = [byId(capture), byId(reconstruction)];
        const fromFsd = fsdSideBytes(fsd);
        const fsdKey = discKeyOf(fromFsd.data);
        const keys = {
            capture: fingerprint(pair.capture, await readFile(path.join(corpus, "hfe", pair.capture))).discKey,
            reconstruction: fingerprint(
                pair.reconstruction,
                await readFile(path.join(corpus, "hfe", pair.reconstruction)),
            ).discKey,
            fsd: fsdKey,
        };
        console.log(`== ${pair.title}: ${JSON.stringify(keys)}`);
        console.log(
            `   40-track: capture ${capture.is40Track}, reconstruction ${reconstruction.is40Track}; ` +
                `FSD "${fsd.title}" dated ${fsd.date}, ${fsd.tracks.length} tracks`,
        );
        const ids = new Set([...a.keys(), ...b.keys()]);
        for (const id of ids) {
            const [sa, sb] = [a.get(id), b.get(id)];
            if (sa && sb && sa.data.equals(sb.data)) continue;
            const inFsd = fsdSectors.get(id) ?? [];
            const diffs = [];
            if (sa && sb)
                for (let i = 0; i < Math.min(sa.data.length, sb.data.length); ++i)
                    if (sa.data[i] !== sb.data[i])
                        diffs.push({
                            offset: i,
                            capture: sa.data[i],
                            reconstruction: sb.data[i],
                            fsd: inFsd.map((s) => s.data?.[i]),
                        });
            const row = {
                title: pair.title,
                sector: id,
                where: sectorLabel(sa ?? sb),
                captureLength: sa?.data.length ?? null,
                reconstructionLength: sb?.data.length ?? null,
                fsd: inFsd.map((s) => ({
                    status: describeFsdError(s.error),
                    sizeCode: s.sizeCode,
                    realSizeCode: s.realSizeCode,
                    matchesCapture:
                        sa && s.data ? Buffer.from(s.data.subarray(0, sa.data.length)).equals(sa.data) : null,
                    matchesReconstruction:
                        sb && s.data ? Buffer.from(s.data.subarray(0, sb.data.length)).equals(sb.data) : null,
                })),
                bytesDiffering: diffs.length,
                diffs: diffs.slice(0, 16),
            };
            if (diffs.length > 0 && diffs.length <= 4 && sa)
                row.context = diffs.map(({ offset }) => ({
                    offset,
                    capture: hex(sa.data.subarray(Math.max(0, offset - 8), offset + 8)),
                    reconstruction: hex(sb.data.subarray(Math.max(0, offset - 8), offset + 8)),
                }));
            rows.push(row);
            console.log(JSON.stringify(row));
        }
        // Whether the capture's other reads of that sector (odd tracks, duplicates) agree.
        rows.push({
            title: pair.title,
            keys,
            captureBad: capture.bad.length,
            reconstructionBad: reconstruction.bad.length,
        });
    }
    await writeFile(path.join(corpus, "fsd-pairs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Every copy of one sector that a flux image holds, across all physical tracks, good CRC or not. */
async function allReads(file, logicalTrack, idTrack, idSector) {
    const { disc } = await hfeSides(file);
    const reads = [];
    for (let physical = 0; physical < MaxPhysicalTracks; ++physical)
        for (const sector of disc.getTrack(false, physical).findSectors(() => {}))
            if (sector.trackNumber === idTrack && sector.sectorNumber === idSector)
                reads.push({
                    physical,
                    crcError: sector.hasDataCrcError,
                    length: sector.sectorData?.length ?? null,
                    sha: sector.sectorData ? toKey(sha256(sector.sectorData)).slice(0, 12) : null,
                });
    return { file, logicalTrack, idTrack, idSector, reads };
}

async function reads() {
    const [file, logical, track, sector] = process.argv.slice(3);
    console.log(JSON.stringify(await allReads(file, +logical, +track, +sector), null, 1));
}

async function match() {
    const manifest = await readManifest();
    const reconstructions = manifest.filter((e) => e.provenance === "reconstructed" && e.fsd);
    const byNumber = new Map();
    for (const e of reconstructions) {
        const n = Number(e.fsd.slice(3));
        byNumber.set(n, [...(byNumber.get(n) ?? []), e]);
    }
    const rows = [];
    for (const file of await fsdFiles()) {
        const rel = path.relative(fsdDir, file);
        const row = { fsd: rel, number: fsdNumberOf(file) };
        let fsd;
        try {
            fsd = parseFsd(await readFile(file));
        } catch (error) {
            row.error = error.message;
            rows.push(row);
            console.log(JSON.stringify(row));
            continue;
        }
        const real = fsdFingerprint(fsd);
        const declared = fsdFingerprint(fsd, { dataSize: "declared" });
        Object.assign(row, {
            title: fsd.title,
            tracks: fsd.tracks.length,
            discKey: real.discKey,
            declaredKey: declared.discKey,
            dropped: real.dropped,
            errors: countErrors(fsd),
        });
        const candidates = byNumber.get(row.number) ?? [];
        row.candidates = [];
        for (const entry of candidates) {
            const bytes = await readFile(path.join(corpus, "hfe", entry.path));
            const print = fingerprint(entry.path, bytes);
            const candidate = {
                path: entry.path,
                title: entry.title,
                publisher: entry.publisher,
                discKey: print.discKey,
                sides: print.sideKeys.length,
                matches: print.discKey === real.discKey,
                matchesDeclared: print.discKey === declared.discKey,
            };
            if (!candidate.matches) candidate.diff = compareSides(print.sides[0], real, entry.path, bytes);
            row.candidates.push(candidate);
        }
        rows.push(row);
        console.log(JSON.stringify(row));
    }
    await writeFile(path.join(corpus, "fsd-match.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function countErrors(fsd) {
    const counts = {};
    for (const { sectors } of fsd.tracks)
        for (const s of sectors) {
            const status = describeFsdError(s.error);
            if (status !== "ok") counts[status] = (counts[status] ?? 0) + 1;
        }
    return counts;
}

/** Where an HFE's side 0 and an FSD's sectors part company. */
function compareSides(hfeSide, fsdSide, name, bytes) {
    const flux = fluxSectors(loadFlux(name, bytes), false);
    const fromHfe = new Map(flux.sectors.map((s) => [`${s.logical}/${s.track}/${s.sector}`, s.data]));
    const fromFsd = new Map(fsdSide.sectors.map((s) => [`${s.logical}/${s.sector.track}/${s.sector.sector}`, s]));
    const onlyHfe = [...fromHfe.keys()].filter((id) => !fromFsd.has(id));
    const onlyFsd = [...fromFsd.keys()].filter((id) => !fromHfe.has(id));
    const differ = [];
    for (const [id, data] of fromHfe) {
        const f = fromFsd.get(id);
        if (!f || (f.data.length === data.length && Buffer.from(f.data).equals(data))) continue;
        const prefix = Buffer.from(f.data.subarray(0, data.length)).equals(data.subarray(0, f.data.length));
        differ.push({
            id,
            hfeLength: data.length,
            fsdLength: f.data.length,
            sizeCode: f.sector.sizeCode,
            status: describeFsdError(f.sector.error),
            samePrefix: prefix,
        });
    }
    const onlyFsdStatus = onlyFsd.map((id) => {
        const f = fromFsd.get(id);
        return { id, length: f.data.length, status: describeFsdError(f.sector.error) };
    });
    return {
        is40Track: flux.is40Track,
        onlyHfe: onlyHfe.slice(0, 10),
        onlyHfeCount: onlyHfe.length,
        onlyFsd: onlyFsdStatus.slice(0, 10),
        onlyFsdCount: onlyFsd.length,
        differ: differ.slice(0, 10),
        differCount: differ.length,
        hfeBadReads: flux.bad.length,
    };
}

const normaliseTitle = (title) =>
    (title ?? "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(the|disc|disk|side|v\d+|version \d+)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

async function titles() {
    const manifest = await readManifest();
    const index = new Map();
    for (const line of (await readFile(path.join(corpus, "index.jsonl"), "utf8")).split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.source === "hfe") index.set(row.ref, row);
    }
    const fsdFor = new Map();
    try {
        for (const line of (await readFile(path.join(corpus, "fsd-explain.jsonl"), "utf8")).split("\n")) {
            if (!line) continue;
            const row = JSON.parse(line);
            if (row.verdict !== "differs") fsdFor.set(row.path, row.fsd);
        }
    } catch {
        // Without the explain results there is no FSD to compare.
    }
    const fsdKeys = new Map();
    for (const line of (await readFile(path.join(corpus, "fsd-match.jsonl"), "utf8")).split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line);
        fsdKeys.set(row.fsd, row);
    }
    const keyOf = (e) => index.get(e.path)?.discKey;
    const byTitle = new Map();
    for (const entry of manifest) {
        const key = normaliseTitle(entry.title);
        byTitle.set(key, [...(byTitle.get(key) ?? []), entry]);
    }
    const rows = [];
    for (const [title, entries] of byTitle) {
        const captures = entries.filter((e) => e.provenance === "captured");
        const recons = entries.filter((e) => e.provenance === "reconstructed");
        if (!captures.length || !recons.length) continue;
        const captureKeys = new Map(captures.map((e) => [keyOf(e), e.path]));
        for (const r of recons) {
            const row = {
                title,
                reconstruction: r.path,
                fsd: r.fsd,
                captures: captures.map((e) => e.path),
                matchesCapture: captureKeys.get(keyOf(r)) ?? null,
            };
            const nasFsd = fsdFor.get(r.path);
            if (nasFsd) {
                const f = fsdKeys.get(nasFsd);
                row.nasFsd = nasFsd;
                row.fsdMatchesCapture = captureKeys.get(f.discKey) ?? null;
                row.fsdDeclaredMatchesCapture = captureKeys.get(f.declaredKey) ?? null;
            }
            if (!row.matchesCapture) {
                let best = null;
                for (const c of captures) {
                    const d = await sectorDistance(c.path, r.path);
                    if (!best || d.differing < best.differing) best = { capture: c.path, ...d };
                }
                row.closest = best;
            }
            rows.push(row);
            console.log(JSON.stringify(row));
        }
    }
    await writeFile(path.join(corpus, "fsd-titles.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const fluxCache = new Map();
async function cachedFluxSectors(file) {
    if (!fluxCache.has(file)) fluxCache.set(file, fluxSectors((await hfeSides(file)).disc, false));
    return fluxCache.get(file);
}

/** How two flux images' side 0 sector sets differ, by ID. */
async function sectorDistance(fileA, fileB) {
    const [a, b] = await Promise.all([cachedFluxSectors(fileA), cachedFluxSectors(fileB)]);
    const ma = new Map(a.sectors.map((s) => [`${s.logical}/${s.track}/${s.sector}`, s]));
    const mb = new Map(b.sectors.map((s) => [`${s.logical}/${s.track}/${s.sector}`, s]));
    let onlyA = 0;
    let onlyB = 0;
    let differing = 0;
    let bytes = 0;
    let lengthOnly = 0;
    const examples = [];
    for (const [id, sa] of ma) {
        const sb = mb.get(id);
        if (!sb) {
            onlyA++;
            continue;
        }
        if (sa.data.equals(sb.data)) continue;
        differing++;
        if (sa.data.length !== sb.data.length) lengthOnly++;
        let n = 0;
        for (let i = 0; i < Math.min(sa.data.length, sb.data.length); ++i) if (sa.data[i] !== sb.data[i]) n++;
        bytes += n;
        if (examples.length < 4) examples.push({ id, bytes: n, lengths: [sa.data.length, sb.data.length] });
    }
    let onlyBFill = 0;
    for (const [id, sb] of mb)
        if (!ma.has(id)) {
            onlyB++;
            if (sb.data.every((b) => b === sb.data[0])) onlyBFill++;
        }
    return {
        differing: differing + onlyA + onlyB,
        changed: differing,
        lengthChanged: lengthOnly,
        bytes,
        onlyCapture: onlyA,
        onlyReconstruction: onlyB,
        onlyReconstructionFill: onlyBFill,
        is40Track: [a.is40Track, b.is40Track],
        badReads: [a.bad.length, b.bad.length],
        examples,
    };
}

/** Every sector ID on one physical track of a flux image, or one track of an FSD, in order. */
async function track() {
    const [file, number] = process.argv.slice(3);
    const describe = (bytes) => {
        const data = Buffer.from(bytes);
        const fill = data.every((b) => b === data[0]) ? ` all &${data[0].toString(16)}` : "";
        return `${data.length} bytes ${toKey(sha256(data)).slice(0, 12)}${fill}`;
    };
    if (path.extname(file).toLowerCase() === ".fsd") {
        const fsd = parseFsd(await readFile(path.isAbsolute(file) ? file : path.join(fsdDir, file)));
        for (const s of fsd.tracks[+number].sectors)
            console.log(
                `ID ${s.track}/${s.head}/${s.sector} size ${s.sizeCode} real ${s.realSizeCode} ` +
                    `${describeFsdError(s.error)} ${s.data ? describe(s.data) : ""}`,
            );
        return;
    }
    const { disc } = await hfeSides(file);
    for (const s of disc.getTrack(false, +number).findSectors(() => {}))
        console.log(
            `ID ${s.trackNumber}/${s.header[1]}/${s.sectorNumber} size ${s.header[3]} ` +
                `${s.hasHeaderCrcError ? "header CRC error " : ""}${s.hasDataCrcError ? "data CRC error " : ""}` +
                `${s.isDeleted ? "deleted " : ""}${s.sectorData ? describe(s.sectorData) : "no data"}`,
        );
}

const titleWords = (title) =>
    new Set(
        normaliseTitle(title)
            .split(" ")
            .filter((word) => word.length > 2 && !/^\d+$/.test(word)),
    );

/** Whether an FSD's filename and a reconstruction's title plausibly name the same disc. */
function sameTitle(fsdFile, title) {
    const a = titleWords(path.basename(fsdFile, path.extname(fsdFile)).replace(/^-?\d+b?\s*/, ""));
    const b = titleWords(title);
    for (const word of a)
        for (const other of b) if (word === other || word.startsWith(other) || other.startsWith(word)) return true;
    return false;
}

/**
 * For each FSD and a reconstruction of the same number and title, whether the FSD's key
 * matches, and if not, whether taking out the sectors the reconstruction holds but the dump
 * recorded as errors or unreadable is enough to make the bytes agree.
 */
async function explain() {
    const rows = (await readFile(path.join(corpus, "fsd-match.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const out = [];
    for (const row of rows) {
        for (const candidate of row.candidates ?? []) {
            if (!sameTitle(row.fsd, candidate.title)) continue;
            const result = { fsd: row.fsd, path: candidate.path, title: candidate.title, sides: candidate.sides };
            if (candidate.matches) {
                out.push({ ...result, verdict: "match" });
                continue;
            }
            const fsd = parseFsd(await readFile(path.join(fsdDir, row.fsd)));
            const strictKey = fsdFingerprint(fsd, { recoverCrc: false }).discKey;
            if (strictKey === candidate.discKey) {
                out.push({ ...result, verdict: "match without CRC recovery" });
                continue;
            }
            const status = new Map();
            for (const { track: logical, sectors } of fsd.tracks)
                for (const s of sectors) {
                    const id = `${logical}/${s.track}/${s.sector}`;
                    status.set(id, [...(status.get(id) ?? []), describeFsdError(s.error)]);
                }
            const flux = fluxSectors(
                loadFlux(candidate.path, await readFile(path.join(corpus, "hfe", candidate.path))),
                false,
            );
            const invented = {};
            const kept = flux.sectors.filter((s) => {
                const statuses = status.get(`${s.logical}/${s.track}/${s.sector}`) ?? ["absent from the dump"];
                if (statuses.some((x) => x === "ok" || x === "deleted data" || x === "sector not found (&18)"))
                    return true;
                for (const x of new Set(statuses)) invented[x] = (invented[x] ?? 0) + 1;
                return false;
            });
            const withoutInvented = discKeyOf(Buffer.concat(kept.map((s) => s.data)));
            result.invented = invented;
            result.inventedAllFill = flux.sectors
                .filter((s) => !kept.includes(s))
                .every((s) => s.data.every((b) => b === s.data[0]));
            if (withoutInvented === strictKey) result.verdict = "match once invented sectors are removed";
            else {
                result.verdict = "differs";
                result.diff = candidate.diff;
            }
            out.push(result);
        }
    }
    for (const r of out) console.log(JSON.stringify(r));
    await writeFile(path.join(corpus, "fsd-explain.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const commands = { pairs, match, titles, reads, track, explain };
const command = commands[process.argv[2]];
if (!command) {
    console.error(`Usage: fsd-study.js ${Object.keys(commands).join("|")} [--corpus dir] [--fsd-dir dir]`);
    process.exit(1);
}
command().catch((error) => {
    console.error(error);
    process.exit(1);
});
