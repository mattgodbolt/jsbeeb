// The Node side of the benchmark workloads: a TestMachine built the way the page builds its machine.
import { listWorkloads, readWorkload, restoreWorkload } from "./benchmark-workloads.js";
import { setNodeBasePath } from "./loader.js";
import { findModel } from "./models.js";
import { SoundChip } from "./soundchip.js";
import { RepoRoot, TestMachine } from "./test-machine.js";
import { FakeVideo, Video } from "./video.js";

const FbWidth = 1024;
const FbHeight = 625;
// The Master's clock otherwise reads the host's time and zone, and a workload has to run the same everywhere.
const FixedClockMs = Date.UTC(2026, 0, 1);

/**
 * A machine fitted as `fittings` says, with the real Video (or FakeVideo) and the main thread's SoundChip, its sound
 * events going to `onSoundEvent` (dropped by default) where the page would hand them to the audio worklet.
 * @param {string} model
 * @param {{coProcessor: boolean, hasMusic5000: boolean, hasTeletextAdaptor: boolean, hasEconet: boolean,
 *     hasVideoNula: boolean}} fittings a workload's, named as the page's settings name them
 * @param {{fakeVideo?: boolean, onSoundEvent?: function(object): void, drainKind?: "wasm"|"js"}} [options]
 *     drainKind is the video drain to run, PreferredDrain when absent
 * @returns {Promise<TestMachine>}
 */
export async function newBenchmarkMachine(
    model,
    fittings,
    { fakeVideo = false, onSoundEvent = () => {}, drainKind } = {},
) {
    const { coProcessor, hasMusic5000, hasTeletextAdaptor, hasEconet, hasVideoNula } = fittings;
    const { isMaster } = findModel(model);
    const video = fakeVideo
        ? new FakeVideo()
        : new Video(isMaster, FbWidth * FbHeight, () => {}, { hasVideoNula, drainKind });
    const soundChip = new SoundChip(null, { onEvent: onSoundEvent });
    const machine = new TestMachine(model, {
        video,
        soundChip,
        tube: coProcessor,
        hasMusic5000,
        hasTeletextAdaptor,
        econet: hasEconet,
    });
    await machine.initialise();
    machine.processor.cmos.now = () => FixedClockMs;
    machine.processor.cmos.utc = true;
    return machine;
}

/** The workloads' manifest entries, as listWorkloads reads them from this checkout. */
export async function listBenchmarkWorkloads() {
    setNodeBasePath(RepoRoot);
    return listWorkloads();
}

/**
 * A fresh machine running the named workload, restored and checked by restoreWorkload.
 * @param {string} name
 * @param {{fakeVideo?: boolean, onSoundEvent?: function(object): void, drainKind?: "wasm"|"js"}} [options] see
 *     newBenchmarkMachine;
 *     fakeVideo measures the CPU and peripherals without rendering
 * @returns {Promise<{machine: TestMachine, cpu: import('./6502.js').Cpu6502, workload: object}>}
 */
export async function benchmarkMachine(name, options) {
    setNodeBasePath(RepoRoot);
    const workload = await readWorkload(name);
    const machine = await newBenchmarkMachine(workload.model, workload.fittings, options);
    await restoreWorkload(machine.processor, workload);
    return { machine, cpu: machine.processor, workload };
}
