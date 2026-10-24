#!/usr/bin/env node
// The same-answer check: runs every benchmark workload from its snapshot for a fixed number of frames and compares
// hashes of the machine's state against tests/same-answer-hashes.json. --record rewrites that file. Its limits are
// in CLAUDE.md, under test:same-answer.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { benchmarkMachine, listBenchmarkWorkloads } from "../src/benchmark-machine.js";
import { assertFastPath } from "../src/benchmark-workloads.js";
import { TickMs } from "../src/emulation-tick.js";
import { RepoRoot } from "../src/test-machine.js";

const HashesPath = path.join(RepoRoot, "tests", "same-answer-hashes.json");
const RelativeHashesPath = path.relative(RepoRoot, HashesPath);
export const Frames = 100;
const FramesPerSecond = 50;
const MsPerSecond = 1000;
const HashHexDigits = 16;

function feed(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(`${value.constructor.name}${value.length}:`);
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else if (Array.isArray(value)) {
        hash.update(`[${value.length}:`);
        for (const item of value) feed(hash, item);
    } else if (value instanceof Set || value instanceof Map) {
        feed(hash, [...value]);
    } else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            hash.update(`${key}=`);
            feed(hash, item);
        }
        hash.update("}");
    } else {
        hash.update(`${typeof value}:${value};`);
    }
}

const hashOf = (value) => {
    const hash = createHash("sha256");
    feed(hash, value);
    return hash.digest("hex").slice(0, HashHexDigits);
};

const registersOf = (cpu) => [cpu.a, cpu.x, cpu.y, cpu.s, cpu.pc, cpu.p.asByte(), cpu.interrupt, cpu.takeInt, cpu.nmi];
const cyclesOf = (cpu) => [
    cpu.cycleSeconds,
    cpu.currentCycles,
    cpu.targetCycles,
    cpu.peripheralCycles,
    cpu.videoCycles,
    cpu.scheduler.epoch,
];

/**
 * The machine's state in the parts a failure is reported by, the registers and cycle counts after every tick
 * included. `peripherals` is everything in the CPU's snapshotState the other parts leave out: the scheduler,
 * VIAs, video registers, ACIA, ADC, FDC and so on.
 */
function stateParts(cpu, trace) {
    const {
        a,
        x,
        y,
        s,
        pc,
        p,
        nmiLevel,
        nmiEdge,
        halted,
        takeInt,
        currentCycles: _currentCycles,
        targetCycles: _targetCycles,
        cycleSeconds: _cycleSeconds,
        peripheralCycles: _peripheralCycles,
        videoCycles: _videoCycles,
        ram,
        roms: _roms,
        swram,
        swramBankMask: _swramBankMask,
        soundChip,
        ...peripherals
    } = cpu.snapshotState();
    return {
        framebuffer: cpu.video.fb32,
        registers: [{ a, x, y, s, pc, p, nmiLevel, nmiEdge, halted, takeInt }, trace.registers],
        memory: [ram, swram],
        cycles: trace.cycles,
        sound: [soundChip, trace.soundEvents],
        peripherals,
    };
}

/**
 * Runs the named workload for Frames frames in browser-tick slices on the fast path, and hashes each part of
 * the state it ends in, with the sound events it sent on the way.
 * @param {string} name
 * @param {"wasm"|"js"|undefined} drainKind the video drain to run, PreferredDrain when undefined
 * @returns {Promise<Record<string, string>>}
 */
export async function workloadHashes(name, drainKind) {
    const trace = { registers: [], cycles: [], soundEvents: [] };
    const { cpu } = await benchmarkMachine(name, {
        drainKind,
        onSoundEvent: (event) => trace.soundEvents.push(event),
    });
    trace.soundEvents.length = 0;
    assertFastPath(cpu);
    const { cyclesPerSecond } = cpu.model;
    const tickCycles = (cyclesPerSecond * TickMs) / MsPerSecond;
    const totalCycles = (cyclesPerSecond * Frames) / FramesPerSecond;
    for (let run = 0; run < totalCycles; run += tickCycles) {
        cpu.execute(tickCycles);
        trace.registers.push(registersOf(cpu));
        trace.cycles.push(cyclesOf(cpu));
    }
    return Object.fromEntries(Object.entries(stateParts(cpu, trace)).map(([part, value]) => [part, hashOf(value)]));
}

/** The parts whose hashes differ, including any present on only one side. */
export function differingParts(expected, actual) {
    const parts = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...parts].filter((part) => expected[part] !== actual[part]);
}

async function record(names) {
    const workloads = {};
    for (const name of names) workloads[name] = await workloadHashes(name);
    writeFileSync(HashesPath, `${JSON.stringify({ frames: Frames, workloads }, null, 2)}\n`);
    console.log(`Wrote ${RelativeHashesPath}`);
    return 0;
}

async function failureOf(name, recorded, hashesOf) {
    if (!recorded) return `no recorded hashes in ${RelativeHashesPath}`;
    try {
        const differ = differingParts(recorded, await hashesOf(name));
        return differ.length ? `${differ.join(", ")} differ` : null;
    } catch (error) {
        return error.message;
    }
}

/**
 * Compares each named workload's hashes with the recorded ones, a line of verdict per workload. A workload
 * recorded but no longer named fails, and so does a file recorded over another number of frames.
 * @param {{frames: number, workloads: Record<string, Record<string, string>>}} recorded the hashes file's contents
 * @param {string[]} names the workloads there are
 * @param {function(string): Promise<Record<string, string>>} [hashesOf]
 * @returns {Promise<{lines: string[], failures: number}>}
 */
export async function checkHashes({ frames, workloads }, names, hashesOf = workloadHashes) {
    if (frames !== Frames) {
        const line = `${RelativeHashesPath} was recorded over ${frames} frames, not ${Frames}; rerun with --record`;
        return { lines: [line], failures: 1 };
    }
    const lines = [];
    let failures = 0;
    const fail = (name, why) => {
        lines.push(`${name}: FAIL, ${why}`);
        failures++;
    };
    for (const name of names) {
        const failure = await failureOf(name, workloads[name], hashesOf);
        if (failure) fail(name, failure);
        else lines.push(`${name}: pass`);
    }
    for (const name of Object.keys(workloads).filter((name) => !names.includes(name))) {
        fail(name, `recorded in ${RelativeHashesPath} but no longer a workload`);
    }
    if (failures) {
        lines.push(
            `${failures} failed; if the change is intended, rerun with --record and commit ${RelativeHashesPath}`,
        );
    }
    return { lines, failures };
}

async function check(names) {
    const { lines, failures } = await checkHashes(JSON.parse(readFileSync(HashesPath, "utf8")), names);
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            `# Same-answer check\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
        );
    }
    return failures ? 1 : 0;
}

async function main() {
    const { values } = parseArgs({ options: { record: { type: "boolean", default: false } } });
    const names = (await listBenchmarkWorkloads()).map(({ name }) => name);
    return values.record ? record(names) : check(names);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main();
}
