import { test } from "vitest";

import { benchmarkMachine, listBenchmarkWorkloads } from "../../src/benchmark-machine.js";
import { tickCycles } from "../../src/emulation-tick.js";
import { isSameModel } from "../../src/snapshot.js";

// An iteration runs a million cycles, so the hz column Vitest prints reads as virtual MHz.
const CyclesPerIteration = 1000 * 1000;

/**
 * Benchmarks every workload of `model`, always in the manifest's order. Type feedback is shared by every
 * machine in a process, so a bench file covers one model and one kind of video.
 * @param {string} model
 * @param {{fakeVideo: boolean}} options
 */
export async function benchWorkloadsOf(model, { fakeVideo }) {
    const what = fakeVideo ? "the 6502 and its hardware, with fake video" : "a machine with video";
    const workloads = (await listBenchmarkWorkloads()).filter((workload) => isSameModel(workload.model, model));
    for (const { name } of workloads) {
        test(`${name}, ${what}`, async ({ bench }) => {
            const { cpu } = await benchmarkMachine(name, { fakeVideo });
            const cycles = tickCycles(cpu.model.cyclesPerSecond);
            await bench(name, () => {
                for (let run = 0; run < CyclesPerIteration; run += cycles) cpu.execute(cycles);
            }).run();
        });
    }
}
