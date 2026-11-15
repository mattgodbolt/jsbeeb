// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewFrame } from "../../src/web/rewind-thumbnail.js";
import { ReplayHistory, snapshotCycle } from "../../src/replay.js";
import { cycleCount } from "../../src/lockstep.js";
import { TEST_6502 } from "../../src/models.js";
import { loadBytes, machineShowingFrames } from "./helpers.js";

const ProgramAt = 0x2000;
// STA &3000; JMP &2000
const StoreThenLoop = [0x8d, 0x00, 0x30, 0x4c, 0x00, 0x20];
const FrameCycles = 40000;
const LongestInstructionCycles = 8;
const ScreenFrom = 0x3000;
const ScreenTo = 0x8000;
const ScreenFill = 0x55;

async function historyRunning() {
    const cpu = await machineShowingFrames(TEST_6502);
    loadBytes(cpu, ProgramAt, StoreThenLoop);
    cpu.pc = ProgramAt;
    const history = new ReplayHistory(cpu);
    const snapshots = [];
    for (let i = 0; i < 3; i++) {
        cpu.execute(FrameCycles);
        snapshots.push(cpu.snapshotState());
        history.taken(snapshots.at(-1), null);
    }
    return { cpu, history, snapshots };
}

describe("previewFrame", () => {
    afterEach(() => vi.restoreAllMocks());

    it("runs past breakpoints and watches to the second flyback, leaving them stopping real runs", async () => {
        const { cpu, history, snapshots } = await historyRunning();
        // Turned off by a flag, not remove(), which would rebuild the look tables and hide a preview that failed to.
        let breaking = true;
        cpu.debugInstruction.add(() => breaking);
        cpu.debugWrite.add(() => true);
        const clear = cpu.video.clearPaintBuffer;
        cpu.restoreState(snapshots[0]);
        const startField = cpu.video.fieldCount;

        previewFrame(history, snapshots[0]);

        expect(cpu.video.fieldCount).toBe(startField + 2);
        expect(cpu.video.clearPaintBuffer).toBe(clear);
        expect(cpu.execute(1000)).toBe(false);
        breaking = false;
        expect(cpu.execute(1000)).toBe(false);
    });

    it.each([
        ["a display that reaches R6", 25],
        ["R6 past R4, so the display never ends", 0x7f],
    ])("leaves the field a run paints at its second flyback for %s", async (_, r6) => {
        const { cpu, history } = await historyRunning();
        cpu.ramRomOs.fill(ScreenFill, ScreenFrom, ScreenTo);
        cpu.video.crtc.write(0, 6);
        cpu.video.crtc.write(1, r6);
        const snapshot = cpu.snapshotState();
        const { video } = cpu;
        let painted = null;
        const startField = video.fieldCount;
        vi.spyOn(video, "paint_ext").mockImplementation(() => {
            if (video.fieldCount === startField + 2) painted ??= video.fb32.slice();
        });
        for (let ran = 0; painted === null && ran < cpu.model.cyclesPerSecond; ran += FrameCycles)
            cpu.execute(FrameCycles);
        vi.restoreAllMocks();

        previewFrame(history, snapshot);
        video.renderPending();

        expect(painted.some((pixel) => pixel !== painted[0])).toBe(true);
        expect(video.fb32.findIndex((pixel, i) => pixel !== painted[i])).toBe(-1);
    });

    it("goes no further than a tenth of a second when no field ends", async () => {
        const { cpu, history, snapshots } = await historyRunning();
        vi.spyOn(cpu.video, "flyback").mockImplementation(() => {});
        const startField = cpu.video.fieldCount;

        previewFrame(history, snapshots[0]);

        expect(cpu.video.fieldCount).toBe(startField);
        const ran = cycleCount(cpu) - snapshotCycle(cpu, snapshots[0]);
        expect(ran).toBeGreaterThanOrEqual(cpu.model.cyclesPerSecond / 10);
        expect(ran).toBeLessThan(cpu.model.cyclesPerSecond / 10 + LongestInstructionCycles);
    });
});
