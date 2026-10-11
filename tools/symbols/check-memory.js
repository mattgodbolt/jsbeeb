#!/usr/bin/env node
/**
 * Checks a title's symbol sets against the title running in a headless jsbeeb: at moments its
 * curator's scenarios choose, which regions' anchors all match memory, as the debugger would see it
 * each time the machine stops, and whether that's exactly the regions expected there. A moment fails
 * if other regions match, or if two matching regions overlap, since the debugger then shows neither.
 *
 * Usage: node tools/symbols/check-memory.js --config symbols-src/pipeline.json [--source <checkout>]
 *            [--baron <path>] [--sets public/symbols/sets] [--shots DIR] [SCENARIO...]
 *
 * The config's `check` names the module of scenarios, beside it. They boot `source.disc`, the original
 * disc in a baron title's source repository, built as import-baron.js builds it for the scenarios that
 * read its files; or `disc`, a disc image in a zip the config names by its URL, its path in the zip and
 * its key. With no SCENARIO, it runs them all, each on a fresh machine. Exits 1 if any moment fails.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { unzip } from "../../src/archive.js";
import { BBC } from "../../src/keymap.js";
import { MachineSession } from "../../src/machine-session.js";
import { parseSet } from "../../src/symbol-sets.js";
import { regionMatches } from "../../src/symbol-names.js";
import { fingerprint } from "../registry/fingerprint.js";
import { SymbolsDir } from "./build-index.js";
import { BuildLayout, BuildOptions, BuildUsage, withBaronBuild } from "./baron-build.js";

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

/** A seeded linear congruential generator, so random play is the same each run. */
export function seededRandom(seed) {
    let state = seed;
    return (n) => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return Math.floor((state / 0x80000000) * n);
    };
}

const RandomMinHoldFrames = 5;
const RandomHoldFrameRange = 40;

/** Presses keys `random` picks from `keys`, each held a random while, for at least `frames` in all. */
export async function pressRandomKeys(session, keys, random, frames) {
    for (let pressed = 0; pressed < frames;) {
        const key = keys[random(keys.length)];
        const held = RandomMinHoldFrames + random(RandomHoldFrameRange);
        await pressKey(session, key, held);
        pressed += held + ReleaseFrames;
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

/**
 * Fetches a zip of disc images and takes the one `image` names out of it, refusing it unless its key is `key`.
 * @returns {Promise<Uint8Array>}
 */
export async function fetchDisc({ url, image, key }) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetching ${url} failed with ${response.status}`);
    const members = await unzip(new Uint8Array(await response.arrayBuffer()));
    if (!members[image]) throw new Error(`${url} holds no ${image}`);
    const { discKey } = fingerprint(image, members[image]);
    if (discKey !== key) throw new Error(`${image} in ${url} is image ${discKey}, and the config names ${key}`);
    return members[image];
}

/**
 * Runs `use` with the disc a config's scenarios boot: a baron title's `source.disc`, in its build, or a
 * disc the config's `disc` fetches from an archive.
 */
async function withTitleDisc(config, options, use) {
    if (config.source.disc !== undefined)
        return withBaronBuild(config, options, ({ sourceDir, buildDir }) =>
            use({ disc: path.join(sourceDir, config.source.disc), filesDir: path.join(buildDir, BuildLayout.files) }),
        );
    if (config.disc === undefined) throw new Error("The config names no disc to boot, in source.disc or disc");
    const temp = mkdtempSync(path.join(tmpdir(), "symbols-disc-"));
    try {
        const disc = path.join(temp, path.basename(config.disc.image));
        writeFileSync(disc, await fetchDisc(config.disc));
        return await use({ disc });
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            config: { type: "string" },
            ...BuildOptions,
            sets: { type: "string", default: path.join(SymbolsDir, "sets") },
            shots: { type: "string" },
        },
        allowPositionals: true,
    });
    if (!values.config) throw new Error(`Usage: check-memory.js --config <file> ${BuildUsage} [SCENARIO...]`);
    const config = JSON.parse(readFileSync(values.config, "utf8"));
    const sets = loadTitleSets(values.sets, config.id);
    const { scenarios } = await import(pathToFileURL(path.resolve(path.dirname(values.config), config.check)).href);
    const wanted = positionals.length ? positionals : Object.keys(scenarios);
    for (const name of wanted) if (!scenarios[name]) throw new Error(`There's no scenario ${name}`);
    if (values.shots) mkdirSync(values.shots, { recursive: true });
    const results = [];
    await withTitleDisc(config, values, async ({ disc, filesDir }) => {
        for (const name of wanted) {
            console.log(`-- ${name}`);
            const session = await startMachine(disc);
            try {
                await scenarios[name](scenarioContext(session, sets, filesDir, values.shots, results));
            } finally {
                session.destroy();
            }
        }
    });
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
