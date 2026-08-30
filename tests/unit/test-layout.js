// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { fitMonitor } from "../../src/web/layout.js";

const Config = {
    imageWidth: 800,
    imageHeight: 600,
    canvasLeft: 100,
    canvasTop: 50,
    visibleWidth: 600,
    visibleHeight: 450,
    canvasWidth: 800,
    canvasHeight: 600,
};

const viewport = (innerWidth, innerHeight, extra = {}) => ({
    innerWidth,
    innerHeight,
    navbarHeight: 40,
    borderReservedSize: 100,
    bottomReservedSize: 68,
    devicePixelRatio: 1,
    ...extra,
});

const native = { width: 800, height: 600 };

describe("fitMonitor", () => {
    it("fills the width of a tall window, keeping the picture's aspect", () => {
        const fitted = fitMonitor(Config, viewport(1000, 2000), native);
        expect(fitted.monitor.width).toBe(800);
        expect(fitted.monitor.height).toBe(600);
    });

    it("fills the height of a wide window, keeping the picture's aspect", () => {
        const fitted = fitMonitor(Config, viewport(4000, 708), native);
        expect(fitted.monitor.height).toBe(600);
        expect(fitted.monitor.width).toBe(800);
    });

    it("never shrinks below a quarter of the picture", () => {
        const fitted = fitMonitor(Config, viewport(10, 10), native);
        expect(fitted.monitor.width).toBe(200);
        expect(fitted.monitor.height).toBe(150);
    });

    it("scales the canvas position and visible size with the monitor", () => {
        const fitted = fitMonitor(Config, viewport(1700, 2000), native);
        // Monitor is 1500 wide: containerScale 1.875.
        expect(fitted.canvas.left).toBeCloseTo(187.5);
        expect(fitted.canvas.top).toBeCloseTo(93.75);
        expect(fitted.canvas.width).toBeCloseTo(600 * 1.875);
        expect(fitted.canvas.height).toBeCloseTo(450 * 1.875);
    });

    it("letterboxes a canvas wider than the visible area", () => {
        const fitted = fitMonitor(Config, viewport(1000, 2000), { width: 1600, height: 600 });
        // canvasAspect 2.67 beats visibleAspect 1.33: width-limited.
        expect(fitted.canvas.width).toBeCloseTo(600);
        expect(fitted.canvas.height).toBeCloseTo(600 / (1600 / 600));
    });

    it("asks for no backing store change for a mode without a scale limit", () => {
        expect(fitMonitor(Config, viewport(1000, 2000), native).backing).toBeNull();
    });

    describe("a mode that scales its drawing buffer", () => {
        const scaled = { ...Config, maxCanvasScale: 3 };

        it("quantises the scale so a drag does not thrash the buffer", () => {
            // Canvas width 600 at dpr 1 wants scale 0.75, quantised then floored to 1.
            const fitted = fitMonitor(scaled, viewport(1000, 2000), native);
            expect(fitted.backing).toEqual({ width: 800, height: 600 });
        });

        it("grows with the device pixel ratio", () => {
            const fitted = fitMonitor(scaled, viewport(1000, 2000, { devicePixelRatio: 2 }), native);
            // Wants 1.5, on the quantisation grid already.
            expect(fitted.backing).toEqual({ width: 1200, height: 900 });
        });

        it("stops at the mode's limit", () => {
            const fitted = fitMonitor(scaled, viewport(1000, 2000, { devicePixelRatio: 10 }), native);
            expect(fitted.backing).toEqual({ width: 2400, height: 1800 });
        });
    });

    it("uses the whole window when embedded", () => {
        const fitted = fitMonitor(
            Config,
            viewport(800, 640, { navbarHeight: 0, borderReservedSize: 0, bottomReservedSize: 0 }),
            native,
        );
        expect(fitted.monitor.width).toBe(800);
        expect(fitted.monitor.height).toBe(600);
    });
});
