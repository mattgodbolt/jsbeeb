// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RewindUI } from "../../src/web/rewind-ui.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const FakeContext = {
    createImageData: () => ({ data: new Uint8Array(1024 * 625 * 4) }),
    putImageData: () => {},
    drawImage: () => {},
};

describe("RewindUI", () => {
    let video;
    let processor;
    let resume;
    let loop;

    beforeEach(() => {
        domFromIndexHtml("rewind-open", "rewind-panel");
        Element.prototype.scrollIntoView = vi.fn();
        const realCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation((tag) => {
            const element = realCreateElement(tag);
            if (tag === "canvas") element.getContext = () => FakeContext;
            return element;
        });
        video = { fb32: new Uint32Array(1024 * 625), frameCount: 0, clearPaintBuffer: () => {}, paint: vi.fn() };
        processor = {
            snapshotState: vi.fn(() => ({ live: true })),
            restoreState: vi.fn(),
            execute: vi.fn(() => {
                video.frameCount++;
            }),
        };
        resume = vi.fn();
        loop = Object.assign(new EventTarget(), { pause: vi.fn(() => resume) });
    });

    afterEach(teardownDom);

    const make = () => new RewindUI({ processor, video, loop });
    const panel = () => document.getElementById("rewind-panel");
    const thumbs = () => [...document.querySelectorAll(".rewind-thumb")];
    const selectedIndex = () => Number(document.querySelector(".rewind-thumb.selected").dataset.index);
    const lastRestored = () => processor.restoreState.mock.calls.at(-1)[0];
    const key = (name) => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, cancelable: true }));

    // The loop asking for captures, once a RewindUI is listening.
    const captured = (count) => {
        const snapshots = Array.from({ length: count }, (_, i) => ({ snapshot: i }));
        for (const snapshot of snapshots) {
            processor.snapshotState.mockReturnValueOnce(snapshot);
            loop.dispatchEvent(new Event("rewind-capture"));
        }
        return snapshots;
    };

    describe("opening", () => {
        it("does nothing when nothing has been captured", () => {
            make().open();
            expect(panel().hidden).toBe(true);
            expect(loop.pause).not.toHaveBeenCalled();
        });

        it("pauses, fills the filmstrip with ages, and lands on now", () => {
            make();
            const snapshots = captured(3);
            document.getElementById("rewind-open").click();
            expect(loop.pause).toHaveBeenCalledWith("the rewind panel");
            expect(panel().hidden).toBe(false);
            expect(thumbs().map((thumb) => thumb.querySelector(".rewind-thumb-label").textContent)).toEqual([
                "-2s",
                "-1s",
                "now",
            ]);
            expect(selectedIndex()).toBe(2);
            expect(lastRestored()).toBe(snapshots[2]);
            expect(video.paint).toHaveBeenCalled();
        });

        it("lets go and stays closed if the machine cannot be snapshotted", () => {
            const ui = make();
            captured(1);
            processor.snapshotState.mockImplementation(() => {
                throw new Error("no snapshot");
            });
            expect(() => ui.open()).toThrow("no snapshot");
            expect(panel().hidden).toBe(true);
            expect(resume).toHaveBeenCalledTimes(1);
            expect(processor.restoreState).not.toHaveBeenCalled();
        });

        it("opens once no matter how often it is asked", () => {
            const ui = make();
            captured(1);
            ui.open();
            ui.open();
            expect(loop.pause).toHaveBeenCalledTimes(1);
            expect(thumbs()).toHaveLength(1);
        });
    });

    describe("choosing a snapshot", () => {
        it("previews a clicked thumbnail without moving the machine on", () => {
            const ui = make();
            const snapshots = captured(3);
            ui.open();
            thumbs()[0].click();
            expect(selectedIndex()).toBe(0);
            expect(lastRestored()).toBe(snapshots[0]);
        });

        it("walks the filmstrip with the arrow keys, stopping at the ends", () => {
            const ui = make();
            captured(2);
            ui.open();
            key("ArrowLeft");
            expect(selectedIndex()).toBe(0);
            key("ArrowLeft");
            expect(selectedIndex()).toBe(0);
            key("ArrowRight");
            key("ArrowRight");
            expect(selectedIndex()).toBe(1);
        });

        it("keeps every key from reaching the emulator while open", () => {
            const ui = make();
            captured(1);
            ui.open();
            const leaked = vi.fn();
            document.addEventListener("keydown", leaked);
            key("a");
            expect(leaked).not.toHaveBeenCalled();
            document.removeEventListener("keydown", leaked);
        });
    });

    describe("closing", () => {
        it("commits the chosen snapshot on Enter and runs on from it", () => {
            const ui = make();
            const snapshots = captured(2);
            ui.open();
            key("ArrowLeft");
            key("Enter");
            expect(lastRestored()).toBe(snapshots[0]);
            expect(panel().hidden).toBe(true);
            expect(thumbs()).toHaveLength(0);
            expect(resume).toHaveBeenCalledTimes(1);
        });

        it("cancels back to the state from before it opened on Escape", () => {
            const ui = make();
            captured(2);
            ui.open();
            key("ArrowLeft");
            key("Escape");
            expect(lastRestored()).toEqual({ live: true });
            expect(panel().hidden).toBe(true);
            expect(resume).toHaveBeenCalledTimes(1);
        });

        it("cancels from the close button", () => {
            const ui = make();
            captured(1);
            ui.open();
            document.getElementById("rewind-close").click();
            expect(panel().hidden).toBe(true);
        });

        it("stops listening for keys once closed", () => {
            const ui = make();
            captured(2);
            ui.open();
            key("Escape");
            processor.restoreState.mockClear();
            key("ArrowLeft");
            expect(processor.restoreState).not.toHaveBeenCalled();
        });

        it("lets go of its hold when it is reset", () => {
            const ui = make();
            captured(1);
            ui.open();
            ui.reset();
            expect(resume).toHaveBeenCalledTimes(1);
        });
    });

    describe("the menu item", () => {
        it("is disabled until something has been captured", () => {
            const ui = make();
            ui.updateButtonState();
            expect(document.getElementById("rewind-open").classList.contains("disabled")).toBe(true);
            captured(1);
            ui.updateButtonState();
            expect(document.getElementById("rewind-open").classList.contains("disabled")).toBe(false);
        });
    });

    describe("reset", () => {
        it("closes the panel and forgets everything captured", () => {
            const ui = make();
            captured(3);
            ui.open();
            ui.reset();
            expect(panel().hidden).toBe(true);
            expect(document.getElementById("rewind-open").classList.contains("disabled")).toBe(true);
        });
    });
});
