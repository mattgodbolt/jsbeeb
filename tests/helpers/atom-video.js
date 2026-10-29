import { expect } from "vitest";

import { Video } from "../../src/video.js";

const FbWidth = 1024;
const FbHeight = 768;
const VdgLinesPerField = 263;
const VdgCyclesPerLine = 229;
const VdgClockMhz = 3.638004;

export const CpuCyclesPerLine = VdgCyclesPerLine / VdgClockMhz;
export const CpuCyclesPerField = VdgLinesPerField * CpuCyclesPerLine;
export const LinesPerRowMode = 0x50;

/**
 * An Atom's video, with its 6847 in LinesPerRowMode reading patterned RAM, and the vblank levels the VDG
 * raises on the PPIA collected in `vblanks`.
 */
export function makeAtomVideo() {
    const video = new Video(false, FbWidth * FbHeight, () => {}, { isAtom: true });
    const ram = new Uint8Array(0x2000).map((_, i) => (i * 37) ^ (i >>> 5));
    const vblanks = [];
    const cpu = { model: { clockMhz: 1 }, videoRead: (addr) => ram[addr & 0x1fff] };
    const ppia = { portapins: LinesPerRowMode, portcpins: 0x08, setVBlankInt: (level) => vblanks.push(level) };
    video.reset(cpu, null);
    video.video6847.reset(cpu, ppia);
    return { video, vblanks };
}

/** Runs the VDG one CPU cycle at a time, as the CPU drives it, so snow reads can happen. */
export function runCpuCycles(video, cycles) {
    for (let i = 0; i < cycles; i++) video.polltime(1);
}

/** Restores a snapshot of `original` into a new Atom video, and forgets the vblanks the original has seen so far. */
export function restoreInto(original) {
    const restored = makeAtomVideo();
    restored.video.restoreState(original.video.snapshotState());
    restored.video.fb32.set(original.video.fb32);
    original.vblanks.length = 0;
    return restored;
}

function countDifferingPixels(a, b) {
    let count = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
    return count;
}

export function expectSameFrom(original, restored) {
    expect(restored.video.video6847.snapshotState()).toEqual(original.video.video6847.snapshotState());
    expect(restored.vblanks).toEqual(original.vblanks);
    // Counted rather than compared whole, so a failure does not diff a megabyte.
    expect(countDifferingPixels(restored.video.fb32, original.video.fb32)).toBe(0);
}
