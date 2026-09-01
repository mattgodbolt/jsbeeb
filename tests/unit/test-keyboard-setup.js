// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibilitySwitches } from "../../src/web/accessibility-switches.js";
import { KeyboardSetup } from "../../src/web/keyboard-setup.js";
import * as utils from "../../src/utils.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const keyEvent = (type, which, { alt = false, ctrl = false } = {}) => {
    const event = new KeyboardEvent(type, { altKey: alt, ctrlKey: ctrl, cancelable: true });
    Object.defineProperty(event, "which", { value: which });
    return event;
};

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
            pause: vi.fn(),
            resume: vi.fn(),
            paste: vi.fn(),
            onAnyKeyDown: vi.fn(),
        };
        accessibilitySwitches = new AccessibilitySwitches();
        processor = {
            model: { isAtom: false },
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
        setup = new KeyboardSetup({ actions, accessibilitySwitches, processor, dbgr: {}, keyLayout: "physical" });
        setup.setRunning(true);
    });

    afterEach(teardownDom);

    describe("the accessibility switches", () => {
        it("clears a bit while its switch is held, keys and function keys alike", () => {
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);
            document.dispatchEvent(keyEvent("keyup", utils.keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xff);

            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.F8, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0x7f);
        });
    });

    describe("the shortcuts", () => {
        it.each([
            ["Alt-S", utils.keyCodes.S, { alt: true }, "enterDebugger"],
            ["Ctrl-Home", utils.keyCodes.HOME, { ctrl: true }, "enterDebugger"],
            ["Alt-R", utils.keyCodes.R, { alt: true }, "reload"],
            ["Ctrl-Insert", utils.keyCodes.INSERT, { ctrl: true }, "toggleFast"],
            ["Alt-PageDown", utils.keyCodes.PAGEDOWN, { alt: true }, "openRewind"],
            ["Ctrl-B", utils.keyCodes.B, { ctrl: true }, "openPrinter"],
        ])("%s fires %s on the way down only", (name, which, modifiers, action) => {
            document.dispatchEvent(keyEvent("keydown", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
            document.dispatchEvent(keyEvent("keyup", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
        });

        it("does nothing without the modifier", () => {
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.S));
            expect(actions.enterDebugger).not.toHaveBeenCalled();
            expect(processor.sysvia.keyDown).toHaveBeenCalled();
        });

        it("tells the page about every key on the way down", () => {
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.A));
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

        it("is left to any other field being typed into", () => {
            const field = document.body.appendChild(document.createElement("input"));
            field.focus();
            field.dispatchEvent(pasteEvent("not for the Beeb"));
            expect(actions.paste).not.toHaveBeenCalled();
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
