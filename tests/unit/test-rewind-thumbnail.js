// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
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
    it("runs past breakpoints and watches to a whole frame, kept from being cleared, leaving them stopping real runs", async () => {
        const { cpu, history, snapshots } = await historyRunning();
        // Turned off by a flag, not remove(), which would rebuild the look tables and hide a preview that failed to.
        let breaking = true;
        cpu.debugInstruction.add(() => breaking);
        cpu.debugWrite.add(() => true);
        const clear = vi.spyOn(cpu.video, "clearPaintBuffer");
        cpu.restoreState(snapshots[0]);
        const startFrame = cpu.video.frameCount;

        previewFrame(history, snapshots[0]);

        expect(cpu.video.frameCount).toBe(startFrame + 2);
        expect(cpu.video.clearPaintBuffer).toBe(clear);
        expect(clear).not.toHaveBeenCalled();
        expect(cpu.execute(1000)).toBe(false);
        breaking = false;
        expect(cpu.execute(1000)).toBe(false);
    });

    it("goes no further than a tenth of a second when the display never ends", async () => {
        const { cpu, history } = await historyRunning();
        // R6, the rows displayed, past R4, the rows in a frame.
        cpu.video.crtc.write(0, 6);
        cpu.video.crtc.write(1, 0x7f);
        const snapshot = cpu.snapshotState();
        const startFrame = cpu.video.frameCount;

        previewFrame(history, snapshot);

        expect(cpu.video.frameCount).toBe(startFrame);
        const ran = cycleCount(cpu) - snapshotCycle(cpu, snapshot);
        expect(ran).toBeGreaterThanOrEqual(cpu.model.cyclesPerSecond / 10);
        expect(ran).toBeLessThan(cpu.model.cyclesPerSecond / 10 + LongestInstructionCycles);
    });
});
