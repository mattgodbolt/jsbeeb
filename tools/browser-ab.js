#!/usr/bin/env node
// Compares the emulator's speed in a browser between two builds, alternating fresh pages of each side's
// `?benchmark=<workload>` until the ratio's confidence interval resolves. See usage() and docs/benchmarking.md.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium, firefox, webkit } from "@playwright/test";

import playwrightConfig from "../playwright.config.js";
import {
    assertWritableFile,
    checkoutRef,
    checkWorkloads,
    existingCheckout,
    fileLabel,
    gitEnv,
    installedNodeModules,
    isCheckout,
    ManifestName,
    pairOptions,
    pairOptionSpecs,
    pairOptionsHelp,
    readManifest,
    removeWorktrees,
    Sides,
} from "./ab-sides.js";
import { describeComparison, PercentPerUnit, sampleUntilResolved } from "./ab-stats.js";
import { checkGl, chromeArgs } from "./chrome-gl.js";

const BrowserTypes = { chromium, firefox, webkit };
const Passes = ["full", "video", "cpu"];
const Statistics = ["median", "total"];
const Fresh = ["context", "browser"];
const DiagnosticSides = { a: ["a"], b: ["b"], both: ["a", "b"] };
const LoopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
// For a page that never finishes, as one does when Chrome cannot reach the GPU that --gl hardware asks for.
const SampleTimeoutMs = 5 * 60 * 1000;
const ContentTypes = {
    ".css": "text/css",
    ".gz": "application/gzip",
    ".html": "text/html",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".mp3": "audio/mpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".wasm": "application/wasm",
};

const Defaults = {
    project: "chrome",
    gl: "software",
    fresh: "context",
    pass: "full",
    statistic: "median",
    "out-dir": "browser-ab-out",
};

function usage() {
    return `Usage: npm run benchmark:browser-ab -- <A> <B> [workload ...] [options]

A and B are git refs (each checked out into its own temporary worktree, removed afterwards), paths to existing
checkouts, or paths to built pages (a dist folder). Each checkout is built into a folder of its own, and both
sides are served by the same server on ports of their own. With no workloads, every workload in A's
${ManifestName} runs. B/A > 1 means B is faster.

Options:
  --project NAME        the Playwright project in playwright.config.js whose browser runs the pages
                        (default ${Defaults.project}); its browser must already be installed
  --gl software|hardware
                        Chrome's WebGL renderer (default ${Defaults.gl}); see docs/benchmarking.md
  --fresh context|browser
                        what each sample starts afresh: a browser context in one browser, or the whole
                        browser (default ${Defaults.fresh})
  --pass full|video|cpu which of the page's passes a sample's throughput comes from (default ${Defaults.pass})
  --statistic median|total
                        a sample's throughput from the pass's median emulated second, or from its total
                        time (default ${Defaults.statistic})
${pairOptionsHelp}
  --json FILE           write the full result as JSON
  --cpu-prof a|b|both   after timing, one more page per workload of that side under Chrome's profiler
  --out-dir DIR         where profiles go (default ${Defaults["out-dir"]})
  --work-dir DIR        where the worktrees and builds are made (default the system temp directory)
  -h, --help            this text`;
}

function oneOf(options, name, choices) {
    if (!choices.includes(options[name])) {
        throw new Error(`--${name} is one of ${choices.join(", ")}, not "${options[name]}"`);
    }
    return options[name];
}

/**
 * Reads and checks the command line, so that a mistake fails before any worktree, build or timed run.
 * @param {string[]} args
 * @returns {object} `help`, or `specs`, `workloads` and the settings
 */
export function parseOptions(args, projects = playwrightConfig.projects) {
    const { values: options, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            project: { type: "string", default: Defaults.project },
            gl: { type: "string", default: Defaults.gl },
            fresh: { type: "string", default: Defaults.fresh },
            pass: { type: "string", default: Defaults.pass },
            statistic: { type: "string", default: Defaults.statistic },
            ...pairOptionSpecs,
            json: { type: "string" },
            "cpu-prof": { type: "string" },
            "out-dir": { type: "string", default: Defaults["out-dir"] },
            "work-dir": { type: "string", default: os.tmpdir() },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (options.help) return { help: true };
    if (positionals.length < 2) throw new Error(`Name two sides to compare\n\n${usage()}`);
    const project = projects.find(({ name }) => name === options.project);
    if (!project) {
        throw new Error(`--project is one of ${projects.map(({ name }) => name).join(", ")}, not "${options.project}"`);
    }
    const browserName = project.use?.browserName ?? "chromium";
    const cpuProf = options["cpu-prof"];
    if (cpuProf !== undefined) {
        if (!Object.hasOwn(DiagnosticSides, cpuProf))
            throw new Error(`--cpu-prof takes a, b or both, not "${cpuProf}"`);
        if (browserName !== "chromium") throw new Error(`--cpu-prof needs Chrome's profiler, not ${browserName}`);
    }
    const [specA, specB, ...workloads] = positionals;
    return {
        help: false,
        specs: [specA, specB],
        workloads,
        project: project.name,
        browserName,
        channel: project.use?.channel,
        gl: checkGl(options.gl, "--gl"),
        fresh: oneOf(options, "fresh", Fresh),
        pass: oneOf(options, "pass", Passes),
        statistic: oneOf(options, "statistic", Statistics),
        ...pairOptions(options),
        json: options.json,
        profileSides: cpuProf === undefined ? [] : DiagnosticSides[cpuProf],
        outDir: options["out-dir"],
        workDir: options["work-dir"],
    };
}

/**
 * A sample's throughput in virtual MHz from the page's result: the `pass`'s median emulated second, or all its
 * seconds' total time.
 */
export function throughput(result, pass, statistic) {
    const seconds = result.samples[pass].map(({ ms }) => ms);
    const ms =
        statistic === "median"
            ? result.passes[pass].ms.median
            : seconds.reduce((sum, each) => sum + each, 0) / seconds.length;
    return (result.mhz * result.passes.full.ms.median) / ms;
}

const isBuiltPage = (spec) =>
    existsSync(path.join(spec, "index.html")) && existsSync(path.join(spec, "benchmarks", ManifestName));

function build(side, workDir, created) {
    mkdirSync(workDir, { recursive: true });
    const dist = mkdtempSync(path.join(workDir, `jsbeeb-browser-ab-dist-${side.label}-`));
    created.push(dist);
    const vite = path.join(installedNodeModules(side.root), "vite", "bin", "vite.js");
    const { GA_MEASUREMENT_ID: _analytics, ...env } = gitEnv;
    console.error(`Building ${side.spec} into ${dist}`);
    execFileSync(process.execPath, [vite, "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], {
        cwd: side.root,
        env,
        stdio: ["ignore", "inherit", "inherit"],
    });
    return dist;
}

function prepareSide(spec, { workDir, worktrees, dists }) {
    if (isBuiltPage(spec)) {
        const dist = path.resolve(spec);
        return {
            spec,
            dist,
            sha: null,
            label: fileLabel(path.basename(dist)),
            benchmarks: path.join(dist, "benchmarks"),
        };
    }
    const side = isCheckout(spec)
        ? existingCheckout(spec)
        : checkoutRef(spec, { workDir, created: worktrees, prefix: "jsbeeb-browser-ab" });
    return { ...side, dist: build(side, workDir, dists) };
}

/** Serves `dir` on a port of its own on the loopback address, the same way for either side. */
export function serve(dir) {
    const root = path.resolve(dir);
    const server = createServer((request, response) => {
        let file;
        try {
            file = path.join(root, decodeURIComponent(new URL(request.url, "http://localhost").pathname));
        } catch {
            response.writeHead(400).end();
            return;
        }
        if (file !== root && !file.startsWith(root + path.sep)) {
            response.writeHead(403).end();
            return;
        }
        if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!existsSync(file)) {
            response.writeHead(404).end();
            return;
        }
        const contentType = ContentTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream";
        response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        createReadStream(file)
            .on("error", () => response.destroy())
            .pipe(response);
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { address, port } = server.address();
            resolve({ url: `http://${address}:${port}/`, close: () => server.close() });
        });
    });
}

/** Whether a request for `url` would leave the machine; nothing a workload runs comes from elsewhere. */
export const isOffsite = (url) => url.hostname !== "" && !LoopbackHosts.includes(url.hostname);

class Browsers {
    constructor(settings) {
        this.settings = settings;
        this.open = new Set();
        this.shared = null;
    }

    async launch() {
        const { browserName, channel, gl } = this.settings;
        const args = browserName === "chromium" ? chromeArgs(gl) : [];
        const browser = await BrowserTypes[browserName].launch({
            channel,
            args,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
        });
        this.open.add(browser);
        browser.once("disconnected", () => {
            this.open.delete(browser);
            if (this.shared === browser) this.shared = null;
        });
        return browser;
    }

    /** A fresh page in a fresh context, in a fresh browser too with `--fresh browser`; `close` ends all it made. */
    async page() {
        const fresh = this.settings.fresh === "browser";
        const browser = fresh ? await this.launch() : (this.shared ??= await this.launch());
        const context = await browser.newContext({ viewport: playwrightConfig.use.viewport });
        await context.route(isOffsite, (route) => route.abort("blockedbyclient"));
        const page = await context.newPage();
        const close = async () => {
            await context.close();
            if (fresh) await browser.close();
        };
        return { browser, page, close };
    }

    async closeAll() {
        await Promise.all([...this.open].map((browser) => browser.close()));
    }
}

function benchmarkUrl(side, workload) {
    const query = new URLSearchParams({ benchmark: workload.name, model: workload.model });
    return `${side.url}?${query}`;
}

function orTimedOut(record) {
    let timer;
    const timeout = new Promise((resolve) => {
        const error = `it took longer than ${SampleTimeoutMs / 1000} s`;
        timer = setTimeout(() => resolve({ status: "timeout", error }), SampleTimeoutMs);
    });
    return Promise.race([record, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Loads the side's benchmark page for `workload` and waits for its result. `started` sees the page once it has
 * loaded, and `finished` once the benchmark has ended, before the page closes.
 */
async function runPage(browsers, side, workload, { started = async () => {}, finished = async () => {} } = {}) {
    const { browser, page, close } = await browsers.page();
    try {
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(benchmarkUrl(side, workload));
        await started(page);
        const record = await orTimedOut(
            page.evaluate(async () => {
                if (!window.jsbeebBenchmark) return { status: "missing", error: "the page has no ?benchmark mode" };
                const { status, error, result } = await window.jsbeebBenchmark.done;
                return { status, error, result };
            }),
        );
        if (record.status === "done") await finished(page);
        const pageErrors = errors.length ? ` (the page's errors: ${errors.join("; ")})` : "";
        if (record.status !== "done") {
            throw new Error(`The ${workload.name} benchmark on ${side.spec} failed: ${record.error}${pageErrors}`);
        }
        if (errors.length) console.error(`Errors on ${side.spec}'s page: ${errors.join("; ")}`);
        return { result: record.result, browserVersion: browser.version() };
    } finally {
        await close();
    }
}

/**
 * Throws if `side`'s page says it ran on anything but what the run's first page did, which `seen.first` records.
 */
export function checkSamePage(seen, side, { renderer, display, crossOriginIsolated, userAgent }) {
    const ranOn = JSON.stringify({ renderer, display, crossOriginIsolated, userAgent });
    seen.first ??= ranOn;
    if (ranOn !== seen.first) {
        throw new Error(`A page of ${side.toUpperCase()} ran differently from the first: ${ranOn}, not ${seen.first}`);
    }
}

async function compare(sides, workloads, browsers, settings) {
    const { minPairs, maxPairs, horizon, pass, statistic } = settings;
    const results = [];
    const seen = {};
    let engine = null;
    for (const workload of workloads) {
        const raw = [];
        const sample = async (side) => {
            const { result, browserVersion } = await runPage(browsers, sides[Sides.indexOf(side)], workload);
            const gl = settings.browserName === "chromium" ? ` with ${settings.gl} GL` : "";
            engine ??= `${settings.project} ${browserVersion}${gl}, ${result.renderer}`;
            checkSamePage(seen, side, result);
            const mhz = throughput(result, pass, statistic);
            const { commit, crossOriginIsolated, renderer } = result;
            const secondsMs = Object.fromEntries(
                Passes.map((name) => [name, result.samples[name].map(({ ms }) => ms)]),
            );
            raw.push({
                side,
                mhz,
                pageMhz: result.mhz,
                secondsMs,
                split: result.split,
                commit,
                renderer,
                crossOriginIsolated,
            });
            return mhz;
        };
        const onPair = ({ pairs, ratio, low, high }) =>
            console.error(
                `  ${workload.name} ${pairs} pairs: ${ratio.toFixed(3)} [${low.toFixed(3)}, ${high.toFixed(3)}]`,
            );
        const result = await sampleUntilResolved({ sample, onPair, minPairs, maxPairs, horizon });
        console.log(describeComparison(workload.name, result, engine));
        results.push({ workload: workload.name, ...result, raw });
    }
    return { results, engine, page: seen.first ? JSON.parse(seen.first) : null };
}

async function profileRuns(sides, workloads, browsers, settings) {
    if (settings.profileSides.length === 0) return [];
    const outDir = path.resolve(settings.outDir);
    const written = [];
    for (const workload of workloads) {
        for (const side of settings.profileSides) {
            const { label } = sides[Sides.indexOf(side)];
            const file = path.join(outDir, `${side}-${label}-${workload.name}.cpuprofile`);
            let session;
            await runPage(browsers, sides[Sides.indexOf(side)], workload, {
                started: async (page) => {
                    session = await page.context().newCDPSession(page);
                    await session.send("Profiler.enable");
                    await session.send("Profiler.start");
                },
                finished: async () => {
                    const { profile } = await session.send("Profiler.stop");
                    writeFileSync(file, JSON.stringify(profile));
                },
            });
            written.push(file);
        }
    }
    return written;
}

async function main() {
    const settings = parseOptions(process.argv.slice(2));
    if (settings.help) {
        console.log(usage());
        return 0;
    }
    const worktrees = [];
    const dists = [];
    const servers = [];
    const browsers = new Browsers(settings);
    const cleanUp = () => {
        for (const server of servers) server.close();
        removeWorktrees(worktrees);
        for (const dist of dists) rmSync(dist, { recursive: true, force: true });
        dists.length = 0;
    };
    const interrupted = async () => {
        await browsers.closeAll().catch(() => {});
        cleanUp();
        process.exit(1);
    };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    process.once("SIGHUP", interrupted);
    if (settings.json) assertWritableFile(settings.json);
    if (settings.profileSides.length > 0) mkdirSync(settings.outDir, { recursive: true });
    try {
        const sides = settings.specs.map((spec) => prepareSide(spec, { workDir: settings.workDir, worktrees, dists }));
        const manifest = new Map(readManifest(sides[0]).map((entry) => [entry.name, entry]));
        const names = settings.workloads.length > 0 ? settings.workloads : [...manifest.keys()];
        checkWorkloads(sides, names);
        const workloads = names.map((name) => manifest.get(name));
        for (const side of sides) {
            const server = await serve(side.dist);
            servers.push(server);
            side.url = server.url;
        }
        for (const [index, side] of sides.entries()) {
            console.error(`${Sides[index].toUpperCase()}: ${side.spec}, ${side.dist} on ${side.url}`);
        }
        const { results, engine, page } = await compare(sides, workloads, browsers, settings);
        const writeReport = (files) => {
            if (!settings.json) return;
            const { project, gl, fresh, pass, statistic, minPairs, maxPairs, horizon } = settings;
            const report = {
                a: { spec: sides[0].spec, sha: sides[0].sha },
                b: { spec: sides[1].spec, sha: sides[1].sha },
                settings: {
                    project,
                    gl,
                    fresh,
                    pass,
                    statistic,
                    minPairs,
                    maxPairs,
                    horizonPercent: horizon * PercentPerUnit,
                },
                browser: engine,
                page,
                results,
                files,
            };
            writeFileSync(settings.json, `${JSON.stringify(report, null, 2)}\n`);
        };
        writeReport([]);
        const files = await profileRuns(sides, workloads, browsers, settings);
        for (const file of files) console.error(`Wrote ${file}`);
        writeReport(files);
        return 0;
    } finally {
        await browsers.closeAll();
        cleanUp();
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
