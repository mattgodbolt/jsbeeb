#!/usr/bin/env node
/**
 * Checks a title's symbol sets against the title running in a headless jsbeeb: at moments its
 * curator's scenarios choose, which regions' anchors all match memory, as the debugger would see it
 * each time the machine stops, and whether that's exactly the regions expected there. A moment fails
 * if other regions match, or if two matching regions overlap, since the debugger then shows neither.
 *
 * Usage: node tools/symbols/check-memory.js --config symbols-src/pipeline.json --build <build dir>
 *            [--sets public/symbols/sets] [--shots DIR] [SCENARIO...]
 *
 * The config's `check` names the module of scenarios, beside it, and `build.disc` the disc in the
 * build they boot. With no SCENARIO, it runs them all, each on a fresh machine. Exits 1 if any moment
 * fails.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { BBC } from "../../src/keymap.js";
import { MachineSession } from "../../src/machine-session.js";
import { parseSet } from "../../src/symbol-sets.js";
import { regionMatches } from "../../src/symbol-names.js";
import { SymbolsDir } from "./build-index.js";
import { checkBuildCommit } from "./import-baron.js";

const CyclesPerSecond = 2000000;
const Model = "B-DFS1.2";
const BootTimeoutSecs = 30;
const DefaultKeyFrames = 3;
export const ReleaseFrames = 2;

const hex = (address) => `&${address.toString(16).toUpperCase().padStart(4, "0")}`;

/** A title's sets in `dir`, by set id: those whose files start with the config's id. */
export function loadTitleSets(dir, titleId) {
    const prefix = `${titleId}-`;
    return Object.fromEntries(
        readdirSync(dir)
            .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
            .sort()
            .map((name) => [
                name.slice(prefix.length, -".json".length),
                parseSet(JSON.parse(readFileSync(path.join(dir, name), "utf8"))),
            ]),
    );
}

/** Every region whose anchors all match, as "set/region", sorted. */
export function matchingRegions(sets, peek) {
    return Object.entries(sets)
        .flatMap(([id, set]) =>
            set.regions.filter((region) => regionMatches(region, peek)).map((region) => `${id}/${region.name}`),
        )
        .sort();
}

/** Pairs of matching regions over the same addresses, of one set or two: the debugger shows neither. */
export function overlappingRegions(sets, found) {
    const regionOf = (name) => {
        const [id, regionName] = name.split("/");
        return sets[id].regions.find((region) => region.name === regionName);
    };
    const out = [];
    found.forEach((a, i) => {
        for (const b of found.slice(i + 1)) {
            const ra = regionOf(a);
            const rb = regionOf(b);
            if (ra.start < rb.end && rb.start < ra.end) out.push(`${a} and ${b}`);
        }
    });
    return out;
}

/** A B with DFS 1.2 and the disc in, booted with SHIFT+BREAK. */
export async function startMachine(disc) {
    const session = new MachineSession(Model);
    await session.initialise();
    await session.boot(BootTimeoutSecs);
    session.loadDisc(disc);
    session.keyDownRaw(BBC.SHIFT);
    try {
        session.reset(true);
        await session.runFor(CyclesPerSecond);
    } finally {
        session.keyUpRaw(BBC.SHIFT);
    }
    return session;
}

export const runSeconds = (session, seconds) => session.runFor(Math.round(seconds * CyclesPerSecond));

/** Presses a key by its matrix position, held for `frames`. */
export async function pressKey(session, key, frames = DefaultKeyFrames) {
    session.keyDownRaw(key);
    await session.runFrames(frames);
    session.keyUpRaw(key);
    await session.runFrames(ReleaseFrames);
}

/** Holds a key until the PC reaches `address`: a loop that waits for a key comes round while it's down. */
export async function holdUntil(session, key, address) {
    session.keyDownRaw(key);
    try {
        await session.runUntilAddress(address);
    } finally {
        session.keyUpRaw(key);
    }
}

/**
 * Runs a little script of host keys, each command one of: `wait SECS`, `key CODE [FRAMES]` (pressed and
 * released), `down CODE`, `up CODE`, `type TEXT`, and `shot NAME`, which saves NAME.png in `shots` if
 * that's given. CODE is a KeyboardEvent.code.
 */
export async function runScript(session, commands, { shots } = {}) {
    for (const command of commands) {
        const [op, ...args] = command.trim().split(/\s+/);
        switch (op) {
            case "wait":
                await runSeconds(session, parseFloat(args[0]));
                break;
            case "key":
                session.keyDown(args[0]);
                await session.runFrames(parseInt(args[1] ?? `${DefaultKeyFrames}`));
                session.keyUp(args[0]);
                await session.runFrames(ReleaseFrames);
                break;
            case "down":
                session.keyDown(args[0]);
                break;
            case "up":
                session.keyUp(args[0]);
                break;
            case "shot":
                if (shots) writeFileSync(path.join(shots, `${args[0]}.png`), await session.screenshotActive());
                break;
            case "type":
                await session.type(command.trim().slice("type ".length));
                break;
            default:
                throw new Error(`Unknown script command: ${command}`);
        }
    }
}

/**
 * The context a scenario gets: the machine, the sets, the build's built files, where to save screenshots (if anywhere),
 * `address(set, region, name)` for a symbol's address, and `check(moment, expected)`.
 */
function scenarioContext(session, sets, filesDir, shots, results) {
    const address = (id, regionName, name) => {
        const region = sets[id]?.regions.find((r) => r.name === regionName);
        const found = region && [...region.symbols].find(([, symbol]) => symbol === name);
        if (!found) throw new Error(`There's no ${name} in ${id}/${regionName}`);
        return found[0];
    };
    const check = (moment, expected) => {
        const peek = (at) => session.readMemory(at, 1)[0];
        const found = matchingRegions(sets, peek);
        const want = [...expected].sort();
        const overlaps = overlappingRegions(sets, found);
        const ok = found.length === want.length && found.every((r, i) => r === want[i]) && !overlaps.length;
        const pc = session.registers().pc;
        console.log(`${ok ? "ok  " : "FAIL"} ${moment} (PC ${hex(pc)}): ${found.join(", ") || "nothing"}`);
        if (!ok) {
            console.log(`     expected: ${want.join(", ")}`);
            for (const pair of overlaps) console.log(`     overlapping: ${pair}`);
        }
        results.push(ok);
    };
    return { session, sets, filesDir, shots, address, check };
}

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            config: { type: "string" },
            build: { type: "string" },
            sets: { type: "string", default: path.join(SymbolsDir, "sets") },
            shots: { type: "string" },
        },
        allowPositionals: true,
    });
    if (!values.config || !values.build)
        throw new Error("Usage: check-memory.js --config <file> --build <dir> [SCENARIO...]");
    const config = JSON.parse(readFileSync(values.config, "utf8"));
    checkBuildCommit(config, values.build);
    const sets = loadTitleSets(values.sets, config.id);
    const { scenarios } = await import(pathToFileURL(path.resolve(path.dirname(values.config), config.check)).href);
    const disc = path.resolve(values.build, config.build.disc);
    const wanted = positionals.length ? positionals : Object.keys(scenarios);
    if (values.shots) mkdirSync(values.shots, { recursive: true });
    const results = [];
    for (const name of wanted) {
        if (!scenarios[name]) throw new Error(`There's no scenario ${name}`);
        console.log(`-- ${name}`);
        const session = await startMachine(disc);
        try {
            await scenarios[name](
                scenarioContext(session, sets, path.join(values.build, config.build.files), values.shots, results),
            );
        } finally {
            session.destroy();
        }
    }
    const failures = results.filter((ok) => !ok).length;
    console.log(`${results.length} moments, ${failures} failed`);
    return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(error.stack ?? error.message);
            process.exit(1);
        },
    );
}
