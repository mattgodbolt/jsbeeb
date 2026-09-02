// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscVisualiser } from "../../src/web/disc-visualiser.js";
import { DiscGeometry } from "../../src/disc-surface.js";
import { IbmDiscFormat } from "../../src/disc.js";
import { discFor } from "../../src/fdc.js";
import { domFromIndexHtml, ssdImage, teardownDom } from "./helpers.js";

const CanvasSize = 100;

const overlayContext = () => ({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
});

describe("DiscVisualiser", () => {
    let fdc;
    let rafCallbacks;

    beforeEach(() => {
        domFromIndexHtml("disc-visualiser-open", "disc-panel");
        const surface = document.getElementById("disc-surface");
        const overlay = document.getElementById("disc-overlay");
        Object.defineProperty(surface, "clientWidth", { value: CanvasSize });
        surface.getContext = () => ({
            createImageData: (width, height) => ({ data: new Uint8Array(width * height * 4) }),
            putImageData: vi.fn(),
        });
        overlay.getContext = overlayContext;
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: CanvasSize, height: CanvasSize });
        document.querySelector(".disc-header").setPointerCapture = () => {};

        rafCallbacks = new Map();
        let nextHandle = 1;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            rafCallbacks.set(nextHandle, callback);
            return nextHandle++;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => rafCallbacks.delete(handle));

        fdc = {
            drives: [
                { disc: null, track: 0, positionFraction: 0, spinning: false, isSideUpper: false },
                { disc: null, track: 0, positionFraction: 0, spinning: false, isSideUpper: false },
            ],
        };
    });

    afterEach(teardownDom);

    const make = () => new DiscVisualiser({ fdc });
    const panel = () => document.getElementById("disc-panel");
    const status = () => document.getElementById("disc-status").textContent;
    const pumpFrame = () => {
        const callbacks = [...rafCallbacks.values()];
        rafCallbacks.clear();
        for (const callback of callbacks) callback();
    };
    const pumpUntilScanned = () => {
        for (let i = 0; i < 500 && status().includes("reading surface"); ++i) pumpFrame();
    };

    describe("the panel", () => {
        it("opens from the menu item and closes from its button", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            expect(panel().hidden).toBe(false);
            expect(status()).toBe("Drive 0: no disc");
            document.getElementById("disc-close").click();
            expect(panel().hidden).toBe(true);
        });

        it("toggles from the same menu item", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            document.getElementById("disc-visualiser-open").click();
            expect(panel().hidden).toBe(true);
        });

        it("stops animating once closed", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            pumpFrame();
            document.getElementById("disc-close").click();
            expect(rafCallbacks.size).toBe(0);
        });

        it("can be dragged around by its header, clamped to the window", () => {
            make();
            const header = document.querySelector(".disc-header");
            header.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
            header.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 25 }));
            expect(panel().style.left).toBe("20px");
            expect(panel().style.top).toBe("15px");
            expect(panel().style.right).toBe("auto");
            header.dispatchEvent(new MouseEvent("pointermove", { clientX: 2, clientY: 2 }));
            expect(panel().style.left).toBe("0px");
            expect(panel().style.top).toBe("0px");
        });
    });

    describe("the views", () => {
        it("starts on the pulse density legend and swaps for the format one", () => {
            make();
            const legend = document.getElementById("disc-legend");
            expect(legend.textContent).toContain("pulses per 64");
            document.querySelector("[data-view='format']").click();
            expect(legend.textContent).toContain("CRC error");
        });

        it("marks the drive, side and view in use once open", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            const active = [...panel().querySelectorAll(".active")];
            expect(active.map((button) => button.dataset)).toEqual([
                expect.objectContaining({ drive: "0" }),
                expect.objectContaining({ side: "0" }),
                expect.objectContaining({ view: "density" }),
            ]);
            document.querySelector("[data-drive='1']").click();
            expect(panel().querySelector("[data-drive='1']").classList.contains("active")).toBe(true);
            expect(status()).toBe("Drive 1: no disc");
        });
    });

    describe("with a disc in the drive", () => {
        beforeEach(() => {
            vi.spyOn(console, "log").mockImplementation(() => {});
            fdc.drives[0].disc = discFor("elite.ssd", ssdImage());
            fdc.drives[0].spinning = true;
        });

        it("scans the surface, then names the disc and reports the head", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            pumpUntilScanned();
            expect(status()).toBe("spinning · head track 0 · 0.0 ms");
            expect(document.getElementById("disc-name").textContent).toBe("elite.ssd");
            expect(document.getElementById("disc-side-controls").hidden).toBe(true);
        });

        it("reads the surface under the pointer", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            pumpUntilScanned();
            const geometry = new DiscGeometry(CanvasSize, IbmDiscFormat.tracksPerDisc);
            const { x, y } = geometry.pointAt(0, 0.25);
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
            pumpFrame();
            expect(document.getElementById("disc-hover-where").textContent).toMatch(/^Track 0 · word \d+/);
            expect(document.getElementById("disc-hover-what").textContent).toMatch(/pulses|no flux/);
            overlay.dispatchEvent(new MouseEvent("mouseleave"));
            pumpFrame();
            expect(document.getElementById("disc-hover-where").textContent).toBe("Point at the surface to read it");
        });

        it("zooms with the wheel and says so, and a double click resets", () => {
            make();
            document.getElementById("disc-visualiser-open").click();
            pumpUntilScanned();
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 50, clientY: 50 }));
            pumpFrame();
            expect(status()).toContain("1.3x");
            overlay.dispatchEvent(new MouseEvent("dblclick"));
            pumpFrame();
            expect(status()).not.toContain("x");
        });
    });
});
