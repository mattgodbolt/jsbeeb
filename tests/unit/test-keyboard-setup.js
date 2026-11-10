// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibilitySwitches } from "../../src/web/accessibility-switches.js";
import { RunMode } from "../../src/web/emulation-loop.js";
import { KeyboardSetup } from "../../src/web/keyboard-setup.js";
import { PanelKeys } from "../../src/web/panel-keys.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";
import { fakeKeyboardProcessor } from "../helpers/fake-keyboard-processor.js";
import { keyCodes } from "../../src/keymap.js";

const keyEvent = (type, code, { alt = false, ctrl = false, shift = false, repeat = false, key = "" } = {}) =>
    new KeyboardEvent(type, { code, key, altKey: alt, ctrlKey: ctrl, shiftKey: shift, repeat, cancelable: true });

const pasteEvent = (text) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    return event;
};

/** A panel from index.html, shown, since an element inside a hidden one cannot take focus. */
const showFromIndexHtml = (id) => {
    domFromIndexHtml(id);
    document.getElementById(id).hidden = false;
};

/** An EmulationLoop's run mode and the calls that change it, and nothing else. */
function stubLoop() {
    const loop = { mode: RunMode.running, isRunning: () => loop.mode === RunMode.running };
    loop.go = vi.fn(() => (loop.mode = RunMode.running));
    loop.stop = vi.fn((debugging) => (loop.mode = debugging ? RunMode.debugging : RunMode.paused));
    loop.step = vi.fn(() => (loop.mode = RunMode.stepping));
    return loop;
}

describe("KeyboardSetup", () => {
    let actions;
    let accessibilitySwitches;
    let processor;
    let dbgr;
    let keys;
    let loop;
    let setup;

    beforeEach(() => {
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
        processor = fakeKeyboardProcessor();
        dbgr = { toggleDebugger: vi.fn(), togglePanels: vi.fn() };
        keys = new PanelKeys(new PanelArrangement(() => window.localStorage));
        loop = stubLoop();
        setup = new KeyboardSetup({
            actions,
            accessibilitySwitches,
            processor,
            loop,
            dbgr,
            keys,
            keyLayout: "physical",
        });
    });

    afterEach(teardownDom);

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

        it("leaves the function keys to the machine, so Alt-F4 is not a switch", () => {
            document.dispatchEvent(keyEvent("keydown", keyCodes.F4, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });
    });

    describe("the shortcuts", () => {
        it.each([
            ["Alt-T", keyCodes.T, {}, "toggleFast", []],
            ["Alt-W", keyCodes.W, {}, "openRewind", []],
            ["Alt-B", keyCodes.B, {}, "openPrinter", []],
            ["Alt-M", keyCodes.M, {}, "openMedia", [0]],
            ["Alt-Shift-M", keyCodes.M, { shift: true }, "openMedia", [1]],
            ["Alt-C", keyCodes.C, {}, "openMedia", ["tape"]],
        ])("%s calls %s on the way down only, keeping the key from the machine", (_, code, modifiers, action, args) => {
            document.dispatchEvent(keyEvent("keydown", code, { alt: true, ...modifiers }));
            document.dispatchEvent(keyEvent("keyup", code, { alt: true, ...modifiers }));
            expect(actions[action].mock.calls).toEqual([args]);
            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
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

        const focusedInput = (type) => {
            const input = document.body.appendChild(document.createElement("input"));
            input.type = type;
            input.focus();
            return input;
        };

        it.each([
            ["the page at large", true, () => document.body],
            ["the paste box", true, () => document.getElementById("paste-text")],
            ["a control that takes no typing", true, () => focusedInput("checkbox")],
            ["any other field being typed into", false, () => focusedInput("text")],
        ])("from %s goes to the machine: %s", (_, reaches, target) => {
            const from = target();
            from.focus();
            from.dispatchEvent(pasteEvent("*CAT"));
            expect(actions.paste.mock.calls).toEqual(reaches ? [["*CAT"]] : []);
        });

        it("ignores a paste event that carries no clipboard", () => {
            document.body.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
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
            showFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
            document.getElementById("media-close").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
        });

        it("reach the page from the watch panel's add box, and the machine from the rest of the panel", () => {
            showFromIndexHtml("watch-panel");
            document.getElementById("watch-add").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).not.toHaveBeenCalled();
            document.getElementById("watch-close").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.A));
            expect(processor.sysvia.keyDown).toHaveBeenCalledTimes(1);
        });

        it("aims the media window from inside it, where the search box has focus", () => {
            showFromIndexHtml("media-panel");
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

        describe("the pause's and the debugger's keys", () => {
            const typeKey = (key) => setup.keyPress(new KeyboardEvent("keypress", { key, cancelable: true }));

            it.each([
                ["g", "a panel's text field", "watch-panel", "#watch-add", RunMode.paused, "go"],
                ["g", "the session dialog's name box", "session-dialog", "#session-name", RunMode.paused, "go"],
                ["n", "the session dialog's name box", "session-dialog", "#session-name", RunMode.paused, "step"],
            ])("%s stays in %s, and drives the machine from elsewhere", (key, _, from, field, mode, call) => {
                showFromIndexHtml(from);
                loop.mode = mode;

                document.querySelector(field).focus();
                typeKey(key);
                expect(loop.mode).toBe(mode);

                expect(loop[call]).not.toHaveBeenCalled();

                document.activeElement.blur();
                typeKey(key);
                expect(loop[call]).toHaveBeenCalledTimes(1);
            });

            it("leaves a panel's letters to a field being typed into", () => {
                const down = vi.fn();
                keys.register({
                    table: [{ key: "j", run: "down" }],
                    actions: { down },
                    isLive: () => true,
                    panel: null,
                });
                domFromIndexHtml("session-dialog");
                loop.mode = RunMode.debugging;
                document.getElementById("session-name").focus();

                const j = new KeyboardEvent("keypress", { key: "j", cancelable: true });
                setup.keyPress(j);

                expect(down).not.toHaveBeenCalled();
                expect(j.defaultPrevented).toBe(false);
            });

            it("still resumes the machine from a control that takes no typing", () => {
                domFromIndexHtml("speaker-amount");
                loop.mode = RunMode.paused;
                document.getElementById("speaker-amount").focus();
                typeKey("g");
                expect(loop.mode).toBe(RunMode.running);
            });
        });

        it("keeps a held shortcut's repeats out of the media window it just opened", () => {
            showFromIndexHtml("media-panel");
            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keydown", keyCodes.M, { alt: true, shift: true }));

            const repeat = keyEvent("keydown", keyCodes.M, { alt: true, shift: true, repeat: true });
            document.dispatchEvent(repeat);

            expect(repeat.defaultPrevented).toBe(true);
        });

        it("lets go of an accessibility switch held while focus moved into the window", () => {
            showFromIndexHtml("media-panel");
            document.dispatchEvent(keyEvent("keydown", keyCodes.K1, { alt: true }));
            expect(accessibilitySwitches.userPort.read()).toBe(0xfe);

            document.getElementById("media-search").focus();
            document.dispatchEvent(keyEvent("keyup", keyCodes.K1, { alt: true }));

            expect(accessibilitySwitches.userPort.read()).toBe(0xff);
        });

        it("releases a key that was held while Alt-Shift-M moved focus into the window", () => {
            showFromIndexHtml("media-panel");
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
        const inputs = {
            "Alt-P": () => document.dispatchEvent(keyEvent("keydown", keyCodes.P, { alt: true })),
            g: () => document.dispatchEvent(new KeyboardEvent("keypress", { key: "g", cancelable: true })),
            n: () => document.dispatchEvent(new KeyboardEvent("keypress", { key: "n", cancelable: true })),
        };
        const loopCalls = () => ({ go: loop.go.mock.calls, stop: loop.stop.mock.calls, step: loop.step.mock.calls });
        const only = (call, ...args) => ({ go: [], stop: [], step: [], ...(call && { [call]: [args] }) });

        it.each([
            [RunMode.running, "Alt-P", only("stop", false)],
            [RunMode.running, "g", only()],
            [RunMode.running, "n", only()],
            [RunMode.paused, "Alt-P", only("go")],
            [RunMode.paused, "g", only("go")],
            [RunMode.paused, "n", only("step")],
            [RunMode.debugging, "Alt-P", only("go")],
            [RunMode.debugging, "g", only()],
            [RunMode.debugging, "n", only()],
        ])("while %s, %s calls the loop's %o", (mode, input, expected) => {
            loop.mode = mode;
            inputs[input]();
            expect(loopCalls()).toEqual(expected);
        });

        it.each([
            ["Alt-S", keyCodes.S, "toggleDebugger"],
            ["Alt-D", keyCodes.D, "togglePanels"],
        ])("%s asks the debugger, whatever the machine is doing", (_, code, call) => {
            for (const mode of [RunMode.running, RunMode.paused, RunMode.debugging]) {
                loop.mode = mode;
                document.dispatchEvent(keyEvent("keydown", code, { alt: true }));
                document.dispatchEvent(keyEvent("keyup", code, { alt: true }));
            }
            expect(dbgr[call]).toHaveBeenCalledTimes(3);
            expect(loopCalls()).toEqual(only());
        });

        describe("a panel's keys", () => {
            let down;
            beforeEach(() => {
                down = vi.fn();
                keys.register({
                    table: [{ key: "j", run: "down" }],
                    actions: { down },
                    isLive: () => true,
                    panel: null,
                });
            });
            const press = (key) => {
                const event = new KeyboardEvent("keypress", { key, cancelable: true });
                document.dispatchEvent(event);
                return event;
            };

            it("leave every key to the machine while it runs", () => {
                expect(press("j").defaultPrevented).toBe(false);
                expect(down).not.toHaveBeenCalled();
            });

            it.each([RunMode.paused, RunMode.debugging])("answer while %s, taking the key from the page", (mode) => {
                loop.mode = mode;
                expect(press("j").defaultPrevented).toBe(true);
                expect(down).toHaveBeenCalledTimes(1);
            });

            it("leave a key nobody binds to the page", () => {
                loop.mode = RunMode.debugging;
                expect(press("q").defaultPrevented).toBe(false);
            });
        });
    });
});
