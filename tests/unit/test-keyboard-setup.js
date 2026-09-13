// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibilitySwitches } from "../../src/web/accessibility-switches.js";
import { KeyboardSetup } from "../../src/web/keyboard-setup.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";
import { keyCodes } from "../../src/keymap.js";
import { findModel } from "../../src/models.js";

const keyEvent = (type, code, { alt = false, ctrl = false, shift = false } = {}) =>
    new KeyboardEvent(type, { code, altKey: alt, ctrlKey: ctrl, shiftKey: shift, cancelable: true });

const pasteEvent = (text) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    return event;
};

describe("KeyboardSetup", () => {
    let actions;
    let accessibilitySwitches;
    let processor;
    let setup;

    beforeEach(() => {
        document.body.innerHTML = "";
        actions = {
            enterDebugger: vi.fn(),
            reload: vi.fn(),
            toggleFast: vi.fn(),
            openRewind: vi.fn(),
            openPrinter: vi.fn(),
            openMedia: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            paste: vi.fn(),
            onAnyKeyDown: vi.fn(),
        };
        accessibilitySwitches = new AccessibilitySwitches();
        processor = {
            model: findModel("B-DFS1.2"),
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
        setup = new KeyboardSetup({ actions, accessibilitySwitches, processor, dbgr: {}, keyLayout: "physical" });
        setup.keyboard.setRunning(true);
    });

    afterEach(teardownDom);

    describe("the accessibility switches", () => {
        it("clears a bit while its switch is held, keys and function keys alike", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);
            document.dispatchEvent(keyEvent("keyup", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xff);

            document.dispatchEvent(keyEvent("keydown", keyCodes.F8, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0x7f);
        });
    });

    describe("the shortcuts", () => {
        it.each([
            ["Alt-S", keyCodes.S, { alt: true }, "enterDebugger"],
            ["Ctrl-Home", keyCodes.HOME, { ctrl: true }, "enterDebugger"],
            ["Alt-R", keyCodes.R, { alt: true }, "reload"],
            ["Ctrl-Insert", keyCodes.INSERT, { ctrl: true }, "toggleFast"],
            ["Alt-PageDown", keyCodes.PAGEDOWN, { alt: true }, "openRewind"],
            ["Ctrl-B", keyCodes.B, { ctrl: true }, "openPrinter"],
        ])("%s fires %s on the way down only", (name, which, modifiers, action) => {
            document.dispatchEvent(keyEvent("keydown", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
            document.dispatchEvent(keyEvent("keyup", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
        });

        it("aims the media window from Alt-M, Alt-Shift-M and Alt-C", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith(0);
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith(1);
            document.dispatchEvent(keyEvent("keydown", keyCodes.C, { alt: true }));
            expect(actions.openMedia).toHaveBeenLastCalledWith("tape");
            expect(actions.openMedia).toHaveBeenCalledTimes(3);
            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
        });

        it("does nothing without the modifier", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.S));
            expect(actions.enterDebugger).not.toHaveBeenCalled();
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

    describe("where keys go", () => {
        it("reach the machine from the page at large, but not from the media window", () => {
            domFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
            document.getElementById("media-close").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
        });

        it("releases a key that was held while Alt-Shift-M moved focus into the window", () => {
            domFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.SHIFT_LEFT, { shift: true }));
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));
            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keyup", keyCodes.M, { alt: true, shift: true }));
            document.dispatchEvent(keyEvent("keyup", keyCodes.SHIFT_LEFT));
            expect(processor.sysvia.keyUp).toHaveBeenCalledWith(keyCodes.M);
            expect(processor.sysvia.keyUp).toHaveBeenCalledWith(keyCodes.SHIFT_LEFT);
        });
    });

    describe("the keyboard's own events", () => {
        it("routes pause and resume to the loop's actions", () => {
            setup.keyboard.dispatchEvent(new CustomEvent("pause"));
            setup.keyboard.dispatchEvent(new CustomEvent("resume"));
            expect(actions.pause).toHaveBeenCalledTimes(1);
            expect(actions.resume).toHaveBeenCalledTimes(1);
        });
    });
});
