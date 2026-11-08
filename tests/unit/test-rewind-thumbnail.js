// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewFrame, renderThumbnails } from "../../src/web/rewind-thumbnail.js";
import { ReplayHistory } from "../../src/replay.js";
import { TEST_6502 } from "../../src/models.js";
import { loadBytes, machineShowingFrames } from "./helpers.js";

const ProgramAt = 0x2000;
// STA &3000; JMP &2000
const StoreThenLoop = [0x8d, 0x00, 0x30, 0x4c, 0x00, 0x20];
const FrameCycles = 40000;

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
    it("runs past breakpoints and watches to a whole frame, leaving them stopping real runs", async () => {
        const { cpu, history, snapshots } = await historyRunning();
        // Turned off by a flag, not remove(), which would rebuild the look tables and hide a preview that failed to.
        let breaking = true;
        cpu.debugInstruction.add(() => breaking);
        cpu.debugWrite.add(() => true);
        const clear = cpu.video.clearPaintBuffer;
        cpu.restoreState(snapshots[0]);
        const startFrame = cpu.video.frameCount;

        previewFrame(history, snapshots[0]);

        expect(cpu.video.frameCount).toBe(startFrame + 2);
        expect(cpu.video.clearPaintBuffer).toBe(clear);
        expect(cpu.execute(1000)).toBe(false);
        breaking = false;
        expect(cpu.execute(1000)).toBe(false);
    });
});

describe("renderThumbnails", () => {
    beforeEach(() => {
        const context = { createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }), putImageData() {} };
        const realCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation((tag) => {
            const element = realCreateElement(tag);
            if (tag === "canvas") element.getContext = () => ({ ...context, drawImage() {} });
            return element;
        });
    });

    afterEach(() => vi.restoreAllMocks());

    it("gives each snapshot a thumbnail, aged from the newest", async () => {
        const { history, snapshots } = await historyRunning();
        const thumbnails = renderThumbnails(history, snapshots, 50);

        expect(thumbnails.map(({ index, ageSeconds }) => [index, ageSeconds])).toEqual([
            [0, 2],
            [1, 1],
            [2, 0],
        ]);
    });
});
