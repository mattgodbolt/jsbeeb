// Runs a disc headless and checks a symbol set's anchors against live memory as it boots, loads and
// plays, to see when labels would appear and whether they stay.
//
//   node tools/registry/anchors-run.js <symbol-set.json> <image> [--listing <py8dis.s>]
//       [--exclude-section 0x70a0] [--seconds 240] [--start-key Space --start-at 60] [--seed 1]
//       [--keys KeyZ,KeyX,Quote,Slash] [--model B-DFS1.2] [--patch 0x2000:insert:ea] [--shots <dir>]
//
// With --listing, the listing's bytes are the ground truth: a region counts as loaded when every
// instruction byte nothing writes to matches it, and every anchor candidate (with and without the
// write exclusion) is checked too, not just the chosen ones.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MachineSession } from "../../src/machine-session.js";
import { anchorCandidates, checkRegion, parseAddress, parsePy8disListing, storeTargets } from "./anchors.js";

const SampleCycles = 40000;
const GroundTruthEvery = 25;
const KeyHoldSamples = 15;
const BootHoldSamples = 25;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Moves memory from `at` up by the bytes given, as a build with a few more bytes of code there would. */
function applyPatch(session, spec) {
    const [at, kind, bytesHex] = spec.split(":");
    const address = parseAddress(at);
    const bytes = bytesHex.match(/../g).map((p) => parseInt(p, 16));
    const machine = session._machine;
    if (kind === "insert") {
        for (let a = 0x7fff - bytes.length; a >= address; a--) machine.writebyte(a + bytes.length, machine.readbyte(a));
    }
    bytes.forEach((b, i) => machine.writebyte(address + i, b));
}

class Tracker {
    constructor(name, check) {
        this.name = name;
        this.check = check;
        this.firstMatch = null;
        this.matchesBeforeLoad = 0;
        this.breaksAfterMatch = 0;
        this.lastBreak = null;
        this.missesWhileLoaded = 0;
    }

    sample(time, loaded) {
        const matched = this.check();
        if (matched && this.firstMatch === null) this.firstMatch = time;
        if (matched && loaded === false) this.matchesBeforeLoad++;
        if (!matched && this.firstMatch !== null) {
            this.breaksAfterMatch++;
            this.lastBreak = time;
        }
        if (!matched && loaded) this.missesWhileLoaded++;
    }
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            listing: { type: "string" },
            "exclude-section": { type: "string", multiple: true, default: [] },
            seconds: { type: "string", default: "240" },
            "start-key": { type: "string", default: "Space" },
            "start-at": { type: "string", default: "60" },
            keys: { type: "string", default: "KeyZ,KeyX,Quote,Slash" },
            seed: { type: "string", default: "1" },
            model: { type: "string", default: "B-DFS1.2" },
            patch: { type: "string" },
            "patch-at": { type: "string", default: "50" },
            shots: { type: "string" },
        },
    });
    const [setPath, image] = positionals;
    const setFile = JSON.parse(readFileSync(setPath, "utf8"));
    const [setName, set] = Object.entries(setFile.set ?? setFile)[0];
    const session = new MachineSession(values.model, { discImage: image });
    await session.initialise();
    await session.boot(30);
    const readByte = (a) => session._machine.readbyte(a);

    const regions = Object.entries(set.regions).map(([name, region]) => ({
        name,
        start: parseAddress(region.start),
        end: parseAddress(region.end),
        region,
    }));
    const regionTrackers = regions.map((r) => new Tracker(r.name, () => checkRegion(r.region, readByte).matched));
    const anchorTrackers = regions.flatMap((r) =>
        r.region.anchors.map(
            (anchor) =>
                new Tracker(`${r.name}@${anchor.at}`, () => checkRegion({ anchors: [anchor] }, readByte).matched),
        ),
    );

    let truth = null;
    const candidatePools = { filtered: [], unfiltered: [] };
    if (values.listing) {
        const listing = parsePy8disListing(readFileSync(values.listing, "utf8"));
        const { written } = storeTargets(listing, { excludeSections: values["exclude-section"].map(parseAddress) });
        truth = regions.map((r) => {
            const addresses = listing.instructions
                .filter((i) => i.addr >= r.start && i.addr < r.end)
                .flatMap((i) => i.bytes.map((_, k) => i.addr + k))
                .filter((a) => !written.has(a));
            return {
                ...r,
                addresses,
                expected: addresses.map((a) => listing.bytes.get(a)),
                changed: new Set(),
                written,
            };
        });
        for (const [pool, respectWrites] of [
            ["filtered", true],
            ["unfiltered", false],
        ]) {
            for (const r of regions) {
                for (const c of anchorCandidates(listing, r, written, { regions, respectWrites })) {
                    const anchor = { at: c.at, bytes: c.bytes.map((b) => b.toString(16).padStart(2, "0")).join("") };
                    candidatePools[pool].push({
                        region: r.name,
                        tracker: new Tracker(
                            `${r.name}@${c.at.toString(16)}`,
                            () => checkRegion({ anchors: [anchor] }, readByte).matched,
                        ),
                    });
                }
            }
        }
        // Every byte the listing holds for a region, to find what changes once it has loaded.
        for (const t of truth) {
            t.allAddresses = [];
            for (let a = t.start; a < t.end; a++) if (listing.bytes.has(a)) t.allAddresses.push(a);
            t.allExpected = t.allAddresses.map((a) => listing.bytes.get(a));
        }
    }

    const random = mulberry32(Number(values.seed));
    const keys = values.keys.split(",");
    const startAt = Number(values["start-at"]);
    const totalSamples = Math.round((Number(values.seconds) * 2e6) / SampleCycles);
    let held = null;
    let holdLeft = 0;
    const loadedAt = {};
    let patched = false;

    session.keyDown("ShiftLeft");
    session.reset(false);
    for (let sample = 0; sample < totalSamples; sample++) {
        await session.runFor(SampleCycles);
        const time = (sample + 1) * (SampleCycles / 2e6);
        if (sample === BootHoldSamples) session.keyUp("ShiftLeft");
        if (values.patch && !patched && time >= Number(values["patch-at"])) {
            applyPatch(session, values.patch);
            patched = true;
        }
        if (time >= startAt) {
            if (holdLeft === 0) {
                if (held) session.keyUp(held);
                const r = random();
                held = r < 0.1 ? values["start-key"] : r < 0.2 ? null : keys[Math.floor(random() * keys.length)];
                if (held) session.keyDown(held);
                holdLeft = KeyHoldSamples;
            }
            holdLeft--;
        }
        if (values.shots && sample % 1500 === 1499)
            writeFileSync(`${values.shots}/${Math.round(time)}.png`, await session.screenshot());
        let loadedNow = {};
        if (truth && sample % GroundTruthEvery === 0) {
            for (const t of truth) {
                const loaded = t.addresses.every((a, i) => readByte(a) === t.expected[i]);
                loadedNow[t.name] = loaded;
                if (loaded && loadedAt[t.name] === undefined) loadedAt[t.name] = time;
                if (loadedAt[t.name] !== undefined)
                    t.allAddresses.forEach((a, i) => {
                        if (readByte(a) !== t.allExpected[i]) t.changed.add(a);
                    });
            }
        } else loadedNow = null;
        const loadedFor = (name) => (loadedNow ? loadedNow[name] : undefined);
        regionTrackers.forEach((t) => t.sample(time, loadedFor(t.name)));
        anchorTrackers.forEach((t) => t.sample(time, loadedFor(t.name.split("@")[0])));
        if (sample % 5 === 0)
            for (const pool of Object.values(candidatePools))
                pool.forEach(({ region, tracker }) => tracker.sample(time, loadedFor(region)));
    }

    const round = (t) => (t === null || t === undefined ? null : Math.round(t * 100) / 100);
    const report = {
        set: setName,
        image,
        seconds: Number(values.seconds),
        patch: values.patch ?? null,
        loadedAt: Object.fromEntries(Object.entries(loadedAt).map(([k, v]) => [k, round(v)])),
        regions: regionTrackers.map((t) => ({
            name: t.name,
            firstMatch: round(t.firstMatch),
            matchesBeforeLoad: t.matchesBeforeLoad,
            breaksAfterMatch: t.breaksAfterMatch,
            missesWhileLoaded: t.missesWhileLoaded,
            lastBreak: round(t.lastBreak),
        })),
        anchors: anchorTrackers.map((t) => ({
            name: t.name,
            firstMatch: round(t.firstMatch),
            matchesBeforeLoad: t.matchesBeforeLoad,
            breaksAfterMatch: t.breaksAfterMatch,
        })),
    };
    if (truth) {
        report.changedAfterLoad = truth.map((t) => {
            const changed = [...t.changed].sort((a, b) => a - b);
            return {
                region: t.name,
                changed: changed.length,
                changedInCode: changed.filter((a) => t.addresses.includes(a) || t.written.has(a)).length,
                changedCodeNotFoundStatically: changed
                    .filter((a) => t.addresses.includes(a))
                    .map((a) => `0x${a.toString(16)}`),
            };
        });
        report.candidates = Object.fromEntries(
            Object.entries(candidatePools).map(([pool, list]) => {
                const matched = list.filter((c) => c.tracker.firstMatch !== null);
                const broken = matched.filter((c) => c.tracker.breaksAfterMatch > 0);
                const early = list.filter((c) => c.tracker.matchesBeforeLoad > 0);
                return [
                    pool,
                    {
                        total: list.length,
                        everMatched: matched.length,
                        brokeAfterMatching: broken.length,
                        broken: broken.slice(0, 20).map((c) => c.tracker.name),
                        matchedBeforeLoad: early.length,
                        early: early.slice(0, 20).map((c) => c.tracker.name),
                    },
                ];
            }),
        );
    }
    console.log(JSON.stringify(report, null, 2));
    session.destroy();
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
