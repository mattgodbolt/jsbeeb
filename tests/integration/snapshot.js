import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../test-machine.js";
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
});
