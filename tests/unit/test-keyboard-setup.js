// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeyboardSetup } from "../../src/web/keyboard-setup.js";
import * as utils from "../../src/utils.js";

const keyEvent = (type, which, { alt = false, ctrl = false } = {}) => {
    const event = new KeyboardEvent(type, { altKey: alt, ctrlKey: ctrl, cancelable: true });
    Object.defineProperty(event, "which", { value: which });
    return event;
};

describe("KeyboardSetup", () => {
    let actions;
    let setup;

    beforeEach(() => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        document.body.innerHTML = "";
        actions = {
            enterDebugger: vi.fn(),
            reload: vi.fn(),
            toggleFast: vi.fn(),
            openRewind: vi.fn(),
            openPrinter: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            onAnyKeyDown: vi.fn(),
        };
        setup = new KeyboardSetup(actions);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    const attach = () => {
        const processor = {
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
        setup.attach({ processor, dbgr: {}, keyLayout: "physical" });
        setup.setRunning(true);
        return processor;
    };

    describe("the user port", () => {
        it("reads as no switches pressed to begin with", () => {
            expect(setup.userPort.read()).toBe(0xff);
        });

        it("clears a bit while its switch is held, keys and function keys alike", () => {
            attach();
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.K1, { alt: true }));
            expect(setup.userPort.read()).toBe(0xfe);
            document.dispatchEvent(keyEvent("keyup", utils.keyCodes.K1, { alt: true }));
            expect(setup.userPort.read()).toBe(0xff);

            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.F8, { alt: true }));
            expect(setup.userPort.read()).toBe(0x7f);
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
            attach();
            document.dispatchEvent(keyEvent("keydown", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
            document.dispatchEvent(keyEvent("keyup", which, modifiers));
            expect(actions[action]).toHaveBeenCalledTimes(1);
        });

        it("does nothing without the modifier", () => {
            const processor = attach();
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.S));
            expect(actions.enterDebugger).not.toHaveBeenCalled();
            expect(processor.sysvia.keyDown).toHaveBeenCalled();
        });

        it("tells the page about every key on the way down", () => {
            attach();
            document.dispatchEvent(keyEvent("keydown", utils.keyCodes.A));
            expect(actions.onAnyKeyDown).toHaveBeenCalledTimes(1);
        });
    });

    describe("the keyboard's own events", () => {
        it("routes pause and resume to the loop's actions", () => {
            attach();
            setup.keyboard.dispatchEvent(new CustomEvent("pause"));
            setup.keyboard.dispatchEvent(new CustomEvent("resume"));
            expect(actions.pause).toHaveBeenCalledTimes(1);
            expect(actions.resume).toHaveBeenCalledTimes(1);
        });
    });

    describe("before the keyboard exists", () => {
        it("swallows raw keys with a warning rather than throwing", () => {
            expect(() => setup.sendRawKeyboard([1000], false)).not.toThrow();
            expect(console.warn).toHaveBeenCalled();
        });
    });
});
