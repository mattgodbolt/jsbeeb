#!/usr/bin/env node
// The same-answer check: runs every benchmark workload from its snapshot for a fixed number of frames and compares
// hashes of the machine's state against tests/same-answer-hashes.json. --record rewrites that file. Its limits are
// in CLAUDE.md, under test:same-answer.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { benchmarkMachine, listBenchmarkWorkloads } from "../src/benchmark-machine.js";
import { assertFastPath } from "../src/benchmark-workloads.js";
import { RepoRoot } from "../src/test-machine.js";

const HashesPath = path.join(RepoRoot, "tests", "same-answer-hashes.json");
const Frames = 100;
const FramesPerSecond = 50;
// TickMs in src/web/emulation-loop.js, so execute() is called as the page calls it.
const BrowserTickMs = 10;
const MsPerSecond = 1000;
const RomBankBytes = 16384;
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

function sidewaysRam(cpu) {
    return cpu.model.swram.flatMap((isRam, bank) => {
        const start = cpu.romOffset + bank * RomBankBytes;
        return isRam ? [cpu.ramRomOs.subarray(start, start + RomBankBytes)] : [];
    });
}

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
        soundChip,
        ...peripherals
    } = cpu.snapshotState();
    return {
        framebuffer: cpu.video.fb32,
        registers: [{ a, x, y, s, pc, p, nmiLevel, nmiEdge, halted, takeInt }, trace.registers],
        memory: [ram, ...sidewaysRam(cpu)],
        cycles: trace.cycles,
        sound: [soundChip, trace.soundEvents],
        peripherals,
    };
}

/**
 * Runs the named workload for Frames frames in browser-tick slices on the fast path, and hashes each part of
 * the state it ends in, with the sound events it sent on the way.
 * @param {string} name
 * @returns {Promise<Record<string, string>>}
 */
export async function workloadHashes(name) {
    const trace = { registers: [], cycles: [], soundEvents: [] };
    const { cpu } = await benchmarkMachine(name, { onSoundEvent: (event) => trace.soundEvents.push(event) });
    trace.soundEvents.length = 0;
    assertFastPath(cpu);
    const { cyclesPerSecond } = cpu.model;
    const tickCycles = (cyclesPerSecond * BrowserTickMs) / MsPerSecond;
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

const relativeHashesPath = path.relative(RepoRoot, HashesPath);

async function record(names) {
    const workloads = {};
    for (const name of names) workloads[name] = await workloadHashes(name);
    writeFileSync(HashesPath, `${JSON.stringify({ frames: Frames, workloads }, null, 2)}\n`);
    console.log(`Wrote ${relativeHashesPath}`);
    return 0;
}

async function failureOf(name, recorded) {
    if (!recorded) return `no recorded hashes in ${relativeHashesPath}`;
    try {
        const differ = differingParts(recorded, await workloadHashes(name));
        return differ.length ? `${differ.join(", ")} differ` : null;
    } catch (error) {
        return error.message;
    }
}

async function check(names) {
    const { frames, workloads } = JSON.parse(readFileSync(HashesPath, "utf8"));
    if (frames !== Frames) {
        console.log(`${relativeHashesPath} was recorded over ${frames} frames, not ${Frames}; rerun with --record`);
        return 1;
    }
    let failures = 0;
    for (const name of names) {
        const failure = await failureOf(name, workloads[name]);
        console.log(failure ? `${name}: FAIL, ${failure}` : `${name}: pass`);
        if (failure) failures++;
    }
    for (const name of Object.keys(workloads).filter((name) => !names.includes(name))) {
        console.log(`${name}: FAIL, recorded in ${relativeHashesPath} but no longer a workload`);
        failures++;
    }
    if (!failures) return 0;
    console.log(`${failures} failed; if the change is intended, rerun with --record and commit ${relativeHashesPath}`);
    return 1;
}

async function main() {
    const { values } = parseArgs({ options: { record: { type: "boolean", default: false } } });
    const names = (await listBenchmarkWorkloads()).map(({ name }) => name);
    return values.record ? record(names) : check(names);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main();
}
