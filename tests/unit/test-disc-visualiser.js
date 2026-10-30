// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscVisualiser } from "../../src/web/disc-visualiser.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { DiscGeometry } from "../../src/disc-surface.js";
import { IbmDiscFormat } from "../../src/disc-format.js";
import { discFor } from "../../src/fdc.js";
import { corruptSectorData } from "../helpers/disc-builders.js";
import { domFromIndexHtml, fakeAnimationFrames, ssdImage, teardownDom } from "./helpers.js";

const CanvasSize = 100;
const OddTrack = 40;
const OddSector = 5;

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
    let frames;
    let resizeObserved;

    beforeEach(() => {
        domFromIndexHtml("disc-panel");
        const surface = document.getElementById("disc-surface");
        const overlay = document.getElementById("disc-overlay");
        Object.defineProperty(surface, "clientWidth", { value: CanvasSize, configurable: true });
        surface.getContext = () => ({
            createImageData: (width, height) => ({ data: new Uint8Array(width * height * 4) }),
            putImageData: vi.fn(),
        });
        overlay.getContext = overlayContext;
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: CanvasSize, height: CanvasSize });
        resizeObserved = null;
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback) {
                    this.callback = callback;
                }
                observe(element) {
                    resizeObserved = { element, callback: this.callback };
                }
                disconnect() {
                    resizeObserved = null;
                }
            },
        );

        frames = fakeAnimationFrames();

        fdc = {
            drives: [
                { disc: null, track: 0, positionFraction: 0, spinning: false, isSideUpper: false },
                { disc: null, track: 0, positionFraction: 0, spinning: false, isSideUpper: false },
            ],
        };
    });

    afterEach(teardownDom);

    const make = () => new DiscVisualiser({ fdc, arrangement: new PanelArrangement(() => window.localStorage) });
    const panel = () => document.getElementById("disc-panel");
    const status = () => document.getElementById("disc-status").textContent;
    const pumpUntilScanned = () => {
        for (let i = 0; i < 500 && status().includes("reading surface"); ++i) frames.run();
    };

    describe("the panel", () => {
        it("opens and closes from its button", () => {
            const visualiser = make();
            visualiser.toggle();
            expect(panel().hidden).toBe(false);
            expect(status()).toBe("Drive 0: no disc");
            document.getElementById("disc-close").click();
            expect(panel().hidden).toBe(true);
        });

        it("stops animating once closed", () => {
            const visualiser = make();
            visualiser.toggle();
            frames.run();
            document.getElementById("disc-close").click();
            expect(frames.pending).toBe(0);
        });

        it("redraws its surface at the size the canvas is resized to, while open", () => {
            make().open();
            const surface = document.getElementById("disc-surface");
            expect(resizeObserved.element).toBe(surface);
            Object.defineProperty(surface, "clientWidth", { value: 2 * CanvasSize, configurable: true });
            resizeObserved.callback();
            expect(surface.width).toBe(2 * CanvasSize);
            vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
            window.dispatchEvent(new Event("resize"));
            expect(surface.width).toBe(6 * CanvasSize);
            document.getElementById("disc-close").click();
            expect(resizeObserved).toBeNull();
        });

        it("opens on a named drive", () => {
            const visualiser = make();
            visualiser.openOn(1);
            expect(panel().hidden).toBe(false);
            expect(status()).toBe("Drive 1: no disc");
            expect(document.querySelector('[data-drive="1"]').classList.contains("active")).toBe(true);
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
            const visualiser = make();
            visualiser.toggle();
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
            fdc.drives[0].disc = discFor("elite.ssd", ssdImage());
            fdc.drives[0].spinning = true;
        });

        it("scans the surface, then names the disc and reports the head", () => {
            const visualiser = make();
            visualiser.toggle();
            pumpUntilScanned();
            expect(status()).toBe("spinning · head track 0 · 0.0 ms");
            expect(document.getElementById("disc-name").textContent).toBe("elite.ssd");
            expect(document.getElementById("disc-side-controls").hidden).toBe(true);
        });

        it("reads the surface under the pointer", () => {
            const visualiser = make();
            visualiser.toggle();
            pumpUntilScanned();
            const geometry = new DiscGeometry(CanvasSize, IbmDiscFormat.tracksPerDisc);
            const { x, y } = geometry.pointAt(0, 0.25);
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
            frames.run();
            expect(document.getElementById("disc-hover-where").textContent).toMatch(/^Track 0 · word \d+/);
            expect(document.getElementById("disc-hover-what").textContent).toMatch(/pulses|no flux/);
            overlay.dispatchEvent(new MouseEvent("mouseleave"));
            frames.run();
            expect(document.getElementById("disc-hover-where").textContent).toBe("Point at the surface to read it");
        });

        it("zooms with the wheel and says so, and a double click resets", () => {
            const visualiser = make();
            visualiser.toggle();
            pumpUntilScanned();
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 50, clientY: 50 }));
            frames.run();
            expect(status()).toContain("1.3x");
            overlay.dispatchEvent(new MouseEvent("dblclick"));
            frames.run();
            expect(status()).not.toContain("x");
        });

        it("lists what is odd about the side, and zooms in on a finding when it is clicked", () => {
            const visualiser = make();
            visualiser.openReport(0);
            frames.run();
            const findings = () => [...document.querySelectorAll("#disc-report li")].map((item) => item.textContent);
            expect(document.getElementById("disc-report").hidden).toBe(false);
            expect(findings()).toEqual(["Nothing odd on this side."]);
            const odd = discFor("odd.ssd", ssdImage());
            corruptSectorData(odd.getTrack(false, OddTrack), OddSector);
            fdc.drives[0].disc = odd;
            visualiser.redraw();
            frames.run();
            expect(findings()).toEqual([`track ${OddTrack}: sector ${OddSector} with a bad data CRC`]);
            pumpUntilScanned();
            document.querySelector("#disc-report button").click();
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new MouseEvent("mousemove", { clientX: CanvasSize / 2, clientY: CanvasSize / 2 }));
            frames.run();
            expect(status()).toContain("6.0x");
            expect(document.getElementById("disc-hover-where").textContent).toMatch(
                new RegExp(`^Track ${OddTrack} · `),
            );
            document.getElementById("disc-report-toggle").click();
            expect(document.getElementById("disc-report").hidden).toBe(true);
        });

        it("lists the side shown, and lists it again once writes to it have stopped", () => {
            const now = vi.spyOn(performance, "now").mockReturnValue(1000);
            const odd = discFor("odd.dsd", ssdImage(800, { length: 2 * 80 * 10 * 256 }));
            corruptSectorData(odd.getTrack(true, OddTrack), OddSector);
            fdc.drives[0].disc = odd;
            const visualiser = make();
            visualiser.openReport(0);
            frames.run();
            const findings = () => [...document.querySelectorAll("#disc-report li")].map((item) => item.textContent);
            expect(findings()).toEqual(["Nothing odd on this side."]);
            document.querySelector("[data-side='1']").click();
            frames.run();
            expect(findings()).toEqual([`track ${OddTrack}: sector ${OddSector} with a bad data CRC`]);

            const track = odd.getTrack(true, OddTrack);
            const dataWord = Math.floor(track.findSectors()[OddSector + 1].dataPosBitOffset / 32) + 2;
            odd.writePulses(true, OddTrack, dataWord, IbmDiscFormat.fmTo2usPulses(0xff, 0x55));
            odd.flushWrites();
            frames.run();
            expect(findings()).toHaveLength(1);
            now.mockReturnValue(1000 + 1000);
            frames.run();
            expect(findings()).toEqual([
                `track ${OddTrack}: sectors ${OddSector}-${OddSector + 1} with a bad data CRC`,
            ]);
        });

        it("opens zoomed in on the head, wherever it is", () => {
            fdc.drives[0].track = 20;
            fdc.drives[0].positionFraction = 0.25;
            make().zoomToHead(0);
            pumpUntilScanned();
            const overlay = document.getElementById("disc-overlay");
            overlay.dispatchEvent(new MouseEvent("mousemove", { clientX: CanvasSize / 2, clientY: CanvasSize / 2 }));
            frames.run();
            expect(status()).toContain("6.0x");
            expect(document.getElementById("disc-hover-where").textContent).toMatch(/^Track 20 · .* · (49|50)\.\d ms$/);
        });
    });
});
