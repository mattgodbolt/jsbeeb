import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { mode7Text } from "./helpers.js";

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
                video: new Video(false, new Uint32Array(1024 * 768), () => {}, { isAtom: true }),
            });
        const original = atom();
        await original.initialise();
        await original.runUntilInput();
        await original.type("CLEAR 4");
        await original.type("F.I=0TO6143 STEP 7;I?#8000=I;N.");
        await original.runFor(123457);

        const restored = atom();
        await restored.initialise();
        const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(original.processor, original.model)));
        restoreSnapshot(restored.processor, restored.model, snapshot);
        restored.processor.video.fb32.set(original.processor.video.fb32);

        const cycles = 100 * 1000;
        await original.runFor(cycles);
        await restored.runFor(cycles);

        expect(restored.processor.video.video6847.snapshotState()).toEqual(
            original.processor.video.video6847.snapshotState(),
        );
        expect(restored.processor.video.fb32).toEqual(original.processor.video.fb32);
    });
});
