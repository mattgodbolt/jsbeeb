// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RewindUI } from "../../src/web/rewind-ui.js";
import { RewindBuffer } from "../../src/rewind.js";
import { teardownDom } from "./helpers.js";

const Markup = `
<a href="#" id="rewind-open"></a>
<div id="rewind-panel" hidden>
  <button id="rewind-close"></button>
  <div id="rewind-filmstrip"></div>
</div>`;

const FakeContext = {
    createImageData: () => ({ data: new Uint8Array(1024 * 625 * 4) }),
    putImageData: () => {},
    drawImage: () => {},
};

describe("RewindUI", () => {
    let rewindBuffer;
    let video;
    let processor;
    let running;
    let loop;

    beforeEach(() => {
        document.body.innerHTML = Markup;
        Element.prototype.scrollIntoView = vi.fn();
        const realCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation((tag) => {
            const element = realCreateElement(tag);
            if (tag === "canvas") element.getContext = () => FakeContext;
            return element;
        });
        rewindBuffer = new RewindBuffer(5);
        video = { fb32: new Uint32Array(1024 * 625), frameCount: 0, clearPaintBuffer: () => {}, paint: vi.fn() };
        processor = {
            snapshotState: vi.fn(() => ({ live: true })),
            restoreState: vi.fn(),
            execute: vi.fn(() => {
                video.frameCount++;
            }),
        };
        running = true;
        loop = { isRunning: () => running, stop: vi.fn(() => (running = false)), go: vi.fn(() => (running = true)) };
    });

    afterEach(teardownDom);

    const make = () => new RewindUI({ rewindBuffer, processor, video, captureInterval: 50, loop });
    const panel = () => document.getElementById("rewind-panel");
    const thumbs = () => [...document.querySelectorAll(".rewind-thumb")];
    const selectedIndex = () => Number(document.querySelector(".rewind-thumb.selected").dataset.index);
    const lastRestored = () => processor.restoreState.mock.calls.at(-1)[0];
    const key = (name) => document.dispatchEvent(new KeyboardEvent("keydown", { key: name, cancelable: true }));

    const captured = (count) => {
        const snapshots = Array.from({ length: count }, (_, i) => ({ snapshot: i }));
        for (const snapshot of snapshots) rewindBuffer.push(snapshot);
        return snapshots;
    };

    describe("opening", () => {
        it("does nothing when nothing has been captured", () => {
            make().open();
            expect(panel().hidden).toBe(true);
            expect(loop.stop).not.toHaveBeenCalled();
        });

        it("pauses, fills the filmstrip with ages, and lands on now", () => {
            const snapshots = captured(3);
            make();
            document.getElementById("rewind-open").click();
            expect(loop.stop).toHaveBeenCalledWith(false);
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

        it("opens once no matter how often it is asked", () => {
            captured(1);
            const ui = make();
            ui.open();
            ui.open();
            expect(loop.stop).toHaveBeenCalledTimes(1);
            expect(thumbs()).toHaveLength(1);
        });
    });

    describe("choosing a snapshot", () => {
        it("previews a clicked thumbnail without moving the machine on", () => {
            const snapshots = captured(3);
            make().open();
            thumbs()[0].click();
            expect(selectedIndex()).toBe(0);
            expect(lastRestored()).toBe(snapshots[0]);
        });

        it("walks the filmstrip with the arrow keys, stopping at the ends", () => {
            captured(2);
            make().open();
            key("ArrowLeft");
            expect(selectedIndex()).toBe(0);
            key("ArrowLeft");
            expect(selectedIndex()).toBe(0);
            key("ArrowRight");
            key("ArrowRight");
            expect(selectedIndex()).toBe(1);
        });

        it("keeps every key from reaching the emulator while open", () => {
            captured(1);
            make().open();
            const leaked = vi.fn();
            document.addEventListener("keydown", leaked);
            key("a");
            expect(leaked).not.toHaveBeenCalled();
            document.removeEventListener("keydown", leaked);
        });
    });

    describe("closing", () => {
        it("commits the chosen snapshot on Enter and runs on from it", () => {
            const snapshots = captured(2);
            make().open();
            key("ArrowLeft");
            key("Enter");
            expect(lastRestored()).toBe(snapshots[0]);
            expect(panel().hidden).toBe(true);
            expect(thumbs()).toHaveLength(0);
            expect(loop.go).toHaveBeenCalledTimes(1);
        });

        it("cancels back to the state from before it opened on Escape", () => {
            captured(2);
            make().open();
            key("ArrowLeft");
            key("Escape");
            expect(lastRestored()).toEqual({ live: true });
            expect(panel().hidden).toBe(true);
            expect(loop.go).toHaveBeenCalledTimes(1);
        });

        it("cancels from the close button", () => {
            captured(1);
            make().open();
            document.getElementById("rewind-close").click();
            expect(panel().hidden).toBe(true);
        });

        it("stops listening for keys once closed", () => {
            captured(2);
            make().open();
            key("Escape");
            processor.restoreState.mockClear();
            key("ArrowLeft");
            expect(processor.restoreState).not.toHaveBeenCalled();
        });

        it("leaves a machine that was paused before opening paused", () => {
            captured(1);
            running = false;
            const ui = make();
            ui.open();
            ui.commit();
            expect(loop.stop).not.toHaveBeenCalled();
            expect(loop.go).not.toHaveBeenCalled();
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
            captured(3);
            const ui = make();
            ui.open();
            ui.reset();
            expect(panel().hidden).toBe(true);
            expect(rewindBuffer.length).toBe(0);
            expect(document.getElementById("rewind-open").classList.contains("disabled")).toBe(true);
        });
    });
});
