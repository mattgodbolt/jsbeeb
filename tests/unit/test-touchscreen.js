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

    it("polls repeatedly once the guest selects mode 129", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M129.");

        scheduler.polltime(pollCycles);
        // Centre of the screen, with the button down.
        expect(readAll(touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);

        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);
    });

    it("reports nothing touched before the mouse is ever moved", () => {
        transmit(touchScreen, "M130.");

        scheduler.polltime(pollCycles);
        expect(readAll(touchScreen)).toEqual([0x4f, 0x4f, 0x4f, 0x4f, 0x2e]);
    });

    it("does not poll in other modes", () => {
        transmit(touchScreen, "M128.");

        scheduler.polltime(10 * pollCycles);
        expect(readAll(touchScreen)).toEqual([]);
    });

    it("responds to a single-shot read request in mode 1", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M1?");

        expect(readAll(touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);
    });

    it("holds off sending until RTS is asserted", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M1?");

        expect(touchScreen.tryReceive(false)).toBe(-1);
        expect(touchScreen.tryReceive(true)).toBe(0x43);
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
            expect(readAll(restored.touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);

            restored.scheduler.polltime(pollCycles);
            expect(readAll(restored.touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);
        });

        it("resumes at the same point in the poll period", () => {
            transmit(touchScreen, "M130.");
            scheduler.polltime(pollCycles - 10);
            const restored = saveAndRestore();

            restored.scheduler.polltime(9);
            expect(readAll(restored.touchScreen)).toEqual([]);

            restored.scheduler.polltime(1);
            expect(readAll(restored.touchScreen)).toEqual([0x4f, 0x4f, 0x4f, 0x4f, 0x2e]);
        });

        it("keeps bytes that were queued but not yet sent", () => {
            touchScreen.onMouse(0.5, 0.5, true);
            transmit(touchScreen, "M1?");
            expect(touchScreen.tryReceive(true)).toBe(0x43);

            const restored = saveAndRestore();
            expect(readAll(restored.touchScreen)).toEqual([0x4c, 0x43, 0x42, 0x2e]);
        });

        it("stays idle in a mode that does not poll", () => {
            transmit(touchScreen, "M128.");
            const restored = saveAndRestore();

            restored.scheduler.polltime(10 * pollCycles);
            expect(readAll(restored.touchScreen)).toEqual([]);
        });
    });
});
