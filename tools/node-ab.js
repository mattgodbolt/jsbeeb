#!/usr/bin/env node
// Compares the emulator's speed in Node between two commits (or two checkouts), alternating fresh processes
// from each side until the ratio's confidence interval resolves. See usage() and docs/benchmarking.md.
import { execFileSync, fork } from "node:child_process";
import {
    closeSync,
    statSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { describeComparison, FewestDecisivePairs, PercentPerUnit, sampleUntilResolved } from "./ab-stats.js";
import { SlicesPerSecond } from "./node-ab-sample.js";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SampleScript = path.join(RepoRoot, "tools", "node-ab-sample.js");
const ManifestPath = path.join("public", "benchmarks", "workloads.json");
const ShortShaLength = 10;
const Statistics = { total: "mhz", median: "medianSliceMhz" };
const Sides = ["a", "b"];
const DiagnosticSides = { a: ["a"], b: ["b"], both: ["a", "b"] };
const Diagnostics = [
    { option: "cpu-prof", flag: "--cpu-prof" },
    { option: "trace-deopt", flag: "--trace-deopt" },
];
// Decimal seconds are not exact in binary: 1.1 s is 110.00000000000001 slices.
const SliceTolerance = 1e-6;

const Defaults = {
    "min-pairs": "8",
    "max-pairs": "30",
    horizon: "2",
    "warmup-secs": "5",
    "measure-secs": "10",
    statistic: "median",
    "out-dir": "node-ab-out",
};

function usage() {
    return `Usage: npm run benchmark:ab -- <A> <B> [workload ...] [options]

A and B are git refs (each checked out into its own temporary worktree, removed afterwards) or paths to
existing checkouts. With no workloads, every workload in A's ${ManifestPath} runs. B/A > 1 means B is faster.

Options:
  --fake-video          measure the CPU and peripherals without rendering video
  --min-pairs N         pairs taken before the result may stop early, at least ${FewestDecisivePairs} (default ${Defaults["min-pairs"]})
  --max-pairs N         the most pairs taken per workload, at least ${FewestDecisivePairs} (default ${Defaults["max-pairs"]})
  --horizon P           stop once the 99% interval lies within P% of 1, or excludes 1 (default ${Defaults.horizon})
  --warmup-secs S       emulated seconds run before timing (default ${Defaults["warmup-secs"]})
  --measure-secs S      emulated seconds timed, in 10 ms browser-tick slices (default ${Defaults["measure-secs"]})
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

function wholeNumber(options, name, least) {
    const value = Number(options[name]);
    if (!Number.isInteger(value) || value < least) {
        throw new Error(`--${name} takes a whole number of at least ${least}, not "${options[name]}"`);
    }
    return value;
}

function wholeSlices(options, name, least) {
    const exact = Number(options[name]) * SlicesPerSecond;
    const slices = Math.round(exact);
    if (!(Math.abs(exact - slices) < SliceTolerance) || slices < least) {
        throw new Error(`--${name} takes seconds in whole 10 ms ticks, not "${options[name]}"`);
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
            "min-pairs": { type: "string", default: Defaults["min-pairs"] },
            "max-pairs": { type: "string", default: Defaults["max-pairs"] },
            horizon: { type: "string", default: Defaults.horizon },
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
    const minPairs = wholeNumber(options, "min-pairs", FewestDecisivePairs);
    const maxPairs = wholeNumber(options, "max-pairs", Math.max(FewestDecisivePairs, minPairs));
    const horizon = Number(options.horizon);
    if (!(horizon > 0)) throw new Error(`--horizon takes a percentage above 0, not "${options.horizon}"`);
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
        horizon: horizon / PercentPerUnit,
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

// Run from a git hook, GIT_DIR and GIT_INDEX_FILE would point every command at the hook's repository, not `dir`.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const gitIn = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv,
    }).trim();
const git = (...args) => gitIn(RepoRoot, ...args);

const fileLabel = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "_");

/** A package-lock.json's text without the package's own version, which is all a release changes. */
export function comparableLock(text) {
    const { version: _version, packages, ...rest } = JSON.parse(text);
    const { version: _packageVersion, ...ownPackage } = packages[""];
    return JSON.stringify({ ...rest, packages: { ...packages, "": ownPackage } });
}

// The node_modules Node finds for this checkout, which for a worktree inside another checkout can be that one's.
function ownNodeModules() {
    for (let dir = RepoRoot; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules");
        if (existsSync(candidate)) return candidate;
        if (path.dirname(dir) === dir) throw new Error(`No node_modules in or above ${RepoRoot}; run npm ci`);
    }
}

// Node resolves the side's packages from its own checkout; a fresh worktree borrows this one's when the lock
// files match, and installs its own when they do not.
function provideNodeModules(dir) {
    const lock = (checkout) => comparableLock(readFileSync(path.join(checkout, "package-lock.json"), "utf8"));
    if (lock(dir) === lock(RepoRoot)) {
        symlinkSync(ownNodeModules(), path.join(dir, "node_modules"), "dir");
        return;
    }
    console.error(`${dir}: package-lock.json differs from this checkout's, so running npm ci there`);
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
}

// Untracked files are left out, so the --out-dir or --json output written into a checkout does not count.
export function checkoutSha(root) {
    try {
        const dirty = gitIn(root, "status", "--porcelain", "--untracked-files=no") !== "";
        return `${gitIn(root, "rev-parse", "HEAD")}${dirty ? "-dirty" : ""}`;
    } catch {
        return null;
    }
}

function prepareSide(spec, workDir, created) {
    if (existsSync(spec) && existsSync(path.join(spec, ManifestPath))) {
        const root = path.resolve(spec);
        return { spec, root, sha: checkoutSha(root), label: fileLabel(path.basename(root)) };
    }
    let sha;
    try {
        sha = git("rev-parse", "--verify", `${spec}^{commit}`);
    } catch (error) {
        throw new Error(`"${spec}" is neither a checkout with benchmark workloads nor a git ref`, { cause: error });
    }
    const root = mkdtempSync(path.join(workDir, `jsbeeb-node-ab-${fileLabel(spec)}-`));
    try {
        git("worktree", "add", "--detach", root, sha);
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
    created.push(root);
    if (!existsSync(path.join(root, ManifestPath))) {
        throw new Error(`${spec} (${sha}) predates the benchmark workloads, so it cannot be measured`);
    }
    provideNodeModules(root);
    return { spec, root, sha, label: fileLabel(`${spec}-${sha.slice(0, ShortShaLength)}`) };
}

function removeWorktrees(created) {
    for (const root of created) {
        try {
            git("worktree", "remove", "--force", root);
        } catch (error) {
            console.error(`Could not remove the worktree ${root}: ${error.message}`);
        }
    }
    created.length = 0;
}

const readManifest = (root) => JSON.parse(readFileSync(path.join(root, ManifestPath), "utf8")).workloads;

// A workload re-recorded on one side runs different code from the other, which the ratio cannot tell apart
// from a speed change.
export function checkWorkloads(sides, names) {
    const manifests = sides.map(({ root }) => new Map(readManifest(root).map((entry) => [entry.name, entry])));
    for (const name of names) {
        for (const [index, manifest] of manifests.entries()) {
            if (!manifest.has(name)) throw new Error(`${Sides[index].toUpperCase()} has no workload "${name}"`);
        }
        const [a, b] = sides.map(({ root }, index) =>
            readFileSync(path.join(root, "public", "benchmarks", manifests[index].get(name).snapshot)),
        );
        if (!a.equals(b)) console.error(`Warning: workload "${name}" has a different snapshot on each side`);
    }
}

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

/** Throws unless `file` could be written: its directory exists and it is not a directory itself. */
export function assertWritableFile(file) {
    const isDirectory = (where) => existsSync(where) && statSync(where).isDirectory();
    if (!isDirectory(path.dirname(path.resolve(file))) || isDirectory(file)) {
        throw new Error(`Cannot write ${file}: it needs to be a file in a directory that exists`);
    }
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
            settings.workloads.length > 0 ? settings.workloads : readManifest(sides[0].root).map(({ name }) => name);
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
