#!/usr/bin/env node
// One sample for tools/node-ab.js, in a fresh process: restore a workload from one side's checkout, warm up,
// then time tick-sized execute() calls. The result goes back over the IPC channel, so a --trace-deopt log
// can have stdout to itself.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { median } from "./ab-stats.js";

// TickMs in src/web/emulation-loop.js: execute()'s exit deopts, so the slice size counts.
const BrowserTickMs = 10;
const MsPerSecond = 1000;

/**
 * Runs `measureSecs` emulated seconds in browser-tick slices after `warmupSecs` of the same, timing each slice.
 * @param {import('../src/6502.js').Cpu6502} cpu
 * @param {{warmupSecs: number, measureSecs: number}} options
 * @returns {{cycles: number, totalMs: number, sliceMs: number[]}}
 */
export function timeSlices(cpu, { warmupSecs, measureSecs }) {
    const { cyclesPerSecond } = cpu.model;
    const sliceCycles = Math.round((cyclesPerSecond * BrowserTickMs) / MsPerSecond);
    const slicesPerSecond = MsPerSecond / BrowserTickMs;
    for (let slice = 0; slice < warmupSecs * slicesPerSecond; slice++) cpu.execute(sliceCycles);
    const slices = measureSecs * slicesPerSecond;
    const sliceMs = new Array(slices);
    const start = performance.now();
    let sliceStart = start;
    for (let slice = 0; slice < slices; slice++) {
        cpu.execute(sliceCycles);
        const now = performance.now();
        sliceMs[slice] = now - sliceStart;
        sliceStart = now;
    }
    return { cycles: slices * sliceCycles, totalMs: sliceStart - start, sliceMs };
}

async function main() {
    const { values } = parseArgs({
        options: {
            root: { type: "string" },
            workload: { type: "string" },
            "fake-video": { type: "boolean", default: false },
            "warmup-secs": { type: "string" },
            "measure-secs": { type: "string" },
        },
    });
    const machineModule = pathToFileURL(path.join(values.root, "src", "benchmark-machine.js")).href;
    const { benchmarkMachine } = await import(machineModule);
    const { cpu } = await benchmarkMachine(values.workload, { fakeVideo: values["fake-video"] });
    const { cycles, totalMs, sliceMs } = timeSlices(cpu, {
        warmupSecs: Number(values["warmup-secs"]),
        measureSecs: Number(values["measure-secs"]),
    });
    const sliceCycles = cycles / sliceMs.length;
    return {
        mhz: cycles / totalMs / MsPerSecond,
        medianSliceMhz: sliceCycles / median(sliceMs) / MsPerSecond,
        cycles,
        totalMs,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (result) => process.send({ result }, () => process.exit(0)),
        (error) => process.send({ error: error.stack ?? String(error) }, () => process.exit(1)),
    );
}
