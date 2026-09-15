// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Display } from "../../src/web/display.js";
import { PassthroughFilter } from "../../src/video-filters/passthrough-filter.js";
import { LineGridRows } from "../../src/video-filters/pixel-grid.js";
import { domFromIndexHtml, teardownDom, toasts } from "./helpers.js";

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
                fakeCanvas = {
                    fb32: new Uint32Array(FbWidth * 625),
                    paint: vi.fn(),
                    setPersistence: vi.fn(),
                    setFilter: vi.fn((newFilterClass) => (fakeCanvas.filterClass = newFilterClass)),
                    filterClass,
                };
                return fakeCanvas;
            },
            ...options,
        });
        // The video chip paints once as it is built; the tests care about what
        // happens after that.
        for (const callback of rafCallbacks.splice(0)) callback();
        display.presentScheduled = false;
        display.frames = 0;
        fakeCanvas?.paint.mockClear();
        return display;
    };

    const paintedFrom = (frameSkipCount = 0, frameCount = 0) => ({
        frameCount,
        lineGrid: new Uint8Array(LineGridRows),
        lineBaseEven: 1,
        lineBaseOdd: 2,
        frameSkipCount,
    });
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

    it("draws only when a frame has been painted since the last present", () => {
        const display = make();
        display.present();
        expect(fakeCanvas.paint).not.toHaveBeenCalled();
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        display.present();
        display.present();
        expect(fakeCanvas.paint).toHaveBeenCalledTimes(1);
    });

    it("applies a persistence to the canvas only while the filter that declares it is in use", () => {
        const display = make({ mode: "pal" });
        fakeCanvas.setPersistence.mockClear();
        display.setPersistence("rgbPersistenceMs", 20);
        expect(fakeCanvas.setPersistence).not.toHaveBeenCalled();
        display.setPersistence("palPersistenceMs", 40);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(Math.exp(-0.5));
        display.setMode("rgb");
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(Math.exp(-1));
        display.setMode("xbr");
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(0);
    });

    it("gives a fallback display its own persistence, not the amount of the mode asked for", () => {
        const display = make({
            mode: "pal",
            makeCanvas: (canvasEl, filterClass) => {
                fakeCanvas = { fb32: new Uint32Array(FbWidth * 625), paint: vi.fn(), setPersistence: vi.fn() };
                fakeCanvas.filterClass = PassthroughFilter;
                fakeCanvas.fallbackReason = `${filterClass.getDisplayConfig().name} declined`;
                return fakeCanvas;
            },
        });
        fakeCanvas.setPersistence.mockClear();
        display.setPersistence("palPersistenceMs", 40);
        expect(fakeCanvas.setPersistence).not.toHaveBeenCalled();
        display.setPersistence("rgbPersistenceMs", 20);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(Math.exp(-1));
    });

    it("converts an afterglow with the Atom's shorter field", () => {
        const display = make({ mode: "rgb", model: { isMaster: false, isAtom: true } });
        display.setPersistence("rgbPersistenceMs", 50);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(Math.exp(-1000 / 60 / 50));
    });

    it("keeps an afterglow within what the canvas can show, and takes anything else as none", () => {
        const display = make({ mode: "pal" });
        display.setPersistence("palPersistenceMs", 5000);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(Math.exp(-20 / 500));
        display.setPersistence("palPersistenceMs", -1);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(0);
        display.setPersistence("palPersistenceMs", 0);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(0);
        display.setPersistence("palPersistenceMs", undefined);
        expect(fakeCanvas.setPersistence).toHaveBeenLastCalledWith(0);
    });

    it("copies only the rows it is told to, pixels and line grid alike, and presents the whole extent", () => {
        const display = make();
        display.videoFb32.fill(3);
        const earlier = paintedFrom();
        earlier.lineGrid = new Uint8Array(LineGridRows).fill(5);
        display.onPaint(earlier, 0, 10, FbWidth, 100);
        presentAll();
        display.videoFb32.fill(7);
        const partial = paintedFrom();
        partial.lineGrid = new Uint8Array(LineGridRows).fill(9);
        display.onPaint(partial, 0, 10, FbWidth, 100, 40);
        presentAll();
        expect(fakeCanvas.fb32[39 * FbWidth]).toBe(7);
        expect(fakeCanvas.fb32[40 * FbWidth]).toBe(3);
        expect(display.pendingFrame.lineGrid[39]).toBe(9);
        expect(display.pendingFrame.lineGrid[40]).toBe(5);
        expect(fakeCanvas.paint.mock.calls.at(-1).slice(0, 4)).toEqual([0, 10, FbWidth, 100]);
    });

    it("tells the canvas how many fields have passed since the frame it last showed", () => {
        const display = make();
        const fieldsShown = () => fakeCanvas.paint.mock.calls.at(-1)[4].fields;
        display.onPaint(paintedFrom(0, 10), 0, 0, FbWidth, 8);
        presentAll();
        display.onPaint(paintedFrom(0, 11), 0, 0, FbWidth, 8);
        presentAll();
        expect(fieldsShown()).toBe(1);
        display.onPaint(paintedFrom(0, 21), 0, 0, FbWidth, 8);
        presentAll();
        expect(fieldsShown()).toBe(10);
        display.onPaint(paintedFrom(0, 21), 0, 0, FbWidth, 8, 4);
        presentAll();
        expect(fieldsShown()).toBe(0);
        display.onPaint(paintedFrom(0, 5000), 0, 0, FbWidth, 8);
        presentAll();
        expect(fieldsShown()).toBe(50);
    });

    it("adds up the fields of paints that arrive before one animation frame", () => {
        const display = make();
        display.onPaint(paintedFrom(0, 10), 0, 0, FbWidth, 8);
        presentAll();
        display.onPaint(paintedFrom(0, 11), 0, 0, FbWidth, 8);
        display.onPaint(paintedFrom(0, 12), 0, 0, FbWidth, 8);
        presentAll();
        expect(fakeCanvas.paint.mock.calls.at(-1)[4].fields).toBe(2);
    });

    it("owes the old picture nothing after a restore that moved the frame count back", () => {
        const display = make();
        display.onPaint(paintedFrom(0, 100), 0, 0, FbWidth, 8);
        presentAll();
        display.onPaint(paintedFrom(0, 3), 0, 0, FbWidth, 8);
        presentAll();
        expect(fakeCanvas.paint.mock.calls.at(-1)[4].fields).toBe(50);
    });

    it("counts the Atom's fields from the 6847, which syncs its count only after painting", () => {
        const display = make({ model: { isMaster: false, isAtom: true } });
        const atom = paintedFrom(0, 0);
        atom.video6847 = { frameCount: 7 };
        display.onPaint(atom, 0, 0, FbWidth, 8);
        presentAll();
        atom.video6847.frameCount = 10;
        display.onPaint(atom, 0, 0, FbWidth, 8);
        presentAll();
        expect(fakeCanvas.paint.mock.calls.at(-1)[4].fields).toBe(3);
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

    it("never skips a debug paint, and does not count it against the cycle", () => {
        const display = make({ frameSkip: 3 });
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8);
        display.onPaint(paintedFrom(), 0, 0, FbWidth, 8, 4);
        expect(rafCallbacks).toHaveLength(1);
        presentAll();
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
            display.onPaint(paintedFrom(display.video.frameSkipCount), 0, 0, FbWidth, 8);
            expect(rafCallbacks).toHaveLength(1);
        });
    });

    it("carries the interlace bases and line grid to the presenter", () => {
        const display = make();
        const from = {
            lineGrid: new Uint8Array([1, 2, 3]),
            lineBaseEven: 5,
            lineBaseOdd: 6,
            phaseBaseEven: 0.25,
            phaseBaseOdd: 0.75,
        };
        display.onPaint(from, 0, 0, FbWidth, 8);
        expect(display.pendingFrame.lineBaseEven).toBe(5);
        expect(display.pendingFrame.lineBaseOdd).toBe(6);
        expect(display.pendingFrame.phaseBaseEven).toBe(0.25);
        expect(display.pendingFrame.phaseBaseOdd).toBe(0.75);
        expect([...display.pendingFrame.lineGrid.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
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
        expect(toasts()).toEqual([expect.stringContaining("no WebGL")]);
    });

    it("uses a fake video chip when asked", () => {
        const display = make({ fakeVideo: true });
        expect(typeof display.video.polltime).toBe("function");
    });
});
