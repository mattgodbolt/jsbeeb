// One A/B sample's measurement, shared by the Node sample (tools/node-ab-sample.js) and the shell bundle
// (tools/shell-ab-sample.js), so it has no Node or browser dependencies.
import { TickMs } from "../src/emulation-tick.js";
import { median } from "./ab-stats.js";

const MsPerSecond = 1000;
export const SlicesPerSecond = MsPerSecond / TickMs;
// Decimal seconds are not exact in binary: 1.1 s is 110.00000000000001 slices.
const SliceTolerance = 1e-6;

/** The emulated seconds a sample warms up for and then times, as the command lines take them. */
export const SampleSecsDefaults = { "warmup-secs": "5", "measure-secs": "10" };

/**
 * `options[name]`, in seconds, checked to be a whole number of ticks and at least `least` of them.
 * @param {object} options
 * @param {string} name
 * @param {number} least
 * @returns {number}
 */
export function wholeSlices(options, name, least) {
    const exact = Number(options[name]) * SlicesPerSecond;
    const slices = Math.round(exact);
    if (!(Math.abs(exact - slices) < SliceTolerance) || slices < least) {
        throw new Error(`--${name} takes seconds in whole ${TickMs} ms ticks, not "${options[name]}"`);
    }
    return slices / SlicesPerSecond;
}

/**
 * Runs `measureSecs` emulated seconds in browser-tick slices after `warmupSecs` of the same, timing each slice.
 * @param {import('../src/6502.js').Cpu6502} cpu
 * @param {{warmupSecs: number, measureSecs: number}} options
 * @returns {{cycles: number, totalMs: number, sliceMs: number[]}}
 */
export function timeSlices(cpu, { warmupSecs, measureSecs }) {
    const { cyclesPerSecond } = cpu.model;
    const sliceCycles = Math.round((cyclesPerSecond * TickMs) / MsPerSecond);
    const warmupSlices = Math.round(warmupSecs * SlicesPerSecond);
    for (let slice = 0; slice < warmupSlices; slice++) cpu.execute(sliceCycles);
    const slices = Math.round(measureSecs * SlicesPerSecond);
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

/**
 * Restores `workload` with `benchmarkMachine` (from the side being measured) and times it.
 * @param {function(string, {fakeVideo: boolean}): Promise<{cpu: object}>} benchmarkMachine
 * @param {{workload: string, fakeVideo: boolean, warmupSecs: number, measureSecs: number}} options
 * @returns {Promise<{mhz: number, medianSliceMhz: number, cycles: number, totalMs: number}>}
 */
export async function sampleWorkload(benchmarkMachine, { workload, fakeVideo, warmupSecs, measureSecs }) {
    const { cpu } = await benchmarkMachine(workload, { fakeVideo });
    const { cycles, totalMs, sliceMs } = timeSlices(cpu, { warmupSecs, measureSecs });
    const sliceCycles = cycles / sliceMs.length;
    return {
        mhz: cycles / totalMs / MsPerSecond,
        medianSliceMhz: sliceCycles / median(sliceMs) / MsPerSecond,
        cycles,
        totalMs,
    };
}
