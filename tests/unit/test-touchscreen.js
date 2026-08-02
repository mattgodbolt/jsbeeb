import { describe, it, expect, beforeEach } from "vitest";

import { Scheduler } from "../../src/scheduler.js";
import { TouchScreen, PollCycles } from "../../src/touchscreen.js";

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

    beforeEach(() => {
        scheduler = new Scheduler();
        touchScreen = new TouchScreen(scheduler);
    });

    it("polls repeatedly once the guest selects mode 129", () => {
        touchScreen.onMouse(0.5, 0.5, true);
        transmit(touchScreen, "M129.");

        scheduler.polltime(PollCycles);
        // Centre of the screen, with the button down.
        expect(readAll(touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);

        scheduler.polltime(PollCycles);
        expect(readAll(touchScreen)).toEqual([0x43, 0x4c, 0x43, 0x42, 0x2e]);
    });

    it("reports nothing touched before the mouse is ever moved", () => {
        transmit(touchScreen, "M130.");

        scheduler.polltime(PollCycles);
        expect(readAll(touchScreen)).toEqual([0x4f, 0x4f, 0x4f, 0x4f, 0x2e]);
    });

    it("does not poll in other modes", () => {
        transmit(touchScreen, "M128.");

        scheduler.polltime(10 * PollCycles);
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
});
