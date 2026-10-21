#!/usr/bin/env node
// Compares the emulator's speed in Node between two commits (or two checkouts), alternating fresh processes
// from each side until the ratio's confidence interval resolves. See usage() and docs/benchmarking.md.
import { fork } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { TickMs } from "../src/emulation-tick.js";
import {
    assertWritableFile,
    BenchmarksPath,
    checkoutRef,
    checkWorkloads,
    existingCheckout,
    isCheckout,
    ManifestName,
    pairOptions,
    pairOptionSpecs,
    pairOptionsHelp,
    readManifest,
    RepoRoot,
    removeWorktrees,
    Sides,
} from "./ab-sides.js";
import { describeComparison, PercentPerUnit, sampleUntilResolved } from "./ab-stats.js";
import { SlicesPerSecond } from "./node-ab-sample.js";

const SampleScript = path.join(RepoRoot, "tools", "node-ab-sample.js");
const Statistics = { total: "mhz", median: "medianSliceMhz" };
const DiagnosticSides = { a: ["a"], b: ["b"], both: ["a", "b"] };
const Diagnostics = [
    { option: "cpu-prof", flag: "--cpu-prof" },
    { option: "trace-deopt", flag: "--trace-deopt" },
];
// Decimal seconds are not exact in binary: 1.1 s is 110.00000000000001 slices.
const SliceTolerance = 1e-6;

const Defaults = {
    "warmup-secs": "5",
    "measure-secs": "10",
    statistic: "median",
    "out-dir": "node-ab-out",
};

function usage() {
    return `Usage: npm run benchmark:ab -- <A> <B> [workload ...] [options]

A and B are git refs (each checked out into its own temporary worktree, removed afterwards) or paths to
existing checkouts. With no workloads, every workload in A's ${path.join(BenchmarksPath, ManifestName)} runs.
B/A > 1 means B is faster.

Options:
  --fake-video          measure the CPU and peripherals without rendering video
${pairOptionsHelp}
  --warmup-secs S       emulated seconds run before timing (default ${Defaults["warmup-secs"]})
  --measure-secs S      emulated seconds timed, in ${TickMs} ms browser-tick slices (default ${Defaults["measure-secs"]})
  --statistic median|total
                        a sample's throughput from its median slice, or from the total time (default
                        ${Defaults.statistic}); see docs/benchmarking.md
  --json FILE           write the full result as JSON
  --cpu-prof a|b|both   after timing, one more run per workload of that side under --cpu-prof
  --trace-deopt a|b|both
                        after timing, one more run per workload of that side under --trace-deopt
  --out-dir DIR         where profiles and deopt logs go (default ${Defaults["out-dir"]})
  --work-dir DIR        where the worktrees for refs are made (default the system temp directory)
  -h, --help            this text`;
}

function wholeSlices(options, name, least) {
    const exact = Number(options[name]) * SlicesPerSecond;
    const slices = Math.round(exact);
    if (!(Math.abs(exact - slices) < SliceTolerance) || slices < least) {
        throw new Error(`--${name} takes seconds in whole ${TickMs} ms ticks, not "${options[name]}"`);
    }
    return slices / SlicesPerSecond;
}

/**
 * Reads and checks the command line, so that a mistake fails before any worktree or timed run.
 * @param {string[]} args
 * @returns {object} `help`, or `specs`, `workloads` and the settings
 */
export function parseOptions(args) {
    const { values: options, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            "fake-video": { type: "boolean", default: false },
            ...pairOptionSpecs,
            "warmup-secs": { type: "string", default: Defaults["warmup-secs"] },
            "measure-secs": { type: "string", default: Defaults["measure-secs"] },
            statistic: { type: "string", default: Defaults.statistic },
            json: { type: "string" },
            "cpu-prof": { type: "string" },
            "trace-deopt": { type: "string" },
            "out-dir": { type: "string", default: Defaults["out-dir"] },
            "work-dir": { type: "string", default: os.tmpdir() },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (options.help) return { help: true };
    if (positionals.length < 2) throw new Error(`Name two sides to compare\n\n${usage()}`);
    const { minPairs, maxPairs, horizon } = pairOptions(options);
    if (!Object.hasOwn(Statistics, options.statistic)) {
        throw new Error(`--statistic is median or total, not "${options.statistic}"`);
    }
    const diagnostics = [];
    for (const { option, flag } of Diagnostics) {
        const which = options[option];
        if (which === undefined) continue;
        if (!Object.hasOwn(DiagnosticSides, which)) {
            throw new Error(`--${option} takes a, b or both, not "${which}"`);
        }
        for (const side of DiagnosticSides[which]) diagnostics.push({ option, flag, side });
    }
    const [specA, specB, ...workloads] = positionals;
    return {
        help: false,
        specs: [specA, specB],
        workloads,
        minPairs,
        maxPairs,
        horizon,
        warmupSecs: wholeSlices(options, "warmup-secs", 0),
        measureSecs: wholeSlices(options, "measure-secs", 1),
        fakeVideo: options["fake-video"],
        statistic: options.statistic,
        json: options.json,
        diagnostics,
        outDir: options["out-dir"],
        workDir: options["work-dir"],
    };
}

const prepareSide = (spec, workDir, created) =>
    isCheckout(spec) ? existingCheckout(spec) : checkoutRef(spec, { workDir, created, prefix: "jsbeeb-node-ab" });

const running = new Set();

/**
 * One fresh process running one sample of `workload` from `root`.
 * @returns {Promise<{mhz: number, medianSliceMhz: number, cycles: number, totalMs: number}>}
 */
function runSample(root, workload, settings, { execArgv = [], stdoutFile = null } = {}) {
    const args = ["--root", root, "--workload", workload];
    args.push("--warmup-secs", String(settings.warmupSecs), "--measure-secs", String(settings.measureSecs));
    if (settings.fakeVideo) args.push("--fake-video");
    const stdout = stdoutFile ? openSync(stdoutFile, "w") : "ignore";
    return new Promise((resolve, reject) => {
        let reply = null;
        const child = fork(SampleScript, args, { execArgv, stdio: ["ignore", stdout, "inherit", "ipc"] });
        running.add(child);
        child.on("message", (message) => (reply = message));
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            running.delete(child);
            if (stdoutFile) closeSync(stdout);
            if (reply?.result) resolve(reply.result);
            else reject(new Error(reply?.error ?? `The sample of ${workload} in ${root} exited (${signal ?? code})`));
        });
    });
}

async function diagnosticRuns(sides, names, settings) {
    if (settings.diagnostics.length === 0) return [];
    const outDir = path.resolve(settings.outDir);
    const written = [];
    for (const name of names) {
        for (const { option, flag, side } of settings.diagnostics) {
            const { root, label } = sides[Sides.indexOf(side)];
            // Both sides of an A/A run carry the same label.
            const base = `${side}-${label}-${name}`;
            if (option === "cpu-prof") {
                const file = `${base}.cpuprofile`;
                const execArgv = [flag, "--cpu-prof-dir", outDir, "--cpu-prof-name", file];
                await runSample(root, name, settings, { execArgv });
                written.push(path.join(outDir, file));
            } else {
                const file = path.join(outDir, `${base}.deopt.log`);
                await runSample(root, name, settings, { execArgv: [flag], stdoutFile: file });
                written.push(file);
            }
        }
    }
    return written;
}

async function compare(sides, names, settings) {
    const key = Statistics[settings.statistic];
    const { minPairs, maxPairs, horizon } = settings;
    const results = [];
    for (const name of names) {
        const raw = [];
        const sample = async (side) => {
            const result = await runSample(sides[Sides.indexOf(side)].root, name, settings);
            raw.push({ side, ...result });
            return result[key];
        };
        const onPair = ({ pairs, ratio, low, high }) =>
            console.error(`  ${name} ${pairs} pairs: ${ratio.toFixed(3)} [${low.toFixed(3)}, ${high.toFixed(3)}]`);
        const result = await sampleUntilResolved({ sample, onPair, minPairs, maxPairs, horizon });
        console.log(describeComparison(name, result, `Node ${process.version}`));
        results.push({ workload: name, ...result, raw });
    }
    return results;
}

async function main() {
    const settings = parseOptions(process.argv.slice(2));
    if (settings.help) {
        console.log(usage());
        return 0;
    }
    const created = [];
    const cleanUp = () => {
        for (const child of running) child.kill();
        removeWorktrees(created);
        process.exit(1);
    };
    process.once("SIGINT", cleanUp);
    process.once("SIGTERM", cleanUp);
    process.once("SIGHUP", cleanUp);
    if (settings.json) assertWritableFile(settings.json);
    if (settings.diagnostics.length > 0) mkdirSync(settings.outDir, { recursive: true });
    try {
        const sides = settings.specs.map((spec) => prepareSide(spec, settings.workDir, created));
        const names =
            settings.workloads.length > 0 ? settings.workloads : readManifest(sides[0]).map(({ name }) => name);
        checkWorkloads(sides, names);
        for (const [index, side] of sides.entries()) {
            console.error(`${Sides[index].toUpperCase()}: ${side.spec} at ${side.root}`);
        }
        const results = await compare(sides, names, settings);
        // Written before the diagnostic runs as well as after, so a failure in them keeps the timings.
        const writeReport = (files) => {
            if (!settings.json) return;
            const { fakeVideo, statistic, warmupSecs, measureSecs, minPairs, maxPairs, horizon } = settings;
            const report = {
                a: { spec: sides[0].spec, sha: sides[0].sha },
                b: { spec: sides[1].spec, sha: sides[1].sha },
                settings: {
                    fakeVideo,
                    statistic,
                    warmupSecs,
                    measureSecs,
                    minPairs,
                    maxPairs,
                    horizonPercent: horizon * PercentPerUnit,
                },
                node: process.version,
                results,
                files,
            };
            writeFileSync(settings.json, `${JSON.stringify(report, null, 2)}\n`);
        };
        writeReport([]);
        const files = await diagnosticRuns(sides, names, settings);
        for (const file of files) console.error(`Wrote ${file}`);
        writeReport(files);
        return 0;
    } finally {
        removeWorktrees(created);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(error.message);
            if (error.cause) console.error(error.cause.message);
            process.exit(1);
        },
    );
}
