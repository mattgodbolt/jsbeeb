// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Display } from "../../src/web/display.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const FbWidth = 1024;

describe("Display", () => {
    let rafCallbacks;
    let fakeCanvas;

    beforeEach(() => {
        domFromIndexHtml("cub-monitor");
        rafCallbacks = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => rafCallbacks.push(callback));
    });

    afterEach(teardownDom);

    const make = (options = {}) => {
        const screenCanvas = document.getElementById("screen");
        const display = new Display({
            screenCanvas,
            model: { isMaster: false, isAtom: false },
            mode: "rgb",
            makeCanvas: (canvasEl, filterClass) => {
                fakeCanvas = { fb32: new Uint32Array(FbWidth * 625), paint: vi.fn(), filterClass };
                return fakeCanvas;
            },
            ...options,
        });
        // The video chip paints once as it is built; the tests care about what
        // happens after that.
        rafCallbacks.splice(0);
        display.presentScheduled = false;
        display.frames = 0;
        fakeCanvas?.paint.mockClear();
        return display;
    };

    const paintedFrom = () => ({ lineGrid: new Uint8Array(4), lineBaseEven: 1, lineBaseOdd: 2 });
    const presentAll = () => {
        for (const callback of rafCallbacks.splice(0)) callback();
    };

    it("sizes the canvas element for the mode before the context exists", () => {
        const display = make();
        const config = display.filterClass.getDisplayConfig();
        expect(document.getElementById("screen").width).toBe(config.canvasWidth);
        expect(document.getElementById("screen").height).toBe(config.canvasHeight);
    });

    it("dresses the monitor for the filter in use", () => {
        const display = make();
        const config = display.filterClass.getDisplayConfig();
        expect(document.getElementById("cub-monitor-pic").src).toContain(config.image);
    });

    it("coalesces paints into one present per animation frame", () => {
        const display = make();
        display.videoFb32.fill(7);
        display.onPaint(paintedFrom(), 0, 10, FbWidth, 20);
        display.onPaint(paintedFrom(), 0, 30, FbWidth, 40);
        expect(fakeCanvas.paint).not.toHaveBeenCalled();
        expect(rafCallbacks).toHaveLength(1);
        presentAll();
        expect(fakeCanvas.paint).toHaveBeenCalledTimes(1);
        // The last frame's bounds win, and the pixels were copied over.
        expect(fakeCanvas.paint).toHaveBeenCalledWith(0, 30, FbWidth, 40, display.pendingFrame);
        expect(fakeCanvas.fb32[30 * FbWidth]).toBe(7);
    });

    it("schedules another present once the first has run", () => {
        const display = make();
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        presentAll();
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        expect(rafCallbacks).toHaveLength(1);
        presentAll();
        expect(fakeCanvas.paint).toHaveBeenCalledTimes(2);
    });

    it("skips paints when told to, on a cycle of frameSkip frames", () => {
        const display = make({ frameSkip: 3 });
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        expect(rafCallbacks).toHaveLength(0);
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        expect(rafCallbacks).toHaveLength(1);
    });

    describe("running fast", () => {
        it("moves the skip into the video chip and back out again", () => {
            const display = make();
            display.setSpeedy(true);
            expect(display.video.frameSkipCount).toBe(9);
            display.setSpeedy(false);
            expect(display.video.frameSkipCount).toBe(0);
        });

        it("keeps a deeper configured frameSkip, rounded up to alternate interlace fields", () => {
            const display = make({ frameSkip: 100 });
            display.setSpeedy(true);
            expect(display.video.frameSkipCount).toBe(101);
        });

        it("presents every frame the chip paints rather than skipping twice", () => {
            const display = make({ frameSkip: 3 });
            display.setSpeedy(true);
            display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
            expect(rafCallbacks).toHaveLength(1);
        });
    });

    it("carries the interlace bases and line grid to the presenter", () => {
        const display = make();
        const from = { lineGrid: new Uint8Array([1, 2, 3]), lineBaseEven: 5, lineBaseOdd: 6 };
        display.onPaint(from, 0, 0, FbWidth, 8);
        expect(display.pendingFrame.lineBaseEven).toBe(5);
        expect(display.pendingFrame.lineBaseOdd).toBe(6);
        expect([...display.pendingFrame.lineGrid]).toEqual([1, 2, 3]);
    });

    it("hands over the timing counters and starts them afresh", () => {
        const display = make();
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        presentAll();
        expect(display.takePaintMs()).toBeGreaterThanOrEqual(0);
        expect(display.takePaintMs()).toBe(0);
        expect(display.takePresentMs()).toBeGreaterThanOrEqual(0);
        expect(display.takePresentMs()).toBe(0);
    });

    it("says when the filter asked for is not what was built", () => {
        make({
            makeCanvas: (canvasEl, filterClass) => {
                fakeCanvas = {
                    fb32: new Uint32Array(FbWidth * 625),
                    paint: vi.fn(),
                    filterClass: class Other {
                        static getDisplayConfig() {
                            return filterClass.getDisplayConfig();
                        }
                    },
                    fallbackReason: "no WebGL",
                };
                return fakeCanvas;
            },
        });
        const toastText = document.querySelector(".toast")?.textContent ?? "";
        expect(toastText).toContain("no WebGL");
    });

    it("uses a fake video chip when asked", () => {
        const display = make({ fakeVideo: true });
        expect(typeof display.video.polltime).toBe("function");
    });
});
