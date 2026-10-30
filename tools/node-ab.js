#!/usr/bin/env node
// Compares the emulator's speed in Node, or in an engine's shell, between two commits (or two checkouts),
// alternating fresh processes from each side until the ratio's confidence interval resolves. See usage() and
// docs/benchmarking.md.
import { fork } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { TickMs } from "../src/emulation-tick.js";
import {
    assertWritableFile,
    BenchmarksPath,
    checkoutRef,
    checkWorkloads,
    compareWorkload,
    DiagnosticSides,
    existingCheckout,
    isCheckout,
    ManifestName,
    onInterrupt,
    pairOptions,
    pairOptionsHelp,
    pairOptionSpecs,
    readManifest,
    removeWorktrees,
    RepoRoot,
    reportPairSettings,
    reportSides,
    runMain,
    Sides,
} from "./ab-sides.js";
import { SampleSecsDefaults, wholeSlices } from "./ab-sample.js";
import { bundleSide, findShell, killShells, runShellSample, ShellEngines } from "./shell-bench.js";

const SampleScript = path.join(RepoRoot, "tools", "node-ab-sample.js");
const Statistics = { total: "mhz", median: "medianSliceMhz" };
const Diagnostics = [
    { option: "cpu-prof", flag: "--cpu-prof" },
    { option: "trace-deopt", flag: "--trace-deopt" },
];
const Engines = ["node", ...ShellEngines];

const Defaults = {
    ...SampleSecsDefaults,
    statistic: "median",
    "out-dir": "node-ab-out",
    engine: "node",
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
  --engine ${Engines.join("|")}
                        run the samples in Node or in that engine's shell (default ${Defaults.engine})
  --shell PATH          the shell binary for --engine (default jsvu's, in ~/.jsvu/bin)
  --json FILE           write the full result as JSON
  --cpu-prof a|b|both   after timing, one more run per workload of that side under --cpu-prof (Node only)
  --trace-deopt a|b|both
                        after timing, one more run per workload of that side under --trace-deopt (Node only)
  --out-dir DIR         where profiles and deopt logs go (default ${Defaults["out-dir"]})
  --work-dir DIR        where the worktrees for refs are made (default the system temp directory)
  -h, --help            this text`;
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
            engine: { type: "string", default: Defaults.engine },
            shell: { type: "string" },
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
    if (!Engines.includes(options.engine)) {
        throw new Error(`--engine is one of ${Engines.join(", ")}, not "${options.engine}"`);
    }
    if (options.shell && options.engine === "node") throw new Error("--shell needs an --engine other than node");
    const diagnostics = [];
    for (const { option, flag } of Diagnostics) {
        const which = options[option];
        if (which === undefined) continue;
        if (!Object.hasOwn(DiagnosticSides, which)) {
            throw new Error(`--${option} takes a, b or both, not "${which}"`);
        }
        for (const side of DiagnosticSides[which]) diagnostics.push({ option, flag, side });
    }
    if (diagnostics.length > 0 && options.engine !== "node") {
        throw new Error("--cpu-prof and --trace-deopt are Node's flags, so they need --engine node");
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
        engine: options.engine,
        shell: options.shell,
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

/**
 * How each sample runs: a fresh Node process, or a fresh `shell` (from findShell) running a bundle of the side
 * made in `bundleDir`.
 * @returns {Promise<{description: string, sample: function(number, string): Promise<object>}>} `sample` takes
 *     the side's index and the workload
 */
async function sampleRunner(sides, settings, shell, bundleDir) {
    if (!shell) {
        return {
            description: `Node ${process.version}`,
            sample: (index, name) => runSample(sides[index].root, name, settings),
        };
    }
    const { binary, description } = shell;
    const bundles = [];
    for (const [index, { root }] of sides.entries()) {
        const bundle = path.join(bundleDir, `${Sides[index]}.js`);
        await bundleSide(root, bundle);
        bundles.push(bundle);
    }
    return { description, sample: (index, name) => runShellSample(binary, bundles[index], name, settings) };
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

async function compare(runner, names, settings) {
    const key = Statistics[settings.statistic];
    const results = [];
    for (const name of names) {
        const raw = [];
        const sample = async (side) => {
            const result = await runner.sample(Sides.indexOf(side), name);
            raw.push({ side, ...result });
            return result[key];
        };
        const result = await compareWorkload(name, sample, settings, runner.description);
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
    let bundleDir = null;
    const removeBundles = () => bundleDir && rmSync(bundleDir, { recursive: true, force: true });
    const cleanUp = () => {
        for (const child of running) child.kill();
        killShells();
        removeWorktrees(created);
        removeBundles();
        process.exit(1);
    };
    onInterrupt(cleanUp);
    if (settings.json) assertWritableFile(settings.json);
    if (settings.diagnostics.length > 0) mkdirSync(settings.outDir, { recursive: true });
    try {
        const shell = settings.engine === "node" ? null : findShell(settings.engine, settings.shell);
        const sides = settings.specs.map((spec) => prepareSide(spec, settings.workDir, created));
        const names =
            settings.workloads.length > 0 ? settings.workloads : readManifest(sides[0]).map(({ name }) => name);
        checkWorkloads(sides, names);
        for (const [index, side] of sides.entries()) {
            console.error(`${Sides[index].toUpperCase()}: ${side.spec} at ${side.root}`);
        }
        if (shell) bundleDir = mkdtempSync(path.join(os.tmpdir(), "jsbeeb-shell-ab-"));
        const runner = await sampleRunner(sides, settings, shell, bundleDir);
        const results = await compare(runner, names, settings);
        // Written before the diagnostic runs as well as after, so a failure in them keeps the timings.
        const writeReport = (files) => {
            if (!settings.json) return;
            const { fakeVideo, statistic, warmupSecs, measureSecs } = settings;
            const report = {
                ...reportSides(sides),
                settings: { fakeVideo, statistic, warmupSecs, measureSecs, ...reportPairSettings(settings) },
                node: process.version,
                engine: runner.description,
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
        removeBundles();
    }
}

if (import.meta.main) runMain(main);
