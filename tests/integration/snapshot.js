import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { gzipCodec } from "../../src/archive.js";
import { Video } from "../../src/video.js";
import {
    CpuCyclesPerField,
    CpuCyclesPerLine,
    expectSameFrom,
    LinesPerRowMode,
    makeAtomVideo,
    restoreInto,
    runCpuCycles,
} from "../helpers/atom-video.js";
import { mode7Text } from "./helpers.js";

const FbWidth = 1024;
const FbHeight = 768;
const Clear4Mode = 0xf0;
// CPU cycles: an arbitrary point in a field, and then about eighty lines of the 6847.
const AtomCyclesBeforeSnapshot = 12345;
const AtomCyclesAfterRestore = 5000;
const MidPictureLine = 94;
const LinesPerRow = 3;
const SnowAddr = 0x8123;

const withVideo = (model, options) =>
    new TestMachine(model, { video: new Video(false, FbWidth * FbHeight, () => {}, options) });
const stateOf = (machine) => JSON.parse(snapshotToJSON(createSnapshot(machine.processor, machine.model).state));

describe("save state round trip", () => {
    it("continues identically in a fresh machine restored through the gzipped file format", async () => {
        const original = withVideo();
        await original.initialise();
        await original.runUntilInput();
        await original.type('PRINT "SNAPSHOT"');
        await original.runUntilInput();
        expect(mode7Text(original)).toContain("SNAPSHOT");

        const json = snapshotToJSON(createSnapshot(original.processor, original.model));
        const snapshot = snapshotFromJSON(await gzipCodec.decompress(await gzipCodec.compress(json)));

        const restored = withVideo();
        await restored.initialise();
        restoreSnapshot(restored.processor, restored.model, snapshot);

        expect(mode7Text(restored)).toContain("SNAPSHOT");
        expect(restored.processor.pc).toBe(original.processor.pc);

        const cycles = 4 * 1000 * 1000;
        await original.runFor(cycles);
        await restored.runFor(cycles);

        expect(stateOf(restored)).toEqual(stateOf(original));
        expect(mode7Text(restored)).toContain("SNAPSHOT");
    });

    it("carries an Atom's picture on mid-field in a fresh machine restored from the file format", async () => {
        const atom = () => withVideo("Atom", { isAtom: true });
        const original = atom();
        await original.initialise();
        await original.runUntilInput();
        await original.type("CLEAR 4");
        await original.runUntilInput();
        await original.type("F.I=0TO6143 STEP 7;I?#8000=I;N.");
        await original.runUntilInput();
        await original.runFor(AtomCyclesBeforeSnapshot);
        expect(original.processor.video.video6847.lastmode).toBe(Clear4Mode);
        expect(original.readbyte(0x8000 + 700)).toBe(700 & 0xff);

        const restored = atom();
        await restored.initialise();
        const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(original.processor, original.model)));
        restoreSnapshot(restored.processor, restored.model, snapshot);
        restored.processor.video.fb32.set(original.processor.video.fb32);

        await original.runFor(AtomCyclesAfterRestore);
        await restored.runFor(AtomCyclesAfterRestore);

        expect(restored.processor.video.video6847.snapshotState()).toEqual(
            original.processor.video.video6847.snapshotState(),
        );
        const fb = original.processor.video.fb32;
        expect(restored.processor.video.fb32.filter((pixel, i) => pixel !== fb[i]).length).toBe(0);
    });
});

describe("Video6847 snapshot", () => {
    it("carries on exactly as the original does from any cycle of a row mid-picture", () => {
        const rowStart = Math.floor(CpuCyclesPerField + CpuCyclesPerLine * MidPictureLine);
        const rowCycles = Math.ceil(CpuCyclesPerLine * LinesPerRow);
        for (let at = rowStart; at < rowStart + rowCycles; at++) {
            const original = makeAtomVideo();
            runCpuCycles(original.video, at);
            original.video.video6847.cpuAddrAccess(SnowAddr);

            const restored = restoreInto(original);
            expect(restored.video.video6847).toMatchObject({ cpuAddr: SnowAddr, lastmode: LinesPerRowMode });

            for (const { video } of [original, restored]) runCpuCycles(video, 2 * rowCycles);

            expect(original.vblanks).toEqual([]);
            expectSameFrom(original, restored);
        }
    });
});
