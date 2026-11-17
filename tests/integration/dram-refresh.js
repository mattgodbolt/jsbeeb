import { describe, expect, it } from "vitest";
import { DecayedByte, DramRetentionSeconds } from "../../src/dram-refresh.js";
import { Video } from "../../src/video.js";
import { TestMachine } from "../../src/test-machine.js";
import { FbHeight, FbWidth } from "../helpers/frame-capturing-video.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { bootedTestMachine } from "./helpers.js";

const CodeBase = 0x0e80;
const PatternBase = 0x1000;
const Pattern = 0x5a;
const SettleCycles = 200000;
// Part way through the MOS's start-up, before it programs the CRTC, so the rows are only partly refreshed.
const StartUpCycles = 300000;
const ModelBRows = 128;
const MasterRows = 256;
const LdaImmediate = 0xa9;
const StaAbsolute = 0x8d;
const JmpAbsolute = 0x4c;
const Sei = 0x78;
const CrtcAddress = 0xfe00;
const CrtcData = 0xfe01;

/** SEI, the CRTC writes, then a JMP to itself: the loop's three bytes are the only rows the CPU goes on touching. */
function program(crtcWrites) {
    const lo = (address) => address & 0xff;
    const hi = (address) => address >>> 8;
    const code = [Sei];
    for (const [register, value] of crtcWrites) {
        code.push(LdaImmediate, register, StaAbsolute, lo(CrtcAddress), hi(CrtcAddress));
        code.push(LdaImmediate, value, StaAbsolute, lo(CrtcData), hi(CrtcData));
    }
    const loop = CodeBase + code.length;
    code.push(JmpAbsolute, lo(loop), hi(loop));
    return { code, loopRows: [loop, loop + 1, loop + 2] };
}

describe("DRAM rows nothing refreshes", () => {
    it.each([
        { model: "B-DFS1.2", mode: 0, crtcWrites: [], videoRefreshes: () => true },
        { model: "Master", mode: 7, crtcWrites: [], videoRefreshes: () => true },
        // R9 = 0 holds RA at 0, so a bitmap line refreshes only rows whose RA bits are 0.
        { model: "B-DFS1.2", mode: 0, crtcWrites: [[9, 0]], videoRefreshes: (row) => (row & 7) === 0 },
        { model: "Master", mode: 0, crtcWrites: [[9, 0]], videoRefreshes: (row) => (row & 7) === 0 },
        // #1849's one-row MA13 frames: every line fetches &7C00-&7C7F, so rows &80-&FF go unrefreshed.
        {
            model: "Master",
            mode: 1,
            crtcWrites: [
                [4, 0],
                [5, 0],
                [9, 0],
                [12, 0x20],
                [13, 0],
            ],
            videoRefreshes: (row) => row < 0x80,
        },
    ])("$model MODE $mode with CRTC writes $crtcWrites", async ({ model, mode, crtcWrites, videoRefreshes }) => {
        const isMaster = model === "Master";
        const rows = isMaster ? MasterRows : ModelBRows;
        const video = new Video(isMaster, FbWidth * FbHeight, () => {});
        const machine = await bootedTestMachine(model, { video });
        await machine.type(`MODE ${mode}`);
        await machine.runUntilInput();

        const { code, loopRows } = program(crtcWrites);
        code.forEach((byte, offset) => machine.writebyte(CodeBase + offset, byte));
        await machine.type(`CALL &${CodeBase.toString(16).toUpperCase()}`);
        await machine.runFor(SettleCycles);
        for (let row = 0; row < rows; ++row) machine.writebyte(PatternBase + row, Pattern);
        const readBack = () => Array.from({ length: rows }, (_, row) => machine.readbyte(PatternBase + row));
        await machine.runFor((DramRetentionSeconds - 1) * machine.model.cyclesPerSecond);
        expect(readBack()).toEqual(Array(rows).fill(Pattern));
        await machine.runFor(2 * machine.model.cyclesPerSecond);

        const cpuRows = new Set(loopRows.map((address) => address & (rows - 1)));
        const expected = Array.from({ length: rows }, (_, row) =>
            videoRefreshes(row) || cpuRows.has(row) ? Pattern : DecayedByte,
        );
        expect(readBack()).toEqual(expected);
    });

    it("counts as refreshed exactly the rows a 2 MHz MA13 line fetches", async () => {
        const video = new Video(false, FbWidth * FbHeight, () => {});
        const machine = await bootedTestMachine("B-DFS1.2", { video });
        await machine.type("MODE 0");
        await machine.runUntilInput();
        // One-line frames of 64 characters from MA &2000, so each MA lands on the same 2 MHz phase every line.
        const { code } = program([
            [0, 63],
            [2, 50],
            [4, 0],
            [5, 0],
            [9, 0],
            [12, 0x20],
            [13, 0],
        ]);
        code.forEach((byte, offset) => machine.writebyte(CodeBase + offset, byte));
        await machine.type(`CALL &${CodeBase.toString(16).toUpperCase()}`);
        await machine.runFor(SettleCycles);

        const cpu = machine.processor;
        const dram = cpu.dramRefresh;
        const fetched = new Set();
        const refreshed = new Set();
        const videoRead = cpu.videoRead.bind(cpu);
        cpu.videoRead = (address) => {
            fetched.add(address & (ModelBRows - 1));
            return videoRead(address);
        };
        const endOfField = dram.endOfField.bind(dram);
        dram.endOfField = () => {
            for (let row = 0; row < ModelBRows; ++row)
                if ((dram.videoRows[row >>> 5] >>> (row & 31)) & 1) refreshed.add(row);
            endOfField();
        };
        await machine.runFor(SettleCycles);

        const sorted = (rows) => [...rows].sort((a, b) => a - b);
        expect(fetched.size).toBe(ModelBRows / 2);
        expect(sorted(refreshed)).toEqual(sorted(fetched));
    });

    const startedMaster = async () => {
        const machine = new TestMachine("Master", { video: new Video(true, FbWidth * FbHeight, () => {}) });
        await machine.initialise();
        return machine.processor;
    };

    it("snapshots and restores which rows were refreshed when", async () => {
        await expectSnapshotRoundTrips(
            async () => (await startedMaster()).dramRefresh,
            (dram) => dram.cpu.execute(StartUpCycles),
        );
    });

    it("takes every row as just refreshed when a snapshot predates DRAM refresh", async () => {
        const cpu = await startedMaster();
        cpu.execute(StartUpCycles);
        const { dram: _dram, ...olderState } = cpu.snapshotState();
        const restored = await startedMaster();
        restored.restoreState(olderState);
        const epoch = restored.scheduler.epoch;
        expect(restored.dramRefresh.lastRefreshedAt.every((at) => at === epoch)).toBe(true);
        expect(restored.dramRefresh.lastCoveredAt).toBe(epoch);
        expect(restored.tracksDramRows).toBe(false);
    });
});
