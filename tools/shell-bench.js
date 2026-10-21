#!/usr/bin/env node
// Times the benchmark workloads in a JavaScript engine's own shell (V8's d8, SpiderMonkey's js, JavaScriptCore's
// jsc), each sample a fresh shell running one bundle of a checkout. tools/node-ab.js uses it for --engine.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { SampleSecsDefaults, wholeSlices } from "./ab-sample.js";

const ToolsDir = path.dirname(fileURLToPath(import.meta.url));
const RepoRoot = path.resolve(ToolsDir, "..");
const EntryScript = path.join(ToolsDir, "shell-ab-sample.js");
const HostScript = path.join(ToolsDir, "shell-host.js");
const SideModule = "jsbeeb-side:benchmark-machine";
const NodeStandInPrefix = "\0node-stand-in:";
const NodeStandIns = {
    assert: [],
    fs: ["existsSync", "readFileSync"],
    path: ["dirname", "join", "resolve"],
    url: ["fileURLToPath"],
    util: ["inspect"],
};
const JsvuDir = path.join(os.homedir(), ".jsvu");
/** The engines with a shell, as jsvu names them. */
export const ShellEngines = ["v8", "spidermonkey", "javascriptcore"];

function nodeStandIns() {
    return {
        name: "node-stand-ins",
        enforce: "pre",
        resolveId(source) {
            const name = source.replace(/^node:/, "");
            return Object.hasOwn(NodeStandIns, name) ? `${NodeStandInPrefix}${name}` : null;
        },
        load(id) {
            if (!id.startsWith(NodeStandInPrefix)) return null;
            const name = id.slice(NodeStandInPrefix.length);
            const named = NodeStandIns[name].map((member) => `export const ${member} = standIn.${member};`);
            return [`import { ${name} as standIn } from ${JSON.stringify(HostScript)};`, "export default standIn;"]
                .concat(named)
                .join("\n");
        },
    };
}

// A module's import.meta.url is where it lives in the side's checkout, as Node would see it, so that its
// RepoRoot is the side's.
function importMetaUrls() {
    return {
        name: "import-meta-urls",
        enforce: "pre",
        transform(code, id) {
            if (!code.includes("import.meta.url")) return null;
            return code.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(id).href));
        },
    };
}

/**
 * Bundles this checkout's shell entry point with `root`'s benchmark machine into one classic script.
 * @param {string} root a checkout
 * @param {string} file where the bundle goes
 */
export async function bundleSide(root, file) {
    const sideModule = path.join(root, "src", "benchmark-machine.js");
    const { build } = await import("vite");
    await build({
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        resolve: { alias: { [SideModule]: sideModule } },
        plugins: [nodeStandIns(), importMetaUrls()],
        build: {
            lib: { entry: EntryScript, formats: ["iife"], name: "shellBench", fileName: () => path.basename(file) },
            outDir: path.dirname(file),
            emptyOutDir: false,
            target: "esnext",
            minify: false,
            reportCompressedSize: false,
        },
    });
}

/**
 * The shell binary and a description of it for results: jsvu's install of `engine` and the version jsvu
 * recorded, unless `shell` names a binary.
 * @param {string} engine
 * @param {string} [shell]
 * @param {string} [jsvuDir]
 * @returns {{binary: string, description: string}}
 */
export function findShell(engine, shell, jsvuDir = JsvuDir) {
    if (shell) {
        const binary = path.resolve(shell);
        if (!existsSync(binary)) throw new Error(`No shell at ${binary}`);
        return { binary, description: `${engine} (${binary})` };
    }
    const binary = path.join(jsvuDir, "bin", engine);
    if (!existsSync(binary)) {
        throw new Error(`No ${binary}; install it with npx jsvu --engines=${engine}, or name a binary with --shell`);
    }
    const statusFile = path.join(jsvuDir, "status.json");
    const version = existsSync(statusFile) && JSON.parse(readFileSync(statusFile, "utf8"))[engine];
    return { binary, description: `${engine} ${version || "(version unknown)"}` };
}

const running = new Set();

/** Kills any shell still running a sample, with whatever it started. */
export function killShells() {
    for (const child of running) {
        try {
            process.kill(-child.pid);
        } catch {
            running.delete(child);
        }
    }
}

function parseReply(lastLine) {
    try {
        return JSON.parse(lastLine);
    } catch {
        return null;
    }
}

/**
 * One fresh shell running one sample of `workload` from a bundle.
 * @param {string} binary
 * @param {string} bundle from bundleSide
 * @param {string} workload
 * @param {{fakeVideo: boolean, warmupSecs: number, measureSecs: number}} settings
 * @returns {Promise<{mhz: number, medianSliceMhz: number, cycles: number, totalMs: number}>}
 */
export function runShellSample(binary, bundle, workload, { fakeVideo, warmupSecs, measureSecs }) {
    const options = JSON.stringify({ workload, fakeVideo, warmupSecs, measureSecs });
    return new Promise((resolve, reject) => {
        // Its own process group, since not every jsvu wrapper script execs the shell it starts.
        const child = spawn(binary, [bundle, "--", options], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
        running.add(child);
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text) => (output += text));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            running.delete(child);
            const reply = parseReply(output.trim().split("\n").at(-1));
            if (reply?.result) resolve(reply.result);
            else {
                const why = reply?.error ?? `${output.trim() || "no output"}\nexited (${signal ?? code})`;
                reject(new Error(`The sample of ${workload} in ${binary} failed: ${why}`));
            }
        });
    });
}

const usage = () => `Usage: npm run benchmark:shell -- --engine ${ShellEngines.join("|")} [--shell PATH]
    [--root CHECKOUT] [--fake-video] [--warmup-secs S] [--measure-secs S] [workload ...]`;

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            engine: { type: "string" },
            shell: { type: "string" },
            root: { type: "string", default: RepoRoot },
            "fake-video": { type: "boolean", default: false },
            "warmup-secs": { type: "string", default: SampleSecsDefaults["warmup-secs"] },
            "measure-secs": { type: "string", default: SampleSecsDefaults["measure-secs"] },
        },
    });
    if (!ShellEngines.includes(values.engine)) throw new Error(usage());
    const settings = {
        fakeVideo: values["fake-video"],
        warmupSecs: wholeSlices(values, "warmup-secs", 0),
        measureSecs: wholeSlices(values, "measure-secs", 1),
    };
    const { binary, description } = findShell(values.engine, values.shell);
    const root = path.resolve(values.root);
    const workloads =
        positionals.length > 0
            ? positionals
            : JSON.parse(readFileSync(path.join(root, "public", "benchmarks", "workloads.json"), "utf8")).workloads.map(
                  ({ name }) => name,
              );
    const dir = mkdtempSync(path.join(os.tmpdir(), "jsbeeb-shell-bench-"));
    const cleanUp = () => {
        killShells();
        rmSync(dir, { recursive: true, force: true });
        process.exit(1);
    };
    process.once("SIGINT", cleanUp);
    process.once("SIGTERM", cleanUp);
    process.once("SIGHUP", cleanUp);
    try {
        const bundle = path.join(dir, "bundle.js");
        await bundleSide(root, bundle);
        for (const workload of workloads) {
            const { mhz, medianSliceMhz } = await runShellSample(binary, bundle, workload, settings);
            console.log(
                `${workload}: ${medianSliceMhz.toFixed(2)} MHz median slice, ${mhz.toFixed(2)} MHz overall (${description})`,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
