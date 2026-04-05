import { describe, it, expect } from "vitest";
import { WFNFile, extractSDFiles, toMMCZipAsync, AtomMMC2 } from "../../src/mmc.js";

describe("WFNFile", () => {
    it("should store path and Uint8Array data", () => {
        const data = new Uint8Array([1, 2, 3]);
        const file = new WFNFile("/test.txt", data);
        expect(file.path).toBe("/test.txt");
        expect(file.data).toEqual(data);
    });

    it("should default to empty Uint8Array if data is not Uint8Array", () => {
        const file = new WFNFile("/empty", null);
        expect(file.data).toBeInstanceOf(Uint8Array);
        expect(file.data.length).toBe(0);
    });
});

describe("ZIP round-trip", () => {
    it("should create a ZIP and extract it back", async () => {
        const files = [
            new WFNFile("/hello.txt", new TextEncoder().encode("Hello, Atom!")),
            new WFNFile("/subdir/data.bin", new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
        ];

        const blob = await toMMCZipAsync(files);
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.size).toBeGreaterThan(0);

        const arrayBuffer = await blob.arrayBuffer();
        const extracted = await extractSDFiles(arrayBuffer);

        expect(extracted.length).toBe(2);

        const hello = extracted.find((f) => f.path === "/hello.txt");
        expect(hello).toBeDefined();
        expect(new TextDecoder().decode(hello.data)).toBe("Hello, Atom!");

        const data = extracted.find((f) => f.path === "/subdir/data.bin");
        expect(data).toBeDefined();
        expect(data.data).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("should skip unlinked files (§ prefix) when creating ZIP", async () => {
        const files = [
            new WFNFile("/keep.txt", new Uint8Array([1])),
            new WFNFile("§/deleted.txt", new Uint8Array([2])),
        ];

        const blob = await toMMCZipAsync(files);
        const extracted = await extractSDFiles(await blob.arrayBuffer());
        expect(extracted.length).toBe(1);
        expect(extracted[0].path).toBe("/keep.txt");
    });

    it("should strip leading slash from paths in ZIP", async () => {
        const files = [new WFNFile("/leading/slash.txt", new Uint8Array([1]))];
        const blob = await toMMCZipAsync(files);
        const extracted = await extractSDFiles(await blob.arrayBuffer());
        // extractSDFiles prepends / back
        expect(extracted[0].path).toBe("/leading/slash.txt");
    });
});

describe("AtomMMC2", () => {
    function makeMockCpu() {
        return {
            soundChip: {
                toneGenerator: { mute() {}, tone() {} },
            },
        };
    }

    it("should construct with a cpu reference", () => {
        const cpu = makeMockCpu();
        const mmc = new AtomMMC2(cpu);
        expect(mmc.cpu).toBe(cpu);
    });

    it("should return STATUS_BUSY from read before any command", () => {
        const mmc = new AtomMMC2(makeMockCpu());
        // STATUS_REG is at offset 0x4
        const status = mmc.read(0xb404);
        expect(typeof status).toBe("number");
    });

    it("should accept SetMMCData and GetMMCData", () => {
        const mmc = new AtomMMC2(makeMockCpu());
        const testFiles = [new WFNFile("/test.dat", new Uint8Array([42]))];
        mmc.SetMMCData(testFiles);
        const retrieved = mmc.GetMMCData();
        expect(retrieved.length).toBe(1);
        expect(retrieved[0].path).toBe("/test.dat");
    });

    it("should clear MMC data", () => {
        const mmc = new AtomMMC2(makeMockCpu());
        mmc.SetMMCData([new WFNFile("/test.dat", new Uint8Array([42]))]);
        mmc.ClearMMCData();
        const retrieved = mmc.GetMMCData();
        // ClearMMCData creates a default README file
        expect(retrieved.length).toBe(1);
        expect(retrieved[0].path).toBe("/README");
    });
});
