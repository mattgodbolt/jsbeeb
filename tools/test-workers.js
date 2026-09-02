import os from "node:os";

/**
 * How many of a suite's workers can run at once without starving each other,
 * from what one costs in hardware threads. A test that runs an emulated
 * machine keeps a thread busy for as long as it runs, and a starved emulator
 * times out rather than slowing down, so the count comes from the machine and
 * not from vitest's default of one worker per thread.
 *
 * @param {number} threadsPerWorker hardware threads one worker keeps busy
 * @param {number} [max] most workers worth having, however big the machine
 * @returns {number}
 */
export function workersFor(threadsPerWorker, max = Infinity) {
    return Math.max(1, Math.min(max, Math.floor(os.availableParallelism() / threadsPerWorker)));
}
