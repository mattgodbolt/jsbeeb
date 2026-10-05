/**
 * Gets a baron title's source at the commit its config names and assembles it the importer's way, so the
 * source repository needs no build rules for jsbeeb: each source on its own, with `-vv` for a listing that
 * gives every byte, `--symbols` for the dump, and its saved sections with `.inf` sidecars.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fingerprint } from "../registry/fingerprint.js";

/** The command-line options every tool that builds a title takes, as parseArgs reads them. */
export const BuildOptions = { source: { type: "string" }, baron: { type: "string" } };
export const BuildUsage = "[--source <checkout>] [--baron <path>]";

export const BuildLayout = { listings: "listings", symbols: "symbols", files: "files" };
export const ListingExtension = ".txt";
export const SymbolsExtension = ".json";

/**
 * The environment without git's own variables: run from a git hook, GIT_DIR or GIT_INDEX_FILE would
 * point `git -C dir` at the repository the hook belongs to.
 */
export function environmentWithoutGit() {
    return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", env: environmentWithoutGit() }).trim();

/**
 * Refuses a source directory that isn't the root of a git checkout of the config's commit with nothing
 * changed or added.
 */
export function checkSourceCommit(config, sourceDir) {
    let root;
    let head;
    let changes;
    try {
        root = git(sourceDir, "rev-parse", "--show-toplevel");
        head = git(sourceDir, "rev-parse", "HEAD");
        changes = git(sourceDir, "status", "--porcelain");
    } catch (error) {
        throw new Error(`${sourceDir} isn't in a git checkout, so nothing says it's ${config.source.commit}`, {
            cause: error,
        });
    }
    if (realpathSync(root) !== realpathSync(sourceDir))
        throw new Error(`${sourceDir} isn't the root of its checkout, ${root}`);
    if (head !== config.source.commit)
        throw new Error(`The checkout ${sourceDir} is at ${head}, and the config names ${config.source.commit}`);
    if (changes) throw new Error(`The checkout ${sourceDir} has changes, so it isn't ${config.source.commit}`);
}

/**
 * Fetches just the config's commit of its repository into `dir`, a new directory, running none of the
 * user's git hooks there.
 */
export function cloneSource(config, dir) {
    const { repository, commit } = config.source;
    mkdirSync(dir, { recursive: true });
    try {
        git(dir, "init", "-q");
        git(dir, "config", "core.hooksPath", "/dev/null");
        git(dir, "fetch", "-q", "--depth", "1", "--", repository, commit);
        git(dir, "checkout", "-q", "FETCH_HEAD");
    } catch (error) {
        throw new Error(`Couldn't fetch ${commit} from ${repository}: ${error.stderr?.toString().trim()}`, {
            cause: error,
        });
    }
}

/**
 * Refuses a config whose `source.disc` isn't one of the images its `madeFrom` names: that disc, in the
 * source repository, is the original the source rebuilds.
 */
export function checkDisc(config, sourceDir) {
    const { disc } = config.source;
    if (disc === undefined) return;
    const { discKey } = fingerprint(disc, readFileSync(path.join(sourceDir, disc)));
    if (!config.madeFrom?.includes(discKey))
        throw new Error(`${disc} is image ${discKey}, which the config's madeFrom doesn't list`);
}

/** The source files `source.assemble`'s globs match, relative to the repository's root, each named once. */
export function sourcesToAssemble(config, sourceDir) {
    const sources = [...new Set(config.source.assemble.flatMap((pattern) => globSync(pattern, { cwd: sourceDir })))];
    if (!sources.length) throw new Error(`Nothing in ${sourceDir} matches ${config.source.assemble.join(", ")}`);
    const names = sources.map((source) => path.parse(source).name);
    const twice = names.filter((name, i) => names.indexOf(name) !== i);
    if (twice.length) throw new Error(`More than one source is called ${[...new Set(twice)].join(", ")}`);
    return sources.sort();
}

/** Baron's arguments to assemble one source, run from the repository's root, into `buildDir`'s layout. */
export function baronArguments(source, buildDir) {
    const name = path.parse(source).name;
    return [
        "-p",
        path.join(buildDir, BuildLayout.files),
        "--inf",
        "--symbols",
        path.join(buildDir, BuildLayout.symbols, `${name}${SymbolsExtension}`),
        "-vv",
        "-log0",
        path.join(buildDir, BuildLayout.listings, `${name}${ListingExtension}`),
        source,
    ];
}

/** The first line of baron's `--version`, which also shows it can be run. Baron exits 1 after printing it. */
export function baronVersion(baron) {
    const { stdout, error } = spawnSync(baron, ["--version"], { encoding: "utf8" });
    const version = stdout?.split("\n")[0].trim();
    if (error || !version?.startsWith("baron "))
        throw new Error(`Can't run baron as ${baron}: give --baron, or set BARON`, { cause: error });
    return version;
}

/**
 * Assembles each source in a run of its own, since one run's listing doesn't say where one source ends
 * and the next begins.
 */
export function assemble(config, sourceDir, buildDir, baron) {
    for (const dir of Object.values(BuildLayout)) mkdirSync(path.join(buildDir, dir), { recursive: true });
    const sources = sourcesToAssemble(config, sourceDir);
    for (const source of sources) {
        try {
            execFileSync(baron, baronArguments(source, buildDir), {
                cwd: sourceDir,
                stdio: ["ignore", "ignore", "pipe"],
            });
        } catch (error) {
            throw new Error(`baron failed on ${source}: ${error.stderr?.toString().trim() || error.message}`, {
                cause: error,
            });
        }
    }
    return sources;
}

/**
 * Runs `use` with the config's source and its baron build, in a temporary directory removed afterwards.
 * @param {{source?: string, baron?: string}} options - an existing checkout of the config's commit to
 *     assemble instead of fetching one, and the baron to run (else BARON, else `baron` on the PATH)
 * @param {(build: {sourceDir: string, buildDir: string, sources: string[], baron: string}) => any} use
 */
export async function withBaronBuild(config, { source, baron } = {}, use) {
    const named = baron ?? process.env.BARON ?? "baron";
    const baronPath = named.includes(path.sep) ? path.resolve(named) : named;
    const version = baronVersion(baronPath);
    const temp = mkdtempSync(path.join(tmpdir(), "symbols-baron-"));
    try {
        const sourceDir = source ?? path.join(temp, "source");
        if (source === undefined) cloneSource(config, sourceDir);
        checkSourceCommit(config, sourceDir);
        checkDisc(config, sourceDir);
        const buildDir = path.join(temp, "build");
        const sources = assemble(config, sourceDir, buildDir, baronPath);
        return await use({ sourceDir, buildDir, sources, baron: version });
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
