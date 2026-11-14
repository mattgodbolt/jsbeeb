import { describe, it, expect, beforeEach } from "vitest";

import { findModel } from "../../src/models.js";
import { Scheduler } from "../../src/scheduler.js";
import { TouchScreen } from "../../src/touchscreen.js";

/** Drain everything the touchscreen has to send. */
function readAll(touchScreen) {
    const bytes = [];
    for (;;) {
        const byte = touchScreen.tryReceive(true);
        if (byte < 0) return bytes;
        bytes.push(byte);
    }
}

/** Send a command string to the touchscreen, as the guest would over RS-423. */
function transmit(touchScreen, command) {
    for (const char of command) touchScreen.onTransmit(char.charCodeAt(0));
}

describe("TouchScreen", () => {
    let scheduler;
    let touchScreen;
    let pollCycles;

    beforeEach(() => {
        scheduler = new Scheduler();
        touchScreen = new TouchScreen(scheduler, findModel("B-DFS1.2").cyclesPerSecond);
        pollCycles = touchScreen.pollCycles;
    });

    const CentreX = [0x43, 0x4e];
    const CentreY = [0x43, 0x40];
    const Centre = [...CentreX, ...CentreY];
    const NotTouched = [0x4f, 0x4f];
    const ThreeNotTouched = [...NotTouched, ...NotTouched, ...NotTouched];
    const MultipleCentre = [...CentreX, ...ThreeNotTouched, ...CentreY, ...ThreeNotTouched];
    const EndOfReport = 0x2e;

    it.each([
        ["point mode", "M1?", true, [...Centre, EndOfReport]],
        ["point mode, not touched", "M1?", false, [...NotTouched, ...NotTouched, EndOfReport]],
        ["size mode", "M2?", true, [...Centre, EndOfReport]],
        ["multiple mode", "M3?", true, [...MultipleCentre, EndOfReport]],
        ["data dump mode, which is not emulated", "M0?", true, []],
        ["a continuous mode, which waits for its poll", "M131?", true, []],
    ])("answers a request in %s", (_, command, touched, expected) => {
        touchScreen.onMouse(0.5, 0.5, touched);
        transmit(touchScreen, command);

        expect(readAll(touchScreen)).toEqual(expected);
    });

    it.each([
        ["mode 129", "M129.", [...Centre, EndOfReport]],
        ["mode 130", "M130.", [...Centre, EndOfReport]],
        ["mode 131", "M131.", [...MultipleCentre, EndOfReport]],
    ])("reports each poll in %s", (_, command, expected) => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, command);

        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual(expected);
        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual(expected);
    });

    it("does not poll in other modes", () => {
        transmit(touchScreen, "M128.");

        scheduler.polltime(10 * pollCycles);
        expect(readAll(touchScreen)).toEqual([]);
    });

    it.each([
        ["just inside the grid's top left", 0.113, 0.114, [0x40, 0x40, 0x45, 0x49]],
        ["just inside the grid's bottom right", 0.852, 0.945, [0x47, 0x47, 0x40, 0x40]],
        ["outside the grid's top left", 0, 0, [0x40, 0x40, 0x45, 0x4a]],
        ["outside the grid's bottom right", 1, 1, [0x47, 0x48, 0x40, 0x40]],
    ])("scales a touch %s to the 120 by 90 grid", (_, x, y, expected) => {
        touchScreen.onMouse(x, y, true);
        transmit(touchScreen, "M1?");

        expect(readAll(touchScreen)).toEqual([...expected, EndOfReport]);
    });

    it("reports a press released between polls once", () => {
        transmit(touchScreen, "M129.");
        touchScreen.onMouse(0.5, 0.5, true);
        touchScreen.onMouse(0.5, 0.5, false);

        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual([...Centre, EndOfReport]);
        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual([...NotTouched, ...NotTouched, EndOfReport]);
    });

    it.each([
        ["before the guest selects a mode", (screen) => transmit(screen, "M129.")],
        ["before the guest changes mode", (screen) => transmit(screen, "M131.M129.")],
    ])("forgets a press made %s", (_, selectMode) => {
        touchScreen.onMouse(0.5, 0.5, true);
        touchScreen.onMouse(0.5, 0.5, false);
        selectMode(touchScreen);

        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual([...NotTouched, ...NotTouched, EndOfReport]);
    });

    it("holds off sending until RTS is asserted", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M1?");

        expect(touchScreen.tryReceive(false)).toBe(-1);
        expect(touchScreen.tryReceive(true)).toBe(0x43);
    });

    it("drops whole reports, not parts of them, while RTS is held off", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M131.");

        scheduler.polltime(10 * pollCycles);
        const report = [...MultipleCentre, EndOfReport];
        expect(readAll(touchScreen)).toEqual([...report, ...report, ...report]);
    });

    describe("snapshots", () => {
        /** Save the touchscreen and its scheduler, then restore both into a fresh machine. */
        function saveAndRestore() {
            const state = JSON.parse(
                JSON.stringify({ scheduler: scheduler.snapshotState(), touchScreen: touchScreen.snapshotState() }),
            );
            const newScheduler = new Scheduler();
            const newTouchScreen = new TouchScreen(newScheduler, findModel("B-DFS1.2").cyclesPerSecond);
            newScheduler.restoreState(state.scheduler);
            newTouchScreen.restoreState(state.touchScreen);
            return { scheduler: newScheduler, touchScreen: newTouchScreen };
        }

        it("keeps polling after a restore", () => {
            transmit(touchScreen, "M129.");
            const restored = saveAndRestore();
            restored.touchScreen.onMouse(0.5, 0.5, true);

            restored.scheduler.polltime(pollCycles);
            expect(readAll(restored.touchScreen)).toEqual([...Centre, EndOfReport]);

            restored.scheduler.polltime(pollCycles);
            expect(readAll(restored.touchScreen)).toEqual([...Centre, EndOfReport]);
        });

        it("resumes at the same point in the poll period", () => {
            transmit(touchScreen, "M130.");
            scheduler.polltime(pollCycles - 10);
            const restored = saveAndRestore();

            restored.scheduler.polltime(9);
            expect(readAll(restored.touchScreen)).toEqual([]);

            restored.scheduler.polltime(1);
            expect(readAll(restored.touchScreen)).toEqual([...NotTouched, ...NotTouched, EndOfReport]);
        });

        it("forgets a press made after the snapshot was taken", () => {
            transmit(touchScreen, "M129.");
            const state = { scheduler: scheduler.snapshotState(), touchScreen: touchScreen.snapshotState() };
            touchScreen.onMouse(0.5, 0.5, true);
            touchScreen.onMouse(0.5, 0.5, false);
            scheduler.restoreState(state.scheduler);
            touchScreen.restoreState(state.touchScreen);

            scheduler.polltime(pollCycles);
            expect(readAll(touchScreen)).toEqual([...NotTouched, ...NotTouched, EndOfReport]);
        });

        it("keeps bytes that were queued but not yet sent", () => {
            touchScreen.onMouse(0.5, 0.5, true);
            transmit(touchScreen, "M1?");
            expect(touchScreen.tryReceive(true)).toBe(0x43);

            const restored = saveAndRestore();
            expect(readAll(restored.touchScreen)).toEqual([...Centre.slice(1), EndOfReport]);
        });

        it("stays idle in a mode that does not poll", () => {
            transmit(touchScreen, "M128.");
            const restored = saveAndRestore();

            restored.scheduler.polltime(10 * pollCycles);
            expect(readAll(restored.touchScreen)).toEqual([]);
        });
    });
});
