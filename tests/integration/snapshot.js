import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { mode7Text } from "./helpers.js";

const FbWidth = 1024;
const FbHeight = 768;
// CPU cycles: an arbitrary point after the program has drawn, and then about eighty lines of the 6847.
const AtomCyclesBeforeSnapshot = 123457;
const AtomCyclesAfterRestore = 5000;

describe("save state round trip", () => {
    it("continues identically in a fresh machine restored through the gzipped file format", async () => {
        const original = new TestMachine();
        await original.initialise();
        await original.runUntilInput();
        await original.type('PRINT "SNAPSHOT"');
        await original.runUntilInput();
        expect(mode7Text(original)).toContain("SNAPSHOT");

        const json = snapshotToJSON(createSnapshot(original.processor, original.model));
        const compressed = await new Response(
            new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
        ).blob();
        const compressedBytes = new Uint8Array(await compressed.arrayBuffer());
        expect([compressedBytes[0], compressedBytes[1]]).toEqual([0x1f, 0x8b]);
        const decompressed = await new Response(
            compressed.stream().pipeThrough(new DecompressionStream("gzip")),
        ).text();
        const snapshot = snapshotFromJSON(decompressed);

        const restored = new TestMachine();
        await restored.initialise();
        restoreSnapshot(restored.processor, restored.model, snapshot);

        expect(mode7Text(restored)).toContain("SNAPSHOT");
        expect(restored.processor.pc).toBe(original.processor.pc);

        const cycles = 4 * 1000 * 1000;
        await original.runFor(cycles);
        await restored.runFor(cycles);

        for (const reg of ["pc", "a", "x", "y", "s"]) expect(restored.processor[reg]).toBe(original.processor[reg]);
        expect(mode7Text(restored)).toBe(mode7Text(original));
        expect(mode7Text(restored)).toContain("SNAPSHOT");
    });

    it("carries an Atom's picture on mid-field in a fresh machine restored from the file format", async () => {
        const atom = () =>
            new TestMachine("Atom", {
                video: new Video(false, new Uint32Array(FbWidth * FbHeight), () => {}, { isAtom: true }),
            });
        const original = atom();
        await original.initialise();
        await original.runUntilInput();
        await original.type("CLEAR 4");
        await original.type("F.I=0TO6143 STEP 7;I?#8000=I;N.");
        await original.runFor(AtomCyclesBeforeSnapshot);

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
