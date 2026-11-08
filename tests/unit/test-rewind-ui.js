// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RewindUI } from "../../src/web/rewind-ui.js";
import { ReplayHistory, snapshotCycle } from "../../src/replay.js";
import { cycleCount, stateHash } from "../../src/lockstep.js";
import { TEST_6502 } from "../../src/models.js";
import { RunMode } from "../../src/web/emulation-loop.js";
import { keyCodes } from "../../src/keymap.js";
import { domFromIndexHtml, loadBytes, machineShowingFrames, sentEvents, stubCanvases, teardownDom } from "./helpers.js";

const ProgramAt = 0x2000;
// INC &70; JMP &2000
const CountForever = [0xe6, 0x70, 0x4c, 0x00, 0x20];
const FrameCycles = 40000;
// A picture no frame draws.
const Marker = 0x12345678;

describe("RewindUI", () => {
    let cpu;
    let resume;
    let loop;
    let history;

    beforeEach(async () => {
        domFromIndexHtml("rewind-open", "rewind-panel");
        Element.prototype.scrollIntoView = vi.fn();
        stubCanvases();
        cpu = await machineShowingFrames(TEST_6502);
        loadBytes(cpu, ProgramAt, CountForever);
        cpu.pc = ProgramAt;
        resume = vi.fn();
        loop = Object.assign(new EventTarget(), { hold: vi.fn(() => resume), stop: vi.fn() });
        history = new ReplayHistory(cpu);
    });

    afterEach(teardownDom);

    const make = () => new RewindUI({ loop, history });
    const panel = () => document.getElementById("rewind-panel");
    const thumbs = () => [...document.querySelectorAll(".rewind-thumb")];
    const selectedIndex = () => Number(document.querySelector(".rewind-thumb.selected").dataset.index);
    const key = (name, options) =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: name, cancelable: true, ...options }));
    const machineNow = () => ({ cycle: cycleCount(cpu), hash: stateHash(cpu), picture: cpu.video.fb32.slice() });

    // The loop running a frame and asking for its capture, once a RewindUI is listening.
    const frame = () => {
        cpu.execute(FrameCycles);
        loop.dispatchEvent(new Event("frame-capture"));
    };
    // Each a frame, then a rewind capture of it; returns the hash of the machine at each.
    const captured = (count) =>
        Array.from({ length: count }, () => {
            frame();
            loop.dispatchEvent(new Event("rewind-capture"));
            return stateHash(cpu);
        });
    const at = (snapshot) => snapshotCycle(cpu, snapshot);

    describe("opening", () => {
        it("does nothing when nothing has been captured", () => {
            make().open();
            expect(panel().hidden).toBe(true);
            expect(loop.hold).not.toHaveBeenCalled();
        });

        it("holds the machine, fills the filmstrip with ages, and previews now, keeping step back's history", () => {
            const ui = make();
            captured(3);
            frame();
            const kept = history.snapshots();
            const paint = vi.spyOn(cpu.video, "paint");
            document.getElementById("rewind-open").click();
            expect(loop.hold).toHaveBeenCalledWith("the rewind panel");
            expect(panel().hidden).toBe(false);
            expect(thumbs().map((thumb) => thumb.querySelector(".rewind-thumb-label").textContent)).toEqual([
                "-2s",
                "-1s",
                "now",
            ]);
            expect(selectedIndex()).toBe(2);
            expect(cycleCount(cpu)).toBeGreaterThan(at(ui.snapshots[2]));
            expect(paint).toHaveBeenCalled();
            expect(history.snapshots()).toEqual(kept);
        });

        it("lets go and stays closed if the machine cannot be snapshotted", () => {
            const ui = make();
            captured(1);
            vi.spyOn(cpu, "snapshotState").mockImplementation(() => {
                throw new Error("no snapshot");
            });
            expect(() => ui.open()).toThrow("no snapshot");
            expect(panel().hidden).toBe(true);
            expect(resume).toHaveBeenCalledTimes(1);
        });

        it("opens once no matter how often it is asked", () => {
            const ui = make();
            captured(1);
            ui.open();
            ui.open();
            expect(loop.hold).toHaveBeenCalledTimes(1);
            expect(thumbs()).toHaveLength(1);
        });
    });

    it("notes opening and rewinding, but not opening with nothing captured or cancelling", () => {
        const sent = sentEvents();
        const ui = make();
        ui.open();
        captured(2);
        ui.open();
        key("Escape");
        ui.open();
        key("Enter");
        expect(sent("feature_used")).toEqual([
            { feature: "rewind", action: "open" },
            { feature: "rewind", action: "open" },
            { feature: "rewind", action: "rewound" },
        ]);
    });

    describe("choosing a snapshot", () => {
        it("previews a clicked thumbnail by replaying on from it, then puts the machine back where it is", () => {
            const ui = make();
            captured(3);
            ui.open();
            const before = machineNow();
            const shownAt = [];
            vi.spyOn(cpu.video, "paint").mockImplementation(() => shownAt.push(cycleCount(cpu)));
            thumbs()[0].click();
            expect(selectedIndex()).toBe(0);
            expect(shownAt.some((cycle) => cycle > at(ui.snapshots[0]) && cycle < at(ui.snapshots[2]))).toBe(true);
            expect(machineNow()).toEqual(before);
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

        it.each([
            ["A", "keydown", { key: "a", code: "KeyA" }, "kept"],
            ["N's keypress, which the debugger's keys answer", "keypress", { key: "n" }, "kept"],
            ["Alt-W, as Option-W types it on a Mac", "keydown", { key: "∑", code: "KeyW", altKey: true }, "passed on"],
            ["Alt-T", "keydown", { key: "t", code: "KeyT", altKey: true }, "passed on"],
            ["Alt-B", "keydown", { key: "b", code: "KeyB", altKey: true }, "passed on"],
            ["Alt-D", "keydown", { key: "d", code: "KeyD", altKey: true }, "kept"],
            ["Alt-P", "keydown", { key: "p", code: "KeyP", altKey: true }, "kept"],
            ["Alt-M", "keydown", { key: "m", code: "KeyM", altKey: true }, "kept"],
            ["Alt-C", "keydown", { key: "c", code: "KeyC", altKey: true }, "kept"],
            ["Alt-1", "keydown", { key: "1", code: "Digit1", altKey: true }, "kept"],
            ["AltGr-W", "keydown", { key: "w", code: "KeyW", altKey: true, ctrlKey: true }, "kept"],
        ])("%s, while open, is %s", (_, type, init, fate) => {
            const ui = make();
            captured(1);
            ui.open();
            const reached = vi.fn();
            document.addEventListener(type, reached);
            document.dispatchEvent(new KeyboardEvent(type, { ...init, cancelable: true }));
            document.removeEventListener(type, reached);
            expect(reached).toHaveBeenCalledTimes(fate === "passed on" ? 1 : 0);
        });
    });

    describe("closing", () => {
        it.each([
            ["Enter, running on", RunMode.running, () => key("Enter"), false],
            ["Enter in the debugger, showing it there", RunMode.debugging, () => key("Enter"), true],
            [
                "Alt-S, stopping in the debugger there",
                RunMode.running,
                () => key("ß", { code: "KeyS", altKey: true }),
                true,
            ],
        ])(
            "goes back to the chosen snapshot on %s, showing it, forgetting everything newer",
            (_, mode, press, stops) => {
                loop.mode = mode;
                const ui = make();
                const hashes = captured(3);
                frame();
                cpu.video.fb32.fill(Marker);
                const marked = cpu.video.fb32.slice();
                ui.open();
                const strip = ui.snapshots;
                const painted = [];
                vi.spyOn(cpu.video, "paint").mockImplementation(() => painted.push(cpu.video.fb32.slice()));
                key("ArrowLeft");
                loop.stop.mockImplementation(() => expect(resume).toHaveBeenCalled());
                press();
                const chosen = strip[1];
                expect([cycleCount(cpu), stateHash(cpu)]).toEqual([at(chosen), hashes[1]]);
                expect(cpu.video.fb32).toEqual(painted.at(-1));
                expect(painted.at(-1)).not.toEqual(marked);
                expect(ui.rewindBuffer.getAll()).toEqual(strip.slice(0, 2));
                expect(ui.frames.getAll().filter((snapshot) => at(snapshot) > at(chosen))).toEqual([]);
                expect(Math.max(...history.snapshots().map(at))).toBe(at(chosen));
                expect(panel().hidden).toBe(true);
                expect(thumbs()).toHaveLength(0);
                expect(resume).toHaveBeenCalledTimes(1);
                expect(loop.stop.mock.calls).toEqual(stops ? [[true]] : []);
            },
        );

        it.each([
            ["Escape", () => key("Escape")],
            ["the close button", () => document.getElementById("rewind-close").click()],
            ["a second toggle, as Alt-W opens and closes it", (ui) => ui.toggle()],
        ])("cancels on %s, leaving the machine, its picture and step back's history as they were", (_, press) => {
            const ui = make();
            captured(2);
            frame();
            cpu.video.fb32.fill(Marker);
            const [before, kept] = [machineNow(), history.snapshots()];
            ui.open();
            key("ArrowLeft");
            press(ui);
            expect(machineNow()).toEqual(before);
            expect(history.snapshots()).toEqual(kept);
            expect(panel().hidden).toBe(true);
            expect(resume).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["cancelling", () => key("Escape")],
            ["going back", () => key("Enter")],
        ])("takes a key pressed while open where the machine is, and keeps it held on %s", (_, close) => {
            const ui = make();
            captured(3);
            frame();
            ui.open();
            ui.selectSnapshot(1);
            cpu.keyboardInterface.keyDown(keyCodes.A);
            close();
            expect(cpu.sysvia.hasAnyKeyDown()).toBe(true);
            expect(history.refusal()).toBeNull();
            expect(history.stepBack(false)).toBeNull();
        });

        it("closes, leaving the machine to its new state, when the state is replaced while it is open", () => {
            const ui = make();
            captured(2);
            ui.open();
            loop.dispatchEvent(new Event("replacing-state"));
            expect(panel().hidden).toBe(true);
            expect(resume).toHaveBeenCalledTimes(1);
            expect(ui.rewindBuffer.length).toBe(0);
        });

        it("takes AltGr-S, which types a character, for no key of its own", () => {
            const ui = make();
            captured(2);
            ui.open();
            key("ś", { code: "KeyS", altKey: true, ctrlKey: true });
            expect(panel().hidden).toBe(false);
            expect(loop.stop).not.toHaveBeenCalled();
        });

        it("stops listening for keys once closed", () => {
            const ui = make();
            captured(2);
            ui.open();
            key("Escape");
            const before = machineNow();
            key("ArrowLeft");
            expect(machineNow()).toEqual(before);
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
            expect(ui.frames.length).toBe(0);
        });
    });

    describe("capturing", () => {
        it("snapshots each frame into the slot of the oldest once the frames are full", () => {
            const ui = make();
            const snapshot = vi.spyOn(cpu, "snapshotState");
            for (let i = 0; i < 4; i++) frame();
            const taken = snapshot.mock.results.map(({ value }) => value);
            expect(snapshot.mock.calls.map(([options]) => options.into)).toEqual([null, null, null, taken[0]]);
            expect(ui.frames.getAll()).toEqual(taken.slice(1));
        });

        it("keeps a copy of the newest frame in the rewind history, in the storage of the one it replaces", () => {
            const ui = make();
            captured(30);
            const firstKept = ui.rewindBuffer.getAll()[0];
            captured(1);
            const newest = ui.rewindBuffer.peek();
            expect(newest).toEqual(ui.frames.peek());
            expect(newest.ram).toBe(firstKept.ram);
            expect(newest.ram).not.toBe(ui.frames.peek().ram);
        });

        it.each([
            ["the machine's state is replaced", () => loop.dispatchEvent(new Event("replacing-state"))],
            ["it is reset", (ui) => ui.reset()],
        ])("gives step back every snapshot in either ring, and forgets them all when %s", (_, forget) => {
            const ui = make();
            captured(31);
            const held = new Set([...ui.frames.getAll(), ...ui.rewindBuffer.getAll()]);
            expect(new Set(history.snapshots())).toEqual(held);
            forget(ui);
            expect([ui.frames.length, ui.rewindBuffer.length, history.snapshots()]).toEqual([0, 0, []]);
        });

        it("forgets from both rings the snapshots a step back left in the future", () => {
            const ui = make();
            captured(5);
            const [rewinds, frames] = [ui.rewindBuffer.getAll(), ui.frames.getAll()];
            const forgotten = new Set([...rewinds.slice(3), frames.at(-1)]);
            history.dispatchEvent(new CustomEvent("landed", { detail: { forgotten } }));
            expect(ui.rewindBuffer.getAll()).toEqual(rewinds.slice(0, 3));
            expect(ui.frames.getAll()).toEqual(frames.slice(0, 2));
        });
    });
});
