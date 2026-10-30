import { crc32, ungzip } from "./archive.js";
import * as fdc from "./fdc.js";
import { loadData } from "./loader.js";
import { assertSnapshotFits, restoreSnapshot, snapshotFromJSON } from "./snapshot.js";

/** Where the workloads live, under `public/` and so served next to the page. */
export const WorkloadsDir = "benchmarks";
const ManifestFile = `${WorkloadsDir}/workloads.json`;
const DiscKeys = ["disc1", "disc2"];
const HexRadix = 16;

/** The checks run the restored machine this long to see its program move, then restore it again. */
const CheckCycles = 1000 * 1000;

const AllBits = 0xff;
const GzipMagic = [0x1f, 0x8b];

// Vite's preview server sends a .gz file with Content-Encoding: gzip, so the browser has already inflated it.
const isGzip = (bytes) => GzipMagic.every((byte, index) => bytes[index] === byte);
const hex = (value) => `&${value.toString(HexRadix).toUpperCase()}`;

/**
 * Every workload's manifest entry: `name`, `model`, `fittings` (each of the Settings dialog's peripherals, true or
 * false), `description`, `source` (where its disc or program comes from), `snapshot` (the file under WorkloadsDir)
 * and `checks` (see checkWorkload).
 * @returns {Promise<object[]>}
 */
export async function listWorkloads() {
    const bytes = await loadData(ManifestFile);
    return JSON.parse(new TextDecoder().decode(bytes)).workloads;
}

/**
 * The named workload's manifest entry with its parsed snapshot as `snapshot`.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function readWorkload(name) {
    const workloads = await listWorkloads();
    const workload = workloads.find((candidate) => candidate.name === name);
    if (!workload) {
        const known = workloads.map((candidate) => candidate.name).join(", ");
        throw new Error(`No benchmark workload "${name}"; the workloads are ${known}`);
    }
    const bytes = await loadData(`${WorkloadsDir}/${workload.snapshot}`);
    const json = isGzip(bytes) ? await ungzip(bytes) : bytes;
    const snapshot = snapshotFromJSON(new TextDecoder().decode(json));
    return { ...workload, snapshot };
}

/** Throws unless `cpu` will run on executeInternalFast, the path a normal run takes. */
export function assertFastPath(cpu) {
    if (!cpu.onFastPath) {
        throw new Error("A debug hook or tracing is on, so the CPU would run the slow executeInternal");
    }
}

const newDisc = ({ name, data, layout }) => fdc.discFor(name, data, undefined, layout);

// The snapshot names its discs as built-in ones, served from discs/, as a state saved from a default boot does.
async function readDiscImages(media = {}) {
    const images = [];
    for (const key of DiscKeys) {
        const name = media[key];
        if (!name) {
            images.push(null);
            continue;
        }
        const data = await loadData(`discs/${name}`);
        if (crc32(data) !== media[`${key}Crc32`]) {
            throw new Error(`discs/${name} is not the disc the workload was made with`);
        }
        images.push({ name, data, layout: media[`${key}Layout`] });
    }
    return images;
}

// A fresh disc each time, so nothing written to one carries into the next restore; a drive the snapshot
// names no disc for is emptied, whatever the page had put in it.
function restoreWithDiscs(cpu, snapshot, discImages) {
    for (const [drive, image] of discImages.entries()) cpu.fdc.loadDisc(drive, image && newDisc(image));
    restoreSnapshot(cpu, cpu.model, snapshot);
}

/**
 * Throws unless the machine is in the state the workload's name promises: each of `checks.bytes` holds its
 * value (under its mask, if it has one).
 * @param {import('./6502.js').Cpu6502} cpu
 * @param {object} workload
 */
export function checkWorkload(cpu, workload) {
    for (const { address, value, mask = AllBits, what } of workload.checks.bytes) {
        const found = cpu.readmem(address) & mask;
        if (found !== value) {
            throw new Error(
                `Workload "${workload.name}" is not what it says: ${what} at ${hex(address)} ` +
                    `reads ${hex(found)}, not ${hex(value)}`,
            );
        }
    }
}

function advancingBytes(cpu, { address, length }) {
    return Array.from({ length }, (_, offset) => cpu.readmem(address + offset)).join();
}

/**
 * Restores the workload into `cpu`, which must be a machine of the workload's model with no debug hooks, and
 * checks it is doing what its name says: checkWorkload, and `checks.advancing` changing over CheckCycles.
 * The machine is left freshly restored, so every caller starts from the same state.
 * @param {import('./6502.js').Cpu6502} cpu
 * @param {object} workload from readWorkload
 */
export async function restoreWorkload(cpu, workload) {
    const { snapshot } = workload;
    assertSnapshotFits(cpu, cpu.model, snapshot);
    assertFastPath(cpu);
    const discImages = await readDiscImages(snapshot.media);
    restoreWithDiscs(cpu, snapshot, discImages);
    checkWorkload(cpu, workload);
    const { advancing } = workload.checks;
    const before = advancingBytes(cpu, advancing);
    cpu.execute(CheckCycles);
    checkWorkload(cpu, workload);
    if (advancingBytes(cpu, advancing) === before) {
        throw new Error(
            `Workload "${workload.name}" is not running: ${advancing.what} at ${hex(advancing.address)} ` +
                `did not change in ${CheckCycles} cycles`,
        );
    }
    restoreWithDiscs(cpu, snapshot, discImages);
}
