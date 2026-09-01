import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, snapshotFromJSON, snapshotToJSON } from "../../src/snapshot.js";
import { TestMachine } from "../test-machine.js";

const Mode7ScreenStart = 0x7c00;
const Mode7ScreenEnd = 0x8000;

function screenText(machine) {
    let text = "";
    for (let addr = Mode7ScreenStart; addr < Mode7ScreenEnd; addr++) {
        const c = machine.readbyte(addr);
        text += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
    }
    return text;
}

describe("save state round trip", { timeout: 60000 }, () => {
    it("continues identically in a fresh machine restored through the gzipped file format", async () => {
        const original = new TestMachine();
        await original.initialise();
        await original.runUntilInput();
        await original.type('PRINT "SNAPSHOT"');
        await original.runUntilInput();
        expect(screenText(original)).toContain("SNAPSHOT");

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

        expect(screenText(restored)).toContain("SNAPSHOT");
        expect(restored.processor.pc).toBe(original.processor.pc);

        const cycles = 4 * 1000 * 1000;
        await original.runFor(cycles);
        await restored.runFor(cycles);

        for (const reg of ["pc", "a", "x", "y", "s"]) expect(restored.processor[reg]).toBe(original.processor[reg]);
        expect(screenText(restored)).toBe(screenText(original));
        expect(screenText(restored)).toContain("SNAPSHOT");
    });
});
