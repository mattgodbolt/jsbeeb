// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeUntilFrame, renderThumbnails } from "../../src/web/rewind-thumbnail.js";
import { fake6502 } from "../../src/fake6502.js";
import { TEST_6502 } from "../../src/models.js";
import { Video } from "../../src/video.js";

// Minimal mock canvas for node/jsdom environment
function createMockCanvas() {
    const imageData = {
        data: new Uint8Array(1024 * 625 * 4),
        get buffer() {
            return this.data.buffer;
        },
    };
    const ctx = {
        createImageData: () => imageData,
        putImageData: vi.fn(),
        drawImage: vi.fn(),
    };
    return { ctx, imageData };
}

function createMockVideo() {
    return {
        fb32: new Uint32Array(1024 * 625),
        frameCount: 0,
        clearPaintBuffer: vi.fn(),
        renderPending: vi.fn(),
    };
}

function createMockProcessor(video) {
    return {
        snapshotState: vi.fn(() => ({ saved: true })),
        restoreState: vi.fn(),
        withoutDebugHooks: (run) => run(),
        // Simulate: each execute call advances the video frameCount
        execute: vi.fn(() => {
            video.frameCount++;
        }),
    };
}

describe("renderThumbnails", () => {
    let origCreateElement;

    beforeEach(() => {
        origCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation((tag) => {
            if (tag !== "canvas") return origCreateElement(tag);
            const mock = createMockCanvas();
            return {
                width: 0,
                height: 0,
                getContext: () => mock.ctx,
            };
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should return empty array for empty snapshots", () => {
        const result = renderThumbnails({}, [], {}, 50);
        expect(result).toEqual([]);
    });

    it("should generate one thumbnail per snapshot", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);
        const snapshots = [{ id: 1 }, { id: 2 }, { id: 3 }];

        const results = renderThumbnails(processor, snapshots, video, 50);

        expect(results).toHaveLength(3);
        expect(results[0].index).toBe(0);
        expect(results[1].index).toBe(1);
        expect(results[2].index).toBe(2);
    });

    it("should calculate age in seconds from newest", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);
        const snapshots = [{ id: 1 }, { id: 2 }, { id: 3 }];

        const results = renderThumbnails(processor, snapshots, video, 50);

        // Oldest (index 0) is 2 steps from newest: 2 * 50 / 50 = 2s
        expect(results[0].ageSeconds).toBe(2);
        expect(results[1].ageSeconds).toBe(1);
        expect(results[2].ageSeconds).toBe(0); // newest
    });

    it("should restore original state after rendering", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);

        renderThumbnails(processor, [{ id: 1 }], video, 50);

        const calls = processor.restoreState.mock.calls;
        expect(calls[calls.length - 1][0]).toEqual({ saved: true });
    });

    it("should restore original state even if rendering throws", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);
        processor.execute = vi.fn(() => {
            throw new Error("boom");
        });

        expect(() => renderThumbnails(processor, [{ id: 1 }], video, 50)).toThrow("boom");

        const calls = processor.restoreState.mock.calls;
        expect(calls[calls.length - 1][0]).toEqual({ saved: true });
    });

    it("should draw the pending cells once a snapshot has run, before the next restore", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);

        renderThumbnails(processor, [{ id: 1 }], video, 50);

        expect(video.renderPending).toHaveBeenCalledTimes(1);
        const [drawnAt] = video.renderPending.mock.invocationCallOrder;
        expect(drawnAt).toBeGreaterThan(Math.max(...processor.execute.mock.invocationCallOrder));
        expect(drawnAt).toBeLessThan(Math.max(...processor.restoreState.mock.invocationCallOrder));
    });

    it("should restore each snapshot and execute until frame advances", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);
        const snapshots = [{ id: 1 }, { id: 2 }];

        renderThumbnails(processor, snapshots, video, 50);

        // restoreState: once per snapshot + once to restore original = 3
        expect(processor.restoreState).toHaveBeenCalledTimes(3);
        expect(processor.restoreState).toHaveBeenCalledWith(snapshots[0]);
        expect(processor.restoreState).toHaveBeenCalledWith(snapshots[1]);
        // execute called at least once per snapshot (runs in chunks until frameCount advances)
        expect(processor.execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should suppress clearPaintBuffer during rendering", () => {
        const video = createMockVideo();
        const processor = createMockProcessor(video);
        const origClear = video.clearPaintBuffer;

        renderThumbnails(processor, [{ id: 1 }], video, 50);

        // clearPaintBuffer should be restored after rendering
        expect(video.clearPaintBuffer).toBe(origClear);
        // The original clearPaintBuffer should NOT have been called
        // (it was temporarily replaced with a no-op)
        expect(origClear).not.toHaveBeenCalled();
    });
});

describe("executeUntilFrame", () => {
    it("runs past breakpoints and watches to a whole frame, leaving them stopping real runs", async () => {
        const video = new Video(false, 1024 * 625, () => {});
        const processor = fake6502(TEST_6502, { video });
        await processor.initialise();
        const ModeSevenCrtc = [63, 40, 51, 0x24, 30, 2, 25, 27, 0x93, 18];
        ModeSevenCrtc.forEach((value, reg) => {
            video.crtc.write(0, reg);
            video.crtc.write(1, value);
        });
        const StoreThenLoop = [0x8d, 0x00, 0x30, 0x4c, 0x00, 0x20];
        processor.ramRomOs.set(StoreThenLoop, 0x2000);
        processor.pc = 0x2000;
        // Turned off by a flag, not remove(), which would rebuild the look tables and hide a preview that failed to.
        let breaking = true;
        processor.debugInstruction.add(() => breaking);
        processor.debugWrite.add(() => true);
        const startFrame = video.frameCount;

        executeUntilFrame(processor, video);

        expect(video.frameCount).toBe(startFrame + 2);
        expect(processor.execute(1000)).toBe(false);
        breaking = false;
        expect(processor.execute(1000)).toBe(false);
    });
});
