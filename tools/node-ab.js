#!/usr/bin/env node
// Compares the emulator's speed in Node between two commits (or two checkouts), alternating fresh processes
// from each side until the ratio's confidence interval resolves. See usage() and docs/benchmarking.md.
import { execFileSync, fork } from "node:child_process";
import {
    closeSync,
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

import { describeComparison, sampleUntilResolved } from "./ab-stats.js";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SampleScript = path.join(RepoRoot, "tools", "node-ab-sample.js");
const ManifestPath = path.join("public", "benchmarks", "workloads.json");
const ShortShaLength = 10;
const PercentPerUnit = 100;
const Statistics = { total: "mhz", median: "medianSliceMhz" };
const Sides = ["a", "b"];

const Defaults = {
    "min-pairs": "8",
    "max-pairs": "30",
    horizon: "2",
    "warmup-secs": "5",
    "measure-secs": "10",
    statistic: "median",
};

function usage() {
    return `Usage: node tools/node-ab.js <A> <B> [workload ...] [options]

A and B are git refs (each checked out into its own temporary worktree, removed afterwards) or paths to
existing checkouts. With no workloads, every workload in A's ${ManifestPath} runs. B/A > 1 means B is faster.

Options:
  --fake-video          measure the CPU and peripherals without rendering video
  --min-pairs N         pairs taken before the result may stop early (default ${Defaults["min-pairs"]})
  --max-pairs N         the most pairs taken per workload (default ${Defaults["max-pairs"]})
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
  --out-dir DIR         where profiles and deopt logs go (default node-ab-out)
  --work-dir DIR        where the worktrees for refs are made (default the system temp directory)
  -h, --help            this text`;
}

const gitIn = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args) => gitIn(RepoRoot, ...args);

const fileLabel = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "_");

// Node resolves the side's packages from its own checkout; a fresh worktree borrows this one's when the lock
// files match, and installs its own when they do not.
function provideNodeModules(dir) {
    // A release bumps only the package's own version.
    const lock = (checkout) => {
        const {
            version: _version,
            packages,
            ...rest
        } = JSON.parse(readFileSync(path.join(checkout, "package-lock.json"), "utf8"));
        const { version: _packageVersion, ...ownPackage } = packages[""];
        return JSON.stringify({ ...rest, packages: { ...packages, "": ownPackage } });
    };
    if (lock(dir) === lock(RepoRoot)) {
        symlinkSync(path.join(RepoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
        return;
    }
    console.error(`${dir}: package-lock.json differs from this checkout's, so running npm ci there`);
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
}

function prepareSide(spec, workDir, created) {
    if (existsSync(spec) && existsSync(path.join(spec, ManifestPath))) {
        const root = path.resolve(spec);
        const dirty = gitIn(root, "status", "--porcelain") !== "";
        const sha = `${gitIn(root, "rev-parse", "HEAD")}${dirty ? "-dirty" : ""}`;
        return { spec, root, sha, label: fileLabel(path.basename(root)) };
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
function warnOfDifferentWorkloads(sides, names) {
    const [a, b] = sides.map(({ root }) => new Map(readManifest(root).map((entry) => [entry.name, entry])));
    for (const name of names) {
        if (!b.has(name)) throw new Error(`B has no workload "${name}"`);
        const snapshot = (side, root) => readFileSync(path.join(root, "public", "benchmarks", side.get(name).snapshot));
        if (!snapshot(a, sides[0].root).equals(snapshot(b, sides[1].root))) {
            console.error(`Warning: workload "${name}" has a different snapshot on each side`);
        }
    }
}

/**
 * One fresh process running one sample of `workload` from `root`.
 * @returns {Promise<{mhz: number, medianSliceMhz: number, cycles: number, totalMs: number}>}
 */
function runSample(root, workload, options, { execArgv = [], stdoutFile = null } = {}) {
    const args = ["--root", root, "--workload", workload];
    args.push("--warmup-secs", options["warmup-secs"], "--measure-secs", options["measure-secs"]);
    if (options["fake-video"]) args.push("--fake-video");
    const stdout = stdoutFile ? openSync(stdoutFile, "w") : "ignore";
    return new Promise((resolve, reject) => {
        let reply = null;
        const child = fork(SampleScript, args, { execArgv, stdio: ["ignore", stdout, "inherit", "ipc"] });
        child.on("message", (message) => (reply = message));
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (stdoutFile) closeSync(stdout);
            if (reply?.result) resolve(reply.result);
            else reject(new Error(reply?.error ?? `The sample of ${workload} in ${root} exited (${signal ?? code})`));
        });
    });
}

async function diagnosticRuns(sides, names, options) {
    const runs = [];
    for (const [option, flag] of [
        ["cpu-prof", "--cpu-prof"],
        ["trace-deopt", "--trace-deopt"],
    ]) {
        const which = options[option];
        if (!which) continue;
        if (!["a", "b", "both"].includes(which)) throw new Error(`--${option} takes a, b or both, not "${which}"`);
        for (const [index, side] of sides.entries()) {
            if (which === "both" || which === Sides[index]) runs.push({ option, flag, side, index });
        }
    }
    if (runs.length === 0) return [];
    const outDir = path.resolve(options["out-dir"]);
    mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const name of names) {
        for (const { option, flag, side, index } of runs) {
            // Both sides of an A/A run carry the same label.
            const base = `${Sides[index]}-${side.label}-${name}`;
            if (option === "cpu-prof") {
                const file = `${base}.cpuprofile`;
                const execArgv = [flag, "--cpu-prof-dir", outDir, "--cpu-prof-name", file];
                await runSample(side.root, name, options, { execArgv });
                written.push(path.join(outDir, file));
            } else {
                const file = path.join(outDir, `${base}.deopt.log`);
                await runSample(side.root, name, options, { execArgv: [flag], stdoutFile: file });
                written.push(file);
            }
        }
    }
    return written;
}

async function compare(sides, names, options) {
    const key = Statistics[options.statistic];
    if (!key) throw new Error(`--statistic is median or total, not "${options.statistic}"`);
    const settings = {
        minPairs: Number(options["min-pairs"]),
        maxPairs: Number(options["max-pairs"]),
        horizon: Number(options.horizon) / PercentPerUnit,
    };
    const results = [];
    for (const name of names) {
        const raw = [];
        const sample = async (side) => {
            const result = await runSample(sides[Sides.indexOf(side)].root, name, options);
            raw.push({ side, ...result });
            return result[key];
        };
        const onPair = ({ pairs, ratio, low, high }) =>
            console.error(`  ${name} ${pairs} pairs: ${ratio.toFixed(3)} [${low.toFixed(3)}, ${high.toFixed(3)}]`);
        const result = await sampleUntilResolved({ sample, onPair, ...settings });
        console.log(describeComparison(name, result));
        results.push({ workload: name, ...result, raw });
    }
    return results;
}

async function main() {
    const { values: options, positionals } = parseArgs({
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
            "out-dir": { type: "string", default: "node-ab-out" },
            "work-dir": { type: "string", default: os.tmpdir() },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (options.help || positionals.length < 2) {
        console.log(usage());
        return options.help ? 0 : 1;
    }
    const [specA, specB, ...requested] = positionals;
    const created = [];
    const cleanUp = () => {
        removeWorktrees(created);
        process.exit(1);
    };
    process.once("SIGINT", cleanUp);
    process.once("SIGTERM", cleanUp);
    try {
        const sides = [specA, specB].map((spec) => prepareSide(spec, options["work-dir"], created));
        const names = requested.length > 0 ? requested : readManifest(sides[0].root).map(({ name }) => name);
        warnOfDifferentWorkloads(sides, names);
        for (const [index, side] of sides.entries()) {
            console.error(`${Sides[index].toUpperCase()}: ${side.spec} at ${side.root}`);
        }
        const results = await compare(sides, names, options);
        const files = await diagnosticRuns(sides, names, options);
        for (const file of files) console.error(`Wrote ${file}`);
        if (options.json) {
            const report = {
                a: { spec: sides[0].spec, sha: sides[0].sha },
                b: { spec: sides[1].spec, sha: sides[1].sha },
                fakeVideo: options["fake-video"],
                statistic: options.statistic,
                warmupSecs: Number(options["warmup-secs"]),
                measureSecs: Number(options["measure-secs"]),
                node: process.version,
                results,
                files,
            };
            writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
        }
        return 0;
    } finally {
        removeWorktrees(created);
    }
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error.message);
        if (error.cause) console.error(error.cause.message);
        process.exit(1);
    },
);
