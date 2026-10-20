// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibilitySwitches } from "../../src/web/accessibility-switches.js";
import { EmulationLoop, RunMode } from "../../src/web/emulation-loop.js";
import { KeyboardSetup } from "../../src/web/keyboard-setup.js";
import { domFromIndexHtml, sentEvents, teardownDom } from "./helpers.js";
import { TickMs } from "../../src/emulation-tick.js";
import { keyCodes } from "../../src/keymap.js";
import { findModel } from "../../src/models.js";

const ClocksPerSecond = 2000000;

const keyEvent = (type, code, { alt = false, ctrl = false, shift = false, repeat = false, key = "" } = {}) =>
    new KeyboardEvent(type, { code, key, altKey: alt, ctrlKey: ctrl, shiftKey: shift, repeat, cancelable: true });

const pasteEvent = (text) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    return event;
};

describe("KeyboardSetup", () => {
    let actions;
    let accessibilitySwitches;
    let processor;
    let dbgr;
    let loop;
    let setup;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = "";
        actions = {
            toggleFast: vi.fn(),
            openRewind: vi.fn(),
            openPrinter: vi.fn(),
            openMedia: vi.fn(),
            paste: vi.fn(),
            onAnyKeyDown: vi.fn(),
        };
        accessibilitySwitches = new AccessibilitySwitches();
        processor = {
            model: findModel("B-DFS1.2"),
            execute: vi.fn(() => true),
            stop: vi.fn(),
            tapeInterface: { motorOn: false },
            setReset: vi.fn(),
            scheduler: {
                newTask: () => ({
                    schedule: () => {},
                    cancel: () => {},
                    ensureScheduled: () => {},
                    scheduled: () => false,
                }),
            },
            sysvia: {
                keyDown: vi.fn(),
                keyUp: vi.fn(),
                keyDownRaw: vi.fn(),
                keyUpRaw: vi.fn(),
                clearKeys: vi.fn(),
                setKeyLayout: vi.fn(),
                keyboardEnabled: true,
            },
        };
        processor.keyboardInterface = processor.sysvia;
        dbgr = { debug: vi.fn(), hide: vi.fn(), keyPress: vi.fn(() => true) };
        loop = new EmulationLoop({
            processor,
            display: { setSpeedy: vi.fn(), takePaintMs: () => 0, present: vi.fn() },
            audioHandler: { mute: vi.fn(), unmute: vi.fn(), flushChipEvents: vi.fn() },
            dbgr,
            gamepad: { update: vi.fn() },
            clocksPerSecond: ClocksPerSecond,
            cpuSpeed: ClocksPerSecond,
            fastTape: false,
        });
        setup = new KeyboardSetup({ actions, accessibilitySwitches, processor, loop, dbgr, keyLayout: "physical" });
        loop.go();
    });

    // The loop's ticks rearm themselves, so teardownDom cannot run the timers out.
    afterEach(() => {
        vi.clearAllTimers();
        return teardownDom();
    });

    describe("the accessibility switches", () => {
        it("clears a bit while its switch is held", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);
            document.dispatchEvent(keyEvent("keyup", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xff);

            document.dispatchEvent(keyEvent("keydown", keyCodes.K8, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0x7f);
        });

        it("lets go of a switch when Alt is released before the digit", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);

            document.dispatchEvent(keyEvent("keyup", keyCodes.ALT_LEFT));
            document.dispatchEvent(keyEvent("keyup", keyCodes.K1));

            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });

        it("keeps a held switch's repeats away from the machine once Alt is let go", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            document.dispatchEvent(keyEvent("keyup", keyCodes.ALT_LEFT));
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { repeat: true }));

            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);
        });

        it("lets go of a switch held when the window loses focus", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.K2, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfd);

            setup.keyboard.clearKeys();

            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });

        it("leaves the function keys to the machine, so Alt-F4 is not a switch", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.F4, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });
    });

    describe("the shortcuts", () => {
        it.each([
            ["Alt-T", keyCodes.T, { alt: true }, "toggleFast"],
            ["Alt-W", keyCodes.W, { alt: true }, "openRewind"],
            ["Alt-B", keyCodes.B, { alt: true }, "openPrinter"],
        ])("%s fires %s on the way down only", (name, which, modifiers, action) => {
            document.dispatchEvent(keyEvent("keydown", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
            document.dispatchEvent(keyEvent("keyup", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
        });

        it("aims the media window from Alt-M, Alt-Shift-M and Alt-C", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith(0);
            document.dispatchEvent(keyEvent("keyup", keyCodes.M, { alt: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith(1);
            document.dispatchEvent(keyEvent("keydown", keyCodes.C, { alt: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith("tape");
            expect(actions.openMedia).toHaveBeenCalledTimes(3);
            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
        });

        it("does not start a held shortcut again when its repeats outlast a blur", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.T, { alt: true }));
            setup.keyboard.clearKeys();
            document.dispatchEvent(keyEvent("keydown", keyCodes.T, { alt: true, repeat: true }));

            expect(actions.toggleFast).toHaveBeenCalledTimes(1);
        });

        it("fires once however long the key is held", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.T, { alt: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.T, { alt: true, repeat: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.T, { alt: true, repeat: true }));

            expect(actions.toggleFast).toHaveBeenCalledTimes(1);
        });

        it("does nothing without the modifier", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.T));
            expect(actions.toggleFast).not.toHaveBeenCalled();
            expect(processor.sysvia.keyDown).toHaveBeenCalled();
        });

        it("tells the page about every key on the way down", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(actions.onAnyKeyDown).toHaveBeenCalledTimes(1);
        });
    });

    describe("pasting", () => {
        beforeEach(() => domFromIndexHtml("paste-form"));

        it("goes to the machine when nothing on the page has focus", () => {
            document.body.dispatchEvent(pasteEvent("PRINT 1\n"));
            expect(actions.paste).toHaveBeenCalledWith("PRINT 1\n");
        });

        it("goes to the machine from the paste box", () => {
            const box = document.getElementById("paste-text");
            box.focus();
            box.dispatchEvent(pasteEvent("*CAT"));
            expect(actions.paste).toHaveBeenCalledWith("*CAT");
        });

        it("ignores a paste event that carries no clipboard", () => {
            document.body.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
            expect(actions.paste).not.toHaveBeenCalled();
        });

        it("is left to any other field being typed into", () => {
            const field = document.body.appendChild(document.createElement("input"));
            field.focus();
            field.dispatchEvent(pasteEvent("not for the Beeb"));
            expect(actions.paste).not.toHaveBeenCalled();
        });
    });

    it("passes focus through a text field and back on a dead key", () => {
        domFromIndexHtml("ime-reset");
        const button = document.createElement("button");
        document.body.append(button);
        button.focus();
        const trail = [];
        const recordFocus = (evt) => trail.push(evt.target.tagName);
        document.body.addEventListener("focusin", recordFocus);

        document.dispatchEvent(keyEvent("keydown", keyCodes.APOSTROPHE, { key: "Dead", shift: true }));
        document.body.removeEventListener("focusin", recordFocus);

        expect(trail.slice(0, 2)).toEqual(["TEXTAREA", "BUTTON"]);
        expect(document.activeElement).toBe(button);
        expect(processor.sysvia.keyDown).toHaveBeenCalledWith(keyCodes.APOSTROPHE, true);
    });

    describe("where keys go", () => {
        it("reach the machine from the page at large, but not from the media window", () => {
            domFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
            document.getElementById("media-close").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
        });

        it("aims the media window from inside it, where the search box has focus", () => {
            domFromIndexHtml("media-panel");
            document.getElementById("media-search").focus();

            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.C, { alt: true }));

            expect(actions.openMedia).toHaveBeenCalledWith(1);
            expect(actions.openMedia).toHaveBeenCalledWith("tape");
            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
        });

        it("leaves the paste box every key, where Alt and a letter types an accented one on a Mac", () => {
            domFromIndexHtml("paste-form");
            document.getElementById("paste-text").focus();

            document.dispatchEvent(keyEvent("keydown", keyCodes.C, { alt: true }));

            expect(actions.openMedia).not.toHaveBeenCalled();
        });

        it("leaves a debugger goto box its g, which elsewhere resumes the machine", () => {
            domFromIndexHtml("debug");
            loop.stop(true);
            const typeG = () => setup.keyPress(new KeyboardEvent("keypress", { key: "g", cancelable: true }));

            document.querySelector("#goto-dis-addr-form .goto-addr").focus();
            typeG();
            expect(loop.mode).toBe(RunMode.debugging);

            document.activeElement.blur();
            typeG();
            expect(loop.mode).toBe(RunMode.running);
        });

        it("keeps a held shortcut's repeats out of the media window it just opened", () => {
            domFromIndexHtml("media-panel");
            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));

            const repeat = keyEvent("keydown", keyCodes.M, { alt: true, shift: true, repeat: true });
            document.dispatchEvent(repeat);

            expect(repeat.defaultPrevented).toBe(true);
        });

        it("lets go of an accessibility switch held while focus moved into the window", () => {
            domFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);

            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keyup", keyCodes.K1, { alt: true }));

            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });

        it("releases a key that was held while Alt-Shift-M moved focus into the window", () => {
            domFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.SHIFT_LEFT, { shift: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));
            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keyup", keyCodes.M, { alt: true, shift: true }));
            document.dispatchEvent(keyEvent("keyup", keyCodes.SHIFT_LEFT));
            expect(processor.sysvia.keyUp).toHaveBeenCalledWith(keyCodes.SHIFT_LEFT);
            expect(processor.sysvia.keyUp).not.toHaveBeenCalledWith(keyCodes.M);
        });
    });

    describe("running and stopping", () => {
        const altP = () => setup.keyboard.keyDown(keyEvent("keydown", keyCodes.P, { alt: true }));
        const altS = () => setup.keyboard.keyDown(keyEvent("keydown", keyCodes.S, { alt: true }));
        const type = (key) => {
            const event = new KeyboardEvent("keypress", { key, cancelable: true });
            setup.keyPress(event);
            return event;
        };
        const frame = () => vi.advanceTimersByTime(2 * TickMs);
        const pauseNotes = (sent) => sent("feature_used").map(({ action }) => action);

        it("Alt-P pauses a running machine and runs a paused one", () => {
            altP();
            expect(loop.mode).toBe(RunMode.paused);
            altP();
            expect(loop.mode).toBe(RunMode.running);
        });

        it("Alt-S shows the debugger and hides it again, running the machine", () => {
            altS();
            expect(loop.mode).toBe(RunMode.debugging);
            expect(dbgr.debug).toHaveBeenCalled();
            altS();
            expect(loop.mode).toBe(RunMode.running);
        });

        it("while paused, n runs one frame and stays paused", () => {
            altP();
            processor.execute.mockClear();
            type("n");
            expect(loop.mode).toBe(RunMode.stepping);
            frame();
            frame();
            expect(loop.mode).toBe(RunMode.paused);
            expect(processor.execute).toHaveBeenCalledTimes(1);
        });

        it("in the debugger, g runs the machine and every other key is the debugger's", () => {
            altS();
            const n = type("n");
            expect(dbgr.keyPress).toHaveBeenCalledWith("n");
            expect(n.defaultPrevented).toBe(true);
            expect(loop.mode).toBe(RunMode.debugging);
            type("g");
            expect(loop.mode).toBe(RunMode.running);
        });

        it("hands n to the debugger when it is shown over a pause", () => {
            altP();
            altS();
            processor.execute.mockClear();
            document.dispatchEvent(new KeyboardEvent("keypress", { key: "n", cancelable: true }));
            frame();
            expect(dbgr.keyPress).toHaveBeenCalledWith("n");
            expect(loop.mode).toBe(RunMode.debugging);
            expect(processor.execute).not.toHaveBeenCalled();
        });

        it("leaves typed characters alone while the machine runs", () => {
            const g = type("g");
            type("n");
            expect(loop.mode).toBe(RunMode.running);
            expect(dbgr.keyPress).not.toHaveBeenCalled();
            expect(g.defaultPrevented).toBe(false);
        });

        it.each([
            ["Alt-P", () => altP()],
            ["g", () => type("g")],
            ["Alt-S twice", () => (altS(), altS())],
            ["Alt-S, then the debugger's g", () => (altS(), type("g"))],
            ["a step, then g", () => (type("n"), frame(), frame(), type("g"))],
            ["the play button or the menu's resume", () => loop.go()],
        ])("notes a pause left by %s, and the next pause entered", (_name, leave) => {
            const sent = sentEvents();
            altP();
            leave();
            expect(loop.mode).toBe(RunMode.running);
            altP();
            expect(pauseNotes(sent)).toEqual(["enter", "leave", "enter"]);
        });

        it("runs freely after a step stopped by the debugger before its frame", () => {
            const sent = sentEvents();
            altP();
            type("n");
            altS();
            type("g");
            frame();
            frame();
            expect(loop.mode).toBe(RunMode.running);
            expect(loop.isRunning()).toBe(true);
            expect(pauseNotes(sent)).toEqual(["enter", "leave"]);
        });

        it("notes nothing for Alt-P out of the debugger", () => {
            const sent = sentEvents();
            altS();
            altP();
            expect(loop.mode).toBe(RunMode.running);
            expect(dbgr.hide).toHaveBeenCalled();
            expect(sent("feature_used")).toEqual([]);
        });

        it("notes no key presses, from the shortcuts or Break", () => {
            const sent = sentEvents();
            for (const code of [keyCodes.S, keyCodes.T, keyCodes.W]) {
                setup.keyboard.keyDown(keyEvent("keydown", code, { alt: true }));
            }
            setup.keyboard.keyDown(keyEvent("keydown", keyCodes.F12));
            expect(sent("keyboard")).toEqual([]);
        });
    });
});
