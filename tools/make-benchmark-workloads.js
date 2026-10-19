#!/usr/bin/env node
// Builds the benchmark workloads in public/benchmarks from a power-on boot and scripted input. Run with
// --check to build them in memory and compare against the checked-in files instead of writing.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gzip, ungzip } from "pako";
import * as prettier from "prettier";

import { newBenchmarkMachine } from "../src/benchmark-machine.js";
import { WorkloadsDir } from "../src/benchmark-workloads.js";
import { DiscLayout } from "../src/disc.js";
import * as fdc from "../src/fdc.js";
import { BBC } from "../src/keymap.js";
import { createSnapshot, snapshotToJSON } from "../src/snapshot.js";
import { RepoRoot } from "../src/test-machine.js";

const OutDir = path.join(RepoRoot, "public", WorkloadsDir);
const ManifestPath = path.join(OutDir, "workloads.json");
const FramesPerSecond = 50;
// The snapshot records when it was taken; a fixed time keeps two runs byte for byte the same.
const FixedTimestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
const GzipLevel = 9;
const DifferencesNamed = 5;
const PromptTimeoutSecs = 30;
const KeyHoldFrames = 10;
const SettleSecs = 5;

const OsScreenMode = 0x355;
const BasicResidentF = 0x418;
const ResidentIntegerBytes = 4;
const VduStatus = 0xd0;
const VduStatusShadow = 0x10;

// Mark Moxon's annotated source of the disc version (github.com/markmoxon/disc-elite-beebasm) names these.
const EliteQQ11View = 0x87;
const EliteMcntMainLoopCounter = 0x8a;
const EliteQQ12Docked = 0x8e;
const ShiftHoldSecs = 1;
const EliteBootSecs = 12;
const EliteTitleSecs = 2;
const EliteLaunchSecs = 8;

const frames = (machine, count) => (count * machine.model.cyclesPerSecond) / FramesPerSecond;
const seconds = (machine, secs) => secs * machine.model.cyclesPerSecond;

async function pressKey(machine, key) {
    machine.processor.sysvia.keyDownRaw(key);
    await machine.runFor(frames(machine, KeyHoldFrames));
    machine.processor.sysvia.keyUpRaw(key);
}

async function insertBuiltInDisc(machine, name) {
    const disc = fdc.discFor(name, await fdc.load(`discs/${name}`));
    machine.processor.fdc.loadDisc(0, disc);
    return {
        disc1: name,
        disc1Crc32: disc.originalImageCrc32,
        disc1Layout: disc.is40Track ? DiscLayout.expanded40 : DiscLayout.contiguous,
    };
}

async function runBasic(machine, program) {
    await machine.runUntilInput(PromptTimeoutSecs);
    await machine.loadBasic(program);
    await machine.type("RUN");
    await machine.runFor(seconds(machine, SettleSecs));
}

const basicLoopCounter = {
    address: BasicResidentF,
    length: ResidentIntegerBytes,
    what: "the program's loop counter F%",
};
const osModeIs = (mode) => ({ address: OsScreenMode, value: mode, what: `the OS screen mode, MODE ${mode}` });

const StockFittings = {
    coProcessor: false,
    hasMusic5000: false,
    hasTeletextAdaptor: false,
    hasEconet: false,
    hasVideoNula: false,
};

const Workloads = [
    {
        name: "elite",
        model: "B-DFS1.2",
        fittings: StockFittings,
        description: "Elite in flight: launched from Lave station with the default commander, no keys held.",
        source: "public/discs/elite.ssd, Ian Bell's disc image as fixed for jsbeeb (see public/discs/README.elite)",
        async build(machine) {
            const media = await insertBuiltInDisc(machine, "elite.ssd");
            machine.processor.sysvia.keyDownRaw(BBC.SHIFT);
            await machine.runFor(seconds(machine, ShiftHoldSecs));
            machine.processor.sysvia.keyUpRaw(BBC.SHIFT);
            await machine.runFor(seconds(machine, EliteBootSecs));
            await pressKey(machine, BBC.N);
            await machine.runFor(seconds(machine, EliteTitleSecs));
            await pressKey(machine, BBC.F0);
            await machine.runFor(seconds(machine, EliteLaunchSecs));
            return media;
        },
        checks: {
            bytes: [
                { address: EliteQQ12Docked, value: 0, what: "Elite's docked flag QQ12, in space" },
                { address: EliteQQ11View, value: 0, what: "Elite's view type QQ11, the space view" },
            ],
            advancing: { address: EliteMcntMainLoopCounter, length: 1, what: "Elite's main loop counter MCNT" },
        },
    },
    {
        name: "mode0-lines",
        model: "B-DFS1.2",
        fittings: StockFittings,
        description: "A BASIC graphics demo in MODE 0: screen-wide lines EORed on a sweeping path.",
        source: "a BASIC program in tools/make-benchmark-workloads.js",
        program: [
            "10 MODE 0",
            "20 VDU 23,1,0;0;0;0;",
            "30 GCOL 3,1",
            "40 F%=0",
            "50 REPEAT",
            "60 F%=F%+1",
            "70 A=F%/40",
            "80 X%=640+600*SIN(A)",
            "90 Y%=512+480*COS(A*1.3)",
            "100 MOVE 1279-X%,1023-Y%",
            "110 DRAW X%,Y%",
            "120 UNTIL FALSE",
        ],
        checks: { bytes: [osModeIs(0)], advancing: basicLoopCounter },
    },
    {
        name: "mode7-text",
        model: "B-DFS1.2",
        fittings: StockFittings,
        description: "MODE 7 text scrolling up the screen: coloured text, backgrounds and graphics characters.",
        source: "a BASIC program in tools/make-benchmark-workloads.js",
        program: [
            "10 MODE 7",
            "20 F%=0",
            "30 REPEAT",
            "40 F%=F%+1",
            '50 PRINT CHR$(129+F% MOD 7);"Line ";F%;CHR$(157);CHR$(132);"jsbeeb teletext ";CHR$(156);CHR$(146);"\\,l|"',
            "60 UNTIL FALSE",
        ],
        checks: { bytes: [osModeIs(7)], advancing: basicLoopCounter },
    },
    {
        name: "master-shadow",
        model: "Master",
        fittings: StockFittings,
        description: "A Master BASIC demo in shadow MODE 2 (MODE 130): filled triangles in changing colours.",
        source: "a BASIC program in tools/make-benchmark-workloads.js",
        program: [
            "10 MODE 130",
            "20 F%=0",
            "30 REPEAT",
            "40 F%=F%+1",
            "50 A=F%/15",
            "60 GCOL 0,1+F% MOD 7",
            "70 MOVE 640+500*SIN(A),512+400*COS(A)",
            "80 MOVE 640+500*SIN(A+2.1),512+400*COS(A+2.1)",
            "90 PLOT 85,640+300*SIN(A*1.7),512+300*COS(A*1.1)",
            "100 UNTIL FALSE",
        ],
        checks: {
            bytes: [
                osModeIs(2),
                { address: VduStatus, mask: VduStatusShadow, value: VduStatusShadow, what: "the VDU's shadow flag" },
            ],
            advancing: basicLoopCounter,
        },
    },
];

async function buildWorkload(workload) {
    const machine = await newBenchmarkMachine(workload.model, workload.fittings);
    const media = workload.build ? await workload.build(machine) : await runBasic(machine, workload.program.join("\n"));
    const cpu = machine.processor;
    if (!cpu.onFastPath || cpu.debugInstruction.stopped) {
        throw new Error(`${workload.name} finished building with a debug hook installed or stopped at one`);
    }
    const snapshot = createSnapshot(cpu, machine.model, media);
    snapshot.timestamp = FixedTimestamp;
    return gzip(snapshotToJSON(snapshot), { level: GzipLevel });
}

async function manifestFor(workloads) {
    const entries = workloads.map(({ name, model, fittings, description, source, checks }) => ({
        name,
        model,
        fittings,
        description,
        source,
        snapshot: `${name}.json.gz`,
        checks,
    }));
    const options = await prettier.resolveConfig(ManifestPath, { editorconfig: true });
    return prettier.format(JSON.stringify({ workloads: entries }), { ...options, filepath: ManifestPath });
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const isObject = (value) => typeof value === "object" && value !== null;

function differingPaths(expected, actual, at) {
    if (!isObject(expected) || !isObject(actual)) return expected === actual ? [] : [at];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) => differingPaths(expected[key], actual[key], at ? `${at}.${key}` : key));
}

function describeDifference(file, checkedIn, built) {
    const json = (bytes) => JSON.parse(new TextDecoder().decode(file.endsWith(".gz") ? ungzip(bytes) : bytes));
    const paths = differingPaths(json(checkedIn), json(built), "");
    if (!paths.length) return "the same JSON, encoded differently";
    const more = paths.length > DifferencesNamed ? `, and ${paths.length - DifferencesNamed} more` : "";
    return `at ${paths.slice(0, DifferencesNamed).join(", ")}${more}`;
}

async function main() {
    const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
    const outputs = new Map([[ManifestPath, new TextEncoder().encode(await manifestFor(Workloads))]]);
    for (const workload of Workloads) {
        outputs.set(path.join(OutDir, `${workload.name}.json.gz`), await buildWorkload(workload));
    }
    let stale = 0;
    for (const [file, bytes] of outputs) {
        const relative = path.relative(RepoRoot, file);
        if (!values.check) {
            writeFileSync(file, bytes);
            console.log(`${relative}: ${bytes.length} bytes`);
        } else {
            const checkedIn = readFileSync(file);
            if (sameBytes(checkedIn, bytes)) continue;
            console.log(
                `${relative} differs from what this script builds, ${describeDifference(file, checkedIn, bytes)}`,
            );
            stale++;
        }
    }
    if (stale) {
        console.log(
            "Rebuild with npm run benchmark:workloads, then npm run test:same-answer -- --record if its hashes change",
        );
        process.exit(1);
    }
}

await main();
