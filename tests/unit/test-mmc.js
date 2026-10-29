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

const CmdReg = 0xb400;

function command(mmc, cmd) {
    mmc.write(CmdReg, cmd);
    return mmc.read(CmdReg);
}

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

    it("should return MCU_BUSY status from STATUS_REG initially", () => {
        const mmc = new AtomMMC2(makeMockCpu());
        // STATUS_REG is at offset 0x4, MMC_MCU_BUSY = 0x01
        const status = mmc.read(0xb404);
        expect(status & 0x01).toBe(0x01);
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

    const pad = (...pressed) => ({
        gamepadButtons: Array.from({ length: 16 }, (_, button) => pressed.includes(button)),
    });

    it.each([
        ["no pad", null, 0xff],
        ["a pad not yet seen", {}, 0xff],
        ["nothing pressed", pad(), 0xff],
        ["up", pad(12), 0xf7],
        ["down", pad(13), 0xfb],
        ["left", pad(14), 0xfd],
        ["right", pad(15), 0xfe],
        ["fire", pad(0), 0xef],
        ["up and fire", pad(12, 0), 0xe7],
    ])("reads the joystick port, active low, with %s", (_, gamepad, expected) => {
        const CmdReadPort = 0xa2;
        const mmc = new AtomMMC2(makeMockCpu());
        mmc.attachGamepad(gamepad);
        expect(command(mmc, CmdReadPort)).toBe(expected);
    });
});

describe("AtomMMC2 file handles", () => {
    const LatchReg = 0xb401;
    const ReadDataReg = 0xb402;
    const WriteDataReg = 0xb403;
    const CmdFileClose = 0x10;
    const CmdFileOpenRead = 0x11;
    const CmdFileOpenWrite = 0x13;
    const CmdFileSeek = 0x16;
    const CmdInitRead = 0x20;
    const CmdInitWrite = 0x21;
    const CmdReadBytes = 0x22;
    const CmdWriteBytes = 0x23;
    const StatusComplete = 0x40;
    const StatusEof = 0x60;
    const FileNumOffset = 0x20;
    const ErrorTooManyOpen = 0x12;
    const FrInvalidObject = 9;
    const FrNoFile = 4;
    const GrowLimit = 16 * 1024 * 1024;
    const ScratchHandle = 0;
    const AnyFreeHandle = 1;

    const fileCommand = (cmd, handle) => cmd | (handle << 5);
    const dataCommand = (cmd, handle) => cmd | (handle << 2);

    function makeMmc(files) {
        const mmc = new AtomMMC2({});
        mmc.SetMMCData(files);
        return mmc;
    }

    function sendBytes(mmc, bytes) {
        command(mmc, CmdInitWrite);
        for (const b of bytes) mmc.write(WriteDataReg, b);
    }

    function receiveBytes(mmc, count) {
        mmc.write(CmdReg, CmdInitRead);
        return Array.from({ length: count }, () => mmc.read(ReadDataReg));
    }

    function open(mmc, name, cmd = CmdFileOpenRead) {
        sendBytes(mmc, [...new TextEncoder().encode(name), 0]);
        const status = command(mmc, fileCommand(cmd, AnyFreeHandle));
        return status & FileNumOffset ? status & 3 : -status;
    }

    function readBytes(mmc, handle, count) {
        mmc.write(LatchReg, count);
        const status = command(mmc, dataCommand(CmdReadBytes, handle));
        return { status, bytes: receiveBytes(mmc, count) };
    }

    function writeBytes(mmc, handle, bytes) {
        sendBytes(mmc, bytes);
        mmc.write(LatchReg, bytes.length);
        return command(mmc, dataCommand(CmdWriteBytes, handle));
    }

    function seek(mmc, handle, pos) {
        sendBytes(mmc, [pos & 0xff, (pos >> 8) & 0xff, (pos >> 16) & 0xff, (pos >> 24) & 0xff]);
        return command(mmc, fileCommand(CmdFileSeek, handle));
    }

    const close = (mmc, handle) => command(mmc, fileCommand(CmdFileClose, handle));

    it("keeps a separate position for each open handle", () => {
        const mmc = makeMmc([
            new WFNFile("/A", new Uint8Array([1, 2, 3, 4])),
            new WFNFile("/B", new Uint8Array([11, 12, 13, 14])),
        ]);
        const a = open(mmc, "A");
        const b = open(mmc, "B");
        expect(a).toBe(1);
        expect(b).toBe(2);
        expect(readBytes(mmc, a, 2).bytes).toEqual([1, 2]);
        expect(readBytes(mmc, b, 1).bytes).toEqual([11]);
        expect(readBytes(mmc, a, 2).bytes).toEqual([3, 4]);
        expect(readBytes(mmc, b, 3).bytes).toEqual([12, 13, 14]);
    });

    it("restarts the scratch handle at the beginning each time it is opened", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2, 3]))]);
        sendBytes(mmc, [...new TextEncoder().encode("A"), 0]);
        expect(command(mmc, fileCommand(CmdFileOpenRead, ScratchHandle))).toBe(StatusComplete);
        expect(readBytes(mmc, ScratchHandle, 2).bytes).toEqual([1, 2]);
        sendBytes(mmc, [...new TextEncoder().encode("A"), 0]);
        command(mmc, fileCommand(CmdFileOpenRead, ScratchHandle));
        expect(readBytes(mmc, ScratchHandle, 2).bytes).toEqual([1, 2]);
    });

    it("reports EOF on a short read from the current position", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2, 3]))]);
        const a = open(mmc, "A");
        expect(readBytes(mmc, a, 2).status).toBe(StatusComplete);
        const tail = readBytes(mmc, a, 2);
        expect(tail.status).toBe(StatusEof);
        expect(tail.bytes[0]).toBe(3);
    });

    it("writes each handle at its own position", () => {
        const mmc = makeMmc([]);
        const a = open(mmc, "A", CmdFileOpenWrite);
        const b = open(mmc, "B", CmdFileOpenWrite);
        expect(writeBytes(mmc, a, [1, 2])).toBe(StatusComplete);
        expect(writeBytes(mmc, b, [9])).toBe(StatusComplete);
        expect(writeBytes(mmc, a, [3])).toBe(StatusComplete);
        const files = mmc.GetMMCData();
        expect(files.find((f) => f.path === "/A").data).toEqual(new Uint8Array([1, 2, 3]));
        expect(files.find((f) => f.path === "/B").data).toEqual(new Uint8Array([9]));
    });

    it("seeks a handle without moving the others", () => {
        const mmc = makeMmc([
            new WFNFile("/A", new Uint8Array([1, 2, 3, 4])),
            new WFNFile("/B", new Uint8Array([11, 12, 13, 14])),
        ]);
        const a = open(mmc, "A");
        const b = open(mmc, "B");
        readBytes(mmc, b, 1);
        expect(seek(mmc, a, 2)).toBe(StatusComplete);
        expect(readBytes(mmc, a, 1).bytes).toEqual([3]);
        expect(seek(mmc, a, 0)).toBe(StatusComplete);
        expect(readBytes(mmc, a, 1).bytes).toEqual([1]);
        expect(readBytes(mmc, b, 1).bytes).toEqual([12]);
    });

    it("frees the slot on close so opens can cycle past the slot count", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2]))]);
        for (let i = 0; i < 10; ++i) {
            const handle = open(mmc, "A");
            expect(handle).toBeGreaterThan(0);
            expect(readBytes(mmc, handle, 1).bytes).toEqual([1]);
            expect(close(mmc, handle)).toBe(StatusComplete);
        }
    });

    it("refuses a fourth open while three handles are in use", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1]))]);
        expect([open(mmc, "A"), open(mmc, "A"), open(mmc, "A")]).toEqual([1, 2, 3]);
        expect(open(mmc, "A")).toBe(-(StatusComplete | ErrorTooManyOpen));
        close(mmc, 2);
        expect(open(mmc, "A")).toBe(2);
    });

    it("rejects reads, writes, seeks and closes on a handle that is not open", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1]))]);
        const a = open(mmc, "A");
        close(mmc, a);
        expect(readBytes(mmc, a, 1).status).toBe(StatusComplete | FrInvalidObject);
        expect(writeBytes(mmc, a, [1])).toBe(StatusComplete | FrInvalidObject);
        expect(seek(mmc, a, 0)).toBe(StatusComplete | FrInvalidObject);
        expect(close(mmc, a)).toBe(StatusComplete | FrInvalidObject);
    });

    it("overwrites the middle of a file at a seeked position", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2, 3, 4, 5]))]);
        const a = open(mmc, "A");
        seek(mmc, a, 1);
        expect(writeBytes(mmc, a, [8, 9])).toBe(StatusComplete);
        expect(readBytes(mmc, a, 2).bytes).toEqual([4, 5]);
        expect(mmc.GetMMCData()[0].data).toEqual(new Uint8Array([1, 8, 9, 4, 5]));
    });

    it("stops a write growing a file past the limit, as a full card does", () => {
        const mmc = makeMmc([]);
        const a = open(mmc, "A", CmdFileOpenWrite);
        expect(seek(mmc, a, 0xffffffff)).toBe(StatusComplete);
        expect(writeBytes(mmc, a, [1])).toBe(StatusComplete);
        expect(mmc.GetMMCData()[0].data.length).toBe(GrowLimit);
    });

    it("seeks to the start when the buffer holds only an empty read", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2, 3]))]);
        const a = open(mmc, "A");
        readBytes(mmc, a, 3);
        expect(readBytes(mmc, a, 1).status).toBe(StatusEof);
        expect(command(mmc, fileCommand(CmdFileSeek, a))).toBe(StatusComplete);
        expect(readBytes(mmc, a, 1).bytes).toEqual([1]);
    });

    it("answers a failed random-access open with the open's error", () => {
        const mmc = makeMmc([]);
        expect(open(mmc, "MISSING")).toBe(-(StatusComplete | FrNoFile));
    });

    it("closes every handle on a hard reset", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1]))]);
        const handles = [open(mmc, "A"), open(mmc, "A"), open(mmc, "A")];
        mmc.reset(true);
        expect(readBytes(mmc, handles[0], 1).status).toBe(StatusComplete | FrInvalidObject);
        expect([open(mmc, "A"), open(mmc, "A"), open(mmc, "A")]).toEqual([1, 2, 3]);
    });

    it("reads, seeks and writes anywhere in a file already over the limit", () => {
        const size = GrowLimit + 8;
        const contents = new Uint8Array(size);
        contents[size - 1] = 7;
        const mmc = makeMmc([new WFNFile("/BIG", contents)]);
        const a = open(mmc, "BIG", CmdFileOpenRead);
        expect(seek(mmc, a, GrowLimit)).toBe(StatusComplete);
        expect(readBytes(mmc, a, 8).bytes[7]).toBe(7);
        expect(writeBytes(mmc, a, [1])).toBe(StatusComplete);
        expect(seek(mmc, a, size - 2)).toBe(StatusComplete);
        expect(writeBytes(mmc, a, [5])).toBe(StatusComplete);
        const data = mmc.GetMMCData()[0].data;
        expect(data.length).toBe(size);
        expect(data[size - 2]).toBe(5);
        expect(seek(mmc, a, 0xffffffff)).toBe(StatusComplete);
        expect(writeBytes(mmc, a, [1])).toBe(StatusComplete);
        expect(mmc.GetMMCData()[0].data.length).toBe(size);
    });

    it("keeps open handles across a soft reset", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1, 2]))]);
        const a = open(mmc, "A");
        readBytes(mmc, a, 1);
        mmc.reset(false);
        expect(readBytes(mmc, a, 1).bytes).toEqual([2]);
    });

    it("closes the scratch handle when opening it fails", () => {
        const mmc = makeMmc([new WFNFile("/A", new Uint8Array([1]))]);
        sendBytes(mmc, [...new TextEncoder().encode("A"), 0]);
        command(mmc, fileCommand(CmdFileOpenRead, ScratchHandle));
        sendBytes(mmc, [...new TextEncoder().encode("MISSING"), 0]);
        expect(command(mmc, fileCommand(CmdFileOpenRead, ScratchHandle))).toBe(StatusComplete | FrNoFile);
        expect(readBytes(mmc, ScratchHandle, 1).status).toBe(StatusComplete | FrInvalidObject);
    });
});
