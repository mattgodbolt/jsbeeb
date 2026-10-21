// The two sides of an A/B speed comparison, shared by the Node runner (tools/node-ab.js) and the browser one
// (tools/browser-ab.js): a git ref checked out into a worktree with its packages, or a path used as it is; the
// workloads each side has; and the options both runners take for when to stop.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FewestDecisivePairs, PercentPerUnit } from "./ab-stats.js";

export const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BenchmarksPath = path.join("public", "benchmarks");
export const ManifestName = "workloads.json";
export const Sides = ["a", "b"];
const ShortShaLength = 10;

const PairDefaults = { "min-pairs": "8", "max-pairs": "30", horizon: "2" };

export const pairOptionsHelp = `  --min-pairs N         pairs taken before the result may stop early, at least ${FewestDecisivePairs} (default ${PairDefaults["min-pairs"]})
  --max-pairs N         the most pairs taken per workload, at least ${FewestDecisivePairs} (default ${PairDefaults["max-pairs"]})
  --horizon P           stop once the 99% interval lies within P% of 1, or excludes 1 (default ${PairDefaults.horizon})`;

/** parseArgs' declarations of the options in pairOptionsHelp. */
export const pairOptionSpecs = {
    "min-pairs": { type: "string", default: PairDefaults["min-pairs"] },
    "max-pairs": { type: "string", default: PairDefaults["max-pairs"] },
    horizon: { type: "string", default: PairDefaults.horizon },
};

function wholeNumber(options, name, least) {
    const value = Number(options[name]);
    if (!Number.isInteger(value) || value < least) {
        throw new Error(`--${name} takes a whole number of at least ${least}, not "${options[name]}"`);
    }
    return value;
}

/** The checked `minPairs`, `maxPairs` and `horizon` (a fraction) from parseArgs' values. */
export function pairOptions(options) {
    const minPairs = wholeNumber(options, "min-pairs", FewestDecisivePairs);
    const maxPairs = wholeNumber(options, "max-pairs", Math.max(FewestDecisivePairs, minPairs));
    const horizon = Number(options.horizon);
    if (!(horizon > 0)) throw new Error(`--horizon takes a percentage above 0, not "${options.horizon}"`);
    return { minPairs, maxPairs, horizon: horizon / PercentPerUnit };
}

// Run from a git hook, GIT_DIR and GIT_INDEX_FILE would point every command at the hook's repository, not `dir`.
export const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const gitIn = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv,
    }).trim();
const git = (...args) => gitIn(RepoRoot, ...args);

export const fileLabel = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "_");

/** A package-lock.json's text without the package's own version, which is all a release changes. */
export function comparableLock(text) {
    const { version: _version, packages, ...rest } = JSON.parse(text);
    const { version: _packageVersion, ...ownPackage } = packages[""];
    return JSON.stringify({ ...rest, packages: { ...packages, "": ownPackage } });
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// npm records what it installed in node_modules/.package-lock.json, which leaves out optional packages it skipped.
function installsLock(nodeModules, lockedPackages) {
    const installedLock = path.join(nodeModules, ".package-lock.json");
    if (!existsSync(installedLock)) return false;
    const installed = readJson(installedLock).packages;
    return Object.entries(lockedPackages).every(
        ([name, { version, optional }]) => name === "" || optional || installed[name]?.version === version,
    );
}

/** The nearest node_modules in or above `root` that holds the install its package-lock.json describes. */
export function installedNodeModules(root) {
    const lockedPackages = readJson(path.join(root, "package-lock.json")).packages;
    for (let dir = root; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules");
        if (installsLock(candidate, lockedPackages)) return candidate;
        if (path.dirname(dir) === dir) {
            throw new Error(`No node_modules in or above ${root} holds its package-lock.json's install; run npm ci`);
        }
    }
}

// A fresh worktree borrows this checkout's packages when the lock files match, and installs its own when they
// do not.
function provideNodeModules(dir) {
    const lock = (checkout) => comparableLock(readFileSync(path.join(checkout, "package-lock.json"), "utf8"));
    if (lock(dir) === lock(RepoRoot)) {
        symlinkSync(installedNodeModules(RepoRoot), path.join(dir, "node_modules"), "dir");
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

/** A side that is a path to a checkout with the benchmark workloads, used as it is. */
export function existingCheckout(spec) {
    const root = path.resolve(spec);
    return {
        spec,
        root,
        sha: checkoutSha(root),
        label: fileLabel(path.basename(root)),
        benchmarks: path.join(root, BenchmarksPath),
    };
}

export const isCheckout = (spec) => existsSync(path.join(spec, BenchmarksPath, ManifestName));

/**
 * The git ref `spec` checked out into a new worktree under `workDir` with its packages, recorded in `created` for
 * removeWorktrees.
 */
export function checkoutRef(spec, { workDir, created, prefix }) {
    let sha;
    try {
        sha = git("rev-parse", "--verify", `${spec}^{commit}`);
    } catch (error) {
        throw new Error(`"${spec}" is neither a checkout with benchmark workloads nor a git ref`, { cause: error });
    }
    mkdirSync(workDir, { recursive: true });
    const root = mkdtempSync(path.join(workDir, `${prefix}-${fileLabel(spec)}-`));
    try {
        git("worktree", "add", "--detach", root, sha);
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
    created.push(root);
    if (!isCheckout(root)) {
        throw new Error(`${spec} (${sha}) predates the benchmark workloads, so it cannot be measured`);
    }
    provideNodeModules(root);
    return {
        spec,
        root,
        sha,
        label: fileLabel(`${spec}-${sha.slice(0, ShortShaLength)}`),
        benchmarks: path.join(root, BenchmarksPath),
    };
}

export function removeWorktrees(created) {
    for (const root of created) {
        try {
            git("worktree", "remove", "--force", root);
        } catch (error) {
            console.error(`Could not remove the worktree ${root}: ${error.message}`);
        }
    }
    created.length = 0;
}

/** The manifest's workloads in a side's `benchmarks` directory. */
export const readManifest = ({ benchmarks }) => readJson(path.join(benchmarks, ManifestName)).workloads;

// A workload re-recorded on one side runs different code from the other, which the ratio cannot tell apart
// from a speed change.
export function checkWorkloads(sides, names) {
    const manifests = sides.map((side) => new Map(readManifest(side).map((entry) => [entry.name, entry])));
    for (const name of names) {
        for (const [index, manifest] of manifests.entries()) {
            if (!manifest.has(name)) throw new Error(`${Sides[index].toUpperCase()} has no workload "${name}"`);
        }
        const [a, b] = sides.map(({ benchmarks }, index) =>
            readFileSync(path.join(benchmarks, manifests[index].get(name).snapshot)),
        );
        if (!a.equals(b)) console.error(`Warning: workload "${name}" has a different snapshot on each side`);
    }
}

/** Throws unless `file` could be written: its directory exists and it is not a directory itself. */
export function assertWritableFile(file) {
    const isDirectory = (where) => existsSync(where) && statSync(where).isDirectory();
    if (!isDirectory(path.dirname(path.resolve(file))) || isDirectory(file)) {
        throw new Error(`Cannot write ${file}: it needs to be a file in a directory that exists`);
    }
}
