// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Layout, fitMonitor } from "../../src/web/layout.js";
import { teardownDom, toasts } from "./helpers.js";

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

const LayoutMarkup = `
<nav id="header-bar"></nav>
<div id="cub-monitor">
  <img id="cub-monitor-pic" />
  <div class="sidebar left"><img /></div>
  <canvas id="screen" width="800" height="600"></canvas>
  <div class="sidebar right"><img /></div>
  <div class="sidebar bottom"><img /></div>
</div>
<ul><li><a href="#" id="fs"></a></li></ul>`;

describe("Layout", () => {
    let display;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = LayoutMarkup;
        display = { filterClass: { getDisplayConfig: vi.fn(() => Config) }, video: { paint: vi.fn() } };
    });

    afterEach(teardownDom);

    const screenCanvas = () => document.getElementById("screen");
    const make = (overrides = {}) => new Layout({ screenCanvas: screenCanvas(), display, embed: true, ...overrides });
    const resize = () => window.dispatchEvent(new Event("resize"));

    describe("fitting the window", () => {
        it("places the monitor and canvas on a window resize", () => {
            make();
            resize();
            const monitor = document.getElementById("cub-monitor");
            expect(monitor.style.width).toBe("1024px");
            expect(monitor.style.height).toBe("768px");
            expect(document.getElementById("cub-monitor-pic").style.width).toBe("1024px");
            const canvas = screenCanvas();
            expect(canvas.style.width).toBe("768px");
            expect(canvas.style.height).toBe("576px");
            expect(canvas.style.left).toBe("128px");
            expect(canvas.style.top).toBe("64px");
        });

        it("reserves room for the page furniture when not embedded", () => {
            make({ embed: false });
            resize();
            const monitor = document.getElementById("cub-monitor");
            expect(monitor.style.width).toBe("824px");
            expect(monitor.style.height).toBe("618px");
        });

        it("takes two more looks shortly after load, when the page has settled", () => {
            make();
            expect(display.filterClass.getDisplayConfig).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(display.filterClass.getDisplayConfig).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(499);
            expect(display.filterClass.getDisplayConfig).toHaveBeenCalledTimes(2);
        });
    });

    describe("the drawing buffer", () => {
        beforeEach(() => {
            display.filterClass.getDisplayConfig = () => ({ ...Config, maxCanvasScale: 3 });
            Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
        });

        afterEach(() => {
            delete window.devicePixelRatio;
        });

        it("is reallocated and repainted when a mode asks for a new size", () => {
            make();
            resize();
            expect(screenCanvas().width).toBe(1600);
            expect(screenCanvas().height).toBe(1200);
            expect(display.video.paint).toHaveBeenCalledTimes(1);
        });

        it("is left alone when the fitted size has not changed", () => {
            make();
            resize();
            resize();
            expect(display.video.paint).toHaveBeenCalledTimes(1);
        });
    });

    describe("the sidebars", () => {
        it("keeps the art hidden when there is none to show", () => {
            make();
            for (const img of document.querySelectorAll(".sidebar img")) expect(img.style.display).toBe("none");
        });

        it("hangs a loaded image off its edge of the monitor", () => {
            make({ sidebars: { left: "left.png", bottom: "strip.png" } });
            const left = document.querySelector(".sidebar.left img");
            expect(left.src).toContain("left.png");
            Object.defineProperty(left, "naturalWidth", { value: 60 });
            left.dispatchEvent(new Event("load"));
            expect(left.parentElement.style.left).toBe("-65px");
            expect(left.style.display).toBe("");

            const bottom = document.querySelector(".sidebar.bottom img");
            Object.defineProperty(bottom, "naturalHeight", { value: 40 });
            bottom.dispatchEvent(new Event("load"));
            expect(bottom.parentElement.style.bottom).toBe("-40px");
            expect(document.querySelector(".sidebar.right img").style.display).toBe("none");
        });
    });

    describe("the fullscreen menu item", () => {
        it("is hidden where the API is missing", () => {
            make();
            expect(document.getElementById("fs").closest("li").hidden).toBe(true);
        });

        describe("with the API present", () => {
            beforeEach(() => {
                Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
            });

            afterEach(() => {
                delete document.fullscreenEnabled;
            });

            it("asks for fullscreen on the canvas", () => {
                screenCanvas().requestFullscreen = vi.fn().mockResolvedValue();
                make();
                document.getElementById("fs").click();
                expect(screenCanvas().requestFullscreen).toHaveBeenCalledTimes(1);
            });

            it("toasts when the browser refuses", async () => {
                screenCanvas().requestFullscreen = vi.fn().mockRejectedValue(new Error("denied"));
                make();
                document.getElementById("fs").click();
                await vi.waitFor(() =>
                    expect(toasts()).toEqual([expect.stringContaining("Could not go fullscreen: denied")]),
                );
            });
        });
    });
});
