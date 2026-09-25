#!/usr/bin/env node
// Boots every distinct disc in the corpus headless, once per model, holding SHIFT
// through power-on as the web page's autoboot does, and records what the machine
// is doing at fixed points afterwards: where the CPU is executing, whether the OS
// is sitting at a prompt, any error text the VDU printed, the screen mode and the
// text on screen.
//
//   node tools/registry/boot-survey.js --shard 0/8 [--seconds 30] [--models B-DFS1.2,Master] [--out dir]
//   node tools/registry/boot-survey.js --ref 'Superior/Exile.zip#Superior/Exile.ssd' --shot
//
// Shards append to .registry-corpus/boot-survey-<i>.jsonl and skip runs already there.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MachineSession } from "../../src/machine-session.js";
import * as fdc from "../../src/fdc.js";
import { loadRef } from "./diff-images.js";
import { screenState } from "./boot-survey-screen.js";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OsRom = readFileSync(path.join(RepoRoot, "public/roms/os.rom"));
const DefaultModels = ["B-DFS1.2", "Master"];
const SourcePreference = { sth: 0, hfe: 1, bbcmicro: 2 };
export const BootableExtensions = new Set([".ssd", ".dsd", ".hfe"]);
const ShiftHeldSeconds = 1;
const CheckpointSeconds = [10, 20];
// Sampling once a frame's worth of cycles gives 50 samples an emulated second.
const SampleCycles = 40000;
const WindowSamples = 100;
// One in this many non-bbcmicro discs, chosen by key, gets screenshots.
const ShotEvery = 120;

// Error text the MOS, DFS and BASIC print; a program's own text rarely matches these.
const ErrorPattern =
    /Bad command|Dis[ck] error|Dis[ck] fault|Drive fault|File not found|Not found|Bad program|Can't extend|Bad drive|Bad name|Bad filename|Cat full|Disc full|Disk full|Locked|No room|Mistake|Syntax error|Bad MODE|Bad address|Bad option|Not listed|Bad string|Channel|Escape|Bad key|Bad sum|Bad compact|Disc changed|Disc read only| at line \d+/;

export function chooseDiscs(indexPath) {
    const best = new Map();
    readFileSync(indexPath, "utf8")
        .trim()
        .split("\n")
        .forEach((line, order) => {
            const entry = JSON.parse(line);
            if (!BootableExtensions.has(entry.ext)) return;
            const rank = SourcePreference[entry.source] * 1e6 + order;
            const held = best.get(entry.discKey);
            if (!held || rank < held.rank) best.set(entry.discKey, { rank, entry });
        });
    return [...best.values()].map(({ entry }) => entry).sort((a, b) => a.discKey.localeCompare(b.discKey));
}

export const wantsShot = (entry) =>
    entry.source !== "bbcmicro" && parseInt(entry.discKey.slice(0, 6), 16) % ShotEvery === 0;

function transcriptOf(elements) {
    let text = "";
    let last = null;
    for (const element of elements) {
        if (last && (element.y !== last.y || element.x < last.x)) text += "\n";
        text += element.text;
        last = element;
    }
    return text;
}

function romTitle(session, bank) {
    const bytes = session.readMemory(0x8009, 24, { bank });
    let title = "";
    for (const byte of bytes) {
        if (byte < 0x20 || byte > 0x7e) break;
        title += String.fromCharCode(byte);
    }
    return title;
}

// Where a boot ended, from the last window's samples and the VDU transcript. `dfs` is the share
// of samples in a DFS ROM; runs recorded before it was kept estimate it from the banks seen.
export function classify({ ram, sideways, basic, idle, distinctPcs, bankTitles, dfs }, transcript) {
    const lastLine = transcript.trimEnd().split("\n").pop()?.trim() ?? "";
    const dfsShare =
        dfs ?? (Object.values(bankTitles).some((title) => /DFS/.test(title)) && basic < 0.25 ? sideways : 0);
    if (distinctPcs === 1) return "halted";
    if (idle > 0.5 && /^[>*]$/.test(lastLine)) return "prompt";
    if (idle > 0.5) return "input";
    if (/^Searching$/.test(lastLine)) return "tape";
    if (ram >= 0.5) return "running-ram";
    if (basic >= 0.5) return "running-basic";
    if (dfsShare >= 0.5) return "disc-busy";
    return "running-os";
}

function summariseWindow(samples, session, transcript) {
    const window = samples.slice(-WindowSamples);
    const count = (predicate) => window.filter(predicate).length / window.length;
    const banks = new Map();
    for (const sample of window) {
        if (sample.pc >= 0x8000 && sample.pc < 0xc000) banks.set(sample.bank, (banks.get(sample.bank) ?? 0) + 1);
    }
    const bankTitles = Object.fromEntries([...banks.keys()].map((bank) => [bank, romTitle(session, bank)]));
    const shareOf = (pattern) =>
        [...banks.entries()].filter(([bank]) => pattern.test(bankTitles[bank])).reduce((n, [, c]) => n + c, 0) /
        window.length;
    const ram = count((s) => s.pc < 0x8000);
    const mos = count((s) => s.pc >= 0xc000);
    const summary = {
        ram: +ram.toFixed(2),
        sideways: +(1 - ram - mos).toFixed(2),
        basic: +shareOf(/BASIC/).toFixed(2),
        dfs: +shareOf(/DFS/).toFixed(2),
        mos: +mos.toFixed(2),
        idle: +count((s) => s.idle).toFixed(2),
        distinctPcs: new Set(window.map((s) => s.pc)).size,
        bankTitles,
    };
    return { state: classify(summary, transcript), ...summary };
}

export async function bootOne(entry, model, { corpus, seconds, shotPath }) {
    const session = new MachineSession(model);
    await session.initialise();
    const cpu = session._machine.processor;
    const { name, bytes } = await loadRef(corpus, entry.ref);
    cpu.fdc.loadDisc(0, fdc.discFor(name, new Uint8Array(bytes)));

    let idleSeen;
    const idleAddress = cpu.model.idleAddress;
    cpu.debugInstruction.add((pc) => {
        if (pc === idleAddress) idleSeen = true;
        return false;
    });

    const samples = [];
    const elements = [];
    const checkpoints = {};
    const cyclesPerSecond = cpu.model.cyclesPerSecond;
    const totalSamples = Math.round((seconds * cyclesPerSecond) / SampleCycles);
    const shiftSamples = Math.round((ShiftHeldSeconds * cyclesPerSecond) / SampleCycles);
    session.keyDown("ShiftLeft");
    for (let i = 1; i <= totalSamples; ++i) {
        idleSeen = false;
        await session.runFor(SampleCycles);
        samples.push({ pc: cpu.pc, bank: cpu.romsel & 0xf, idle: idleSeen });
        if (i === shiftSamples) session.keyUp("ShiftLeft");
        const at = (i * SampleCycles) / cyclesPerSecond;
        if (CheckpointSeconds.includes(at)) {
            elements.push(...session.drainOutput().elements);
            checkpoints[at] = summariseWindow(samples, session, transcriptOf(elements)).state;
        }
    }
    elements.push(...session.drainOutput().elements);
    const transcript = transcriptOf(elements);
    const final = summariseWindow(samples, session, transcript);
    checkpoints[seconds] = final.state;
    const error = transcript.match(ErrorPattern)?.[0] ?? null;
    const screen = screenState(session, OsRom);
    if (shotPath) writeFileSync(shotPath, await session.screenshotActive({ scale: 1 }));
    session.destroy();
    return {
        ...final,
        checkpoints,
        error,
        pc: cpu.pc,
        vduChars: elements.reduce((n, e) => n + e.text.length, 0),
        transcript: transcript.slice(-1500),
        ...screen,
    };
}

function parseArgs(argv) {
    const args = {
        shard: "0/1",
        seconds: 30,
        models: DefaultModels,
        corpus: ".registry-corpus",
        out: null,
        ref: null,
        shot: false,
    };
    for (let i = 0; i < argv.length; ++i) {
        const flag = argv[i];
        if (flag === "--shard") args.shard = argv[++i];
        else if (flag === "--seconds") args.seconds = Number(argv[++i]);
        else if (flag === "--models") args.models = argv[++i].split(",");
        else if (flag === "--corpus") args.corpus = argv[++i];
        else if (flag === "--out") args.out = argv[++i];
        else if (flag === "--ref") args.ref = argv[++i];
        else if (flag === "--shot") args.shot = true;
        else throw new Error(`Unknown option ${flag}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const print = console.log;
    console.log = () => {};
    const outDir = args.out ?? args.corpus;
    const shotDir = path.join(outDir, "boot-shots");
    mkdirSync(shotDir, { recursive: true });
    const shotFor = (entry, model) => path.join(shotDir, `${entry.discKey}-${model}.png`);

    if (args.ref) {
        const entry = { ref: args.ref, discKey: path.basename(args.ref).replace(/\W/g, "_") };
        for (const model of args.models) {
            const result = await bootOne(entry, model, {
                corpus: args.corpus,
                seconds: args.seconds,
                shotPath: args.shot ? shotFor(entry, model) : null,
            });
            print(JSON.stringify({ model, ...result }, null, 1));
        }
        return;
    }

    const [shard, shards] = args.shard.split("/").map(Number);
    const outPath = path.join(outDir, `boot-survey-${shard}.jsonl`);
    const done = new Set();
    if (existsSync(outPath)) {
        for (const line of readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean)) {
            const { discKey, model } = JSON.parse(line);
            done.add(`${discKey} ${model}`);
        }
    }
    const discs = chooseDiscs(path.join(args.corpus, "index.jsonl")).filter((_, i) => i % shards === shard);
    for (const entry of discs) {
        for (const model of args.models) {
            if (done.has(`${entry.discKey} ${model}`)) continue;
            const base = {
                discKey: entry.discKey,
                model,
                source: entry.source,
                ref: entry.ref,
                title: entry.meta?.title ?? null,
                dfsTitle: entry.catalogues?.[0]?.title ?? null,
                bootOption: entry.catalogues?.[0]?.boot ?? null,
                seconds: args.seconds,
            };
            let result;
            try {
                result = await bootOne(entry, model, {
                    corpus: args.corpus,
                    seconds: args.seconds,
                    shotPath: wantsShot(entry) ? shotFor(entry, model) : null,
                });
            } catch (error) {
                result = { state: "failed", failure: String(error?.message ?? error) };
            }
            appendFileSync(outPath, `${JSON.stringify({ ...base, ...result })}\n`);
        }
    }
    print(`shard ${shard}/${shards}: ${discs.length} discs`);
}

if (process.argv[1]?.endsWith("boot-survey.js")) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
