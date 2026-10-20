import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/web/keyboard.js";
import { ATOM, stringToATOMKeys } from "../../src/keymap-atom.js";
import { BBC, keyCodes, userKeymap } from "../../src/keymap.js";
import { fakeKeyboardProcessor } from "../helpers/fake-keyboard-processor.js";

describe("Keyboard", () => {
    let keyboard;
    let mockProcessor;
    let mockSysvia;
    let mockInputEnabledFunction;
    let resetInputMethod;
    let running;

    const keyEvent = (code, key = "", extra = {}) => ({
        code,
        key,
        preventDefault: vi.fn(),
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...extra,
    });
    const breakKey = () => keyEvent(keyCodes.F12, "F12");

    beforeEach(() => {
        mockProcessor = fakeKeyboardProcessor();
        mockSysvia = mockProcessor.sysvia;

        mockInputEnabledFunction = vi.fn().mockReturnValue(false);
        running = false;
        resetInputMethod = vi.fn();

        keyboard = new Keyboard({
            processor: mockProcessor,
            inputEnabledFunction: mockInputEnabledFunction,
            runningFunction: () => running,
            resetInputMethodFunction: resetInputMethod,
            keyLayout: "physical",
        });
    });

    describe("in a shared session", () => {
        let input;
        beforeEach(() => {
            input = { keyDown: vi.fn(), keyUp: vi.fn(), setReset: vi.fn(), clearKeys: vi.fn() };
            running = true;
            keyboard.setInput(input);
            mockSysvia.clearKeys.mockClear();
        });

        test("sends keys and BREAK to the session, not the machine", () => {
            keyboard.keyDown(keyEvent(keyCodes.A));
            keyboard.keyUp(keyEvent(keyCodes.A));
            keyboard.keyDown(breakKey());
            keyboard.keyUp(breakKey());
            expect(input.keyDown).toHaveBeenCalledWith(keyCodes.A, false);
            expect(input.keyUp).toHaveBeenCalledWith(keyCodes.A);
            expect(input.setReset.mock.calls).toEqual([[true], [false]]);
            expect(mockSysvia.keyDown).not.toHaveBeenCalled();
            expect(mockProcessor.setReset).not.toHaveBeenCalled();
        });

        test("lets go of only this person's keys when clearing", () => {
            keyboard.keyDown(keyEvent(keyCodes.A));
            keyboard.clearKeys();
            expect(input.keyUp).toHaveBeenCalledWith(keyCodes.A);
            expect(mockSysvia.clearKeys).not.toHaveBeenCalled();
        });

        test("goes straight to the machine again once the session is over, with nothing held", () => {
            keyboard.setInput(null);
            expect(mockSysvia.clearKeys).toHaveBeenCalled();
            keyboard.keyDown(keyEvent(keyCodes.A));
            expect(mockSysvia.keyDown).toHaveBeenCalledWith(keyCodes.A, false);
        });
    });

    describe("in the natural layout", () => {
        beforeEach(() => {
            keyboard.setKeyLayout("natural");
            running = true;
            mockSysvia.keyDown.mockClear();
            mockSysvia.keyUp.mockClear();
        });

        test("sends the character the host produced, not the key's position", () => {
            // A Dvorak keyboard types a hyphen where a QWERTY one has the apostrophe.
            keyboard.keyDown(keyEvent("Quote", "-"));

            expect(mockSysvia.keyDown).toHaveBeenCalledWith("-", false);
        });

        test("releases what the press sent, even once the character has changed", () => {
            keyboard.keyDown(keyEvent("Digit2", '"', { shiftKey: true }));
            // Shift let go first, so the release reports the unshifted character.
            keyboard.keyUp(keyEvent("Digit2", "2"));

            expect(mockSysvia.keyUp).toHaveBeenCalledWith('"');
        });

        test("still names keys that print nothing by where they are", () => {
            keyboard.keyDown(keyEvent("ArrowLeft", "ArrowLeft"));

            expect(mockSysvia.keyDown).toHaveBeenCalledWith("ArrowLeft", false);
        });

        test("leaves jsbeeb's own shortcuts on the physical key", () => {
            const handler = vi.fn();
            keyboard.registerKeyHandler(keyCodes.S, handler, { alt: true, ctrl: false });

            keyboard.keyDown(keyEvent("KeyS", "s", { altKey: true }));

            expect(handler).toHaveBeenCalledWith(true, "KeyS", false);
            expect(mockSysvia.keyDown).not.toHaveBeenCalled();
        });

        test("keeps the character it started with while a key auto-repeats", () => {
            keyboard.keyDown(keyEvent("Digit6", "^", { shiftKey: true }));
            // Shift let go while the key stays down: the repeats report the plain character.
            keyboard.keyDown(keyEvent("Digit6", "6", { repeat: true }));
            keyboard.keyUp(keyEvent("Digit6", "6"));

            expect(mockSysvia.keyDown).toHaveBeenCalledTimes(1);
            expect(mockSysvia.keyDown).toHaveBeenCalledWith("^", true);
            expect(mockSysvia.keyUp).toHaveBeenCalledWith("^");
        });

        test("gives a KEY. parameter its key by position, over the character", () => {
            userKeymap.push({ native: "K1", key: "COPY" });
            try {
                keyboard.keyDown(keyEvent("Digit1", "1"));

                expect(mockSysvia.keyDown).toHaveBeenCalledWith("Digit1", false);
            } finally {
                userKeymap.length = 0;
            }
        });

        test("releases a held key by its old name when the layout changes under it", () => {
            keyboard.keyDown(keyEvent("Digit2", '"', { shiftKey: true }));
            keyboard.setKeyLayout("physical");

            expect(mockSysvia.keyUp).toHaveBeenCalledWith('"');
        });
    });

    test("brings the machine out of reset when Break is released after it stopped", () => {
        const evt = breakKey();
        running = true;
        keyboard.keyDown(evt);
        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(true);

        running = false;
        keyboard.keyUp(evt);

        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(false);
    });

    test("brings the machine out of reset when the window loses focus with Break held", () => {
        const evt = breakKey();
        running = true;
        keyboard.keyDown(evt);
        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(true);

        keyboard.clearKeys();

        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(false);
    });

    test("leaves reset alone when the keys are cleared and Break was never pressed", () => {
        keyboard.clearKeys();

        expect(mockProcessor.setReset).not.toHaveBeenCalled();
    });

    test("lets a text field that took focus mid-hold have the key's repeats", () => {
        const key = { code: keyCodes.A, preventDefault: vi.fn(), altKey: false, ctrlKey: false, shiftKey: false };
        running = true;
        keyboard.keyDown(key);
        mockInputEnabledFunction.mockReturnValue(true);

        const repeat = { ...key, repeat: true, preventDefault: vi.fn() };
        keyboard.keyDown(repeat);

        expect(repeat.preventDefault).not.toHaveBeenCalled();
        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(1);
    });

    test("brings a key held through a paste back once the paste is over", () => {
        const key = { code: keyCodes.A, preventDefault: vi.fn(), altKey: false, ctrlKey: false, shiftKey: false };
        running = true;
        keyboard.keyDown(key);

        keyboard.sendRawKeyboard([BBC.B], false);
        keyboard.keyDown({ ...key, repeat: true });
        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(1);

        keyboard.cancelPaste();
        keyboard.keyDown({ ...key, repeat: true });
        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(2);
    });

    test("presses again when a key comes down whose key up never arrived", () => {
        const key = { code: keyCodes.A, preventDefault: vi.fn(), altKey: false, ctrlKey: false, shiftKey: false };
        running = true;

        keyboard.keyDown(key);
        keyboard.keyDown(key);
        keyboard.keyUp(key);

        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(2);
        expect(mockSysvia.keyUp).toHaveBeenCalledTimes(2);
    });

    describe.each(["physical", "natural", "gaming"])("the keypad in the %s layout", (layout) => {
        beforeEach(() => {
            keyboard.setKeyLayout(layout);
            running = true;
        });

        test.each([
            ["Numpad1", keyCodes.END],
            ["Numpad7", keyCodes.HOME],
            ["Numpad9", keyCodes.PAGEUP],
            ["Numpad3", keyCodes.PAGEDOWN],
            ["Numpad0", keyCodes.INSERT],
            ["Numpad4", keyCodes.LEFT],
            ["Numpad8", keyCodes.UP],
            ["Numpad6", keyCodes.RIGHT],
            ["Numpad2", keyCodes.DOWN],
        ])("gives %s with Num Lock off what the main %s key gives", (code, key) => {
            keyboard.keyDown(keyEvent(code, key));
            keyboard.keyUp(keyEvent(code, "1"));

            expect(mockSysvia.keyDown).toHaveBeenCalledWith(key, false);
            expect(mockSysvia.keyUp).toHaveBeenCalledWith(key);
        });

        test.each([
            ["Numpad1", "1"],
            ["NumpadDecimal", "Delete"],
            ["NumpadEnter", "Enter"],
            ["Numpad5", "Clear"],
        ])("keeps %s as the keypad's own key when it gives %s", (code, key) => {
            keyboard.keyDown(keyEvent(code, key));

            expect(mockSysvia.keyDown).toHaveBeenCalledWith(code, false);
        });

        test("gives a KEY. parameter for the keypad key its key, over Num Lock", () => {
            userKeymap.push({ native: "NUMPAD1", key: "COPY" });
            try {
                keyboard.keyDown(keyEvent("Numpad1", keyCodes.END));

                expect(mockSysvia.keyDown).toHaveBeenCalledWith("Numpad1", false);
            } finally {
                userKeymap.length = 0;
            }
        });
    });

    describe("a modifier whose key up was lost", () => {
        beforeEach(() => (running = true));

        test.each([
            ["shift", keyCodes.SHIFT_RIGHT, "Shift", "shiftKey"],
            ["ctrl", keyCodes.CTRL_LEFT, "Control", "ctrlKey"],
        ])("lets go of %s once a key event says it is up", (_, code, key, flag) => {
            keyboard.keyDown(keyEvent(code, key, { [flag]: true }));
            keyboard.keyDown(keyEvent(keyCodes.A, "a", { [flag]: true }));
            expect(mockSysvia.keyUp).not.toHaveBeenCalled();

            keyboard.keyUp(keyEvent(keyCodes.A, "a"));

            expect(mockSysvia.keyUp.mock.calls).toEqual([[code], [keyCodes.A]]);
        });

        test("lets go of ctrl when the next key comes down without it", () => {
            keyboard.keyDown(keyEvent(keyCodes.CTRL_LEFT, "Control", { ctrlKey: true }));
            keyboard.keyDown(keyEvent(keyCodes.A, "a"));

            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.CTRL_LEFT]]);
            expect(mockSysvia.keyDown).toHaveBeenLastCalledWith(keyCodes.A, false);
        });

        test("is not let go of by the other shift key's key up", () => {
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_LEFT, "Shift", { shiftKey: true }));
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_RIGHT, "Shift", { shiftKey: true }));
            keyboard.keyUp(keyEvent(keyCodes.SHIFT_RIGHT, "Shift"));

            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.SHIFT_RIGHT]]);
        });

        test("changes nothing for the shift Windows lets go of around a keypad key with Num Lock on", () => {
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_LEFT, "Shift", { shiftKey: true }));
            keyboard.keyUp(keyEvent(keyCodes.SHIFT_LEFT, "Shift"));
            keyboard.keyDown(keyEvent(keyCodes.NUMPAD1, keyCodes.END));
            keyboard.keyUp(keyEvent(keyCodes.NUMPAD1, keyCodes.END));
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_LEFT, "Shift", { shiftKey: true }));
            keyboard.keyUp(keyEvent(keyCodes.SHIFT_LEFT, "Shift"));

            expect(mockSysvia.keyDown.mock.calls).toEqual([
                [keyCodes.SHIFT_LEFT, true],
                [keyCodes.END, false],
                [keyCodes.SHIFT_LEFT, true],
            ]);
            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.SHIFT_LEFT], [keyCodes.END], [keyCodes.SHIFT_LEFT]]);
        });
    });

    describe("when the input method takes a key", () => {
        const deadKey = (extra = {}) => keyEvent(keyCodes.APOSTROPHE, "Dead", { shiftKey: true, ...extra });
        const composedEnter = () => keyEvent(keyCodes.ENTER, "Process", { keyCode: 229 });

        beforeEach(() => (running = true));

        test("lets go of a dead key whose key up never arrives when the next key is composed", () => {
            keyboard.keyDown(deadKey());
            keyboard.keyDown(composedEnter());

            expect(mockSysvia.keyDown.mock.calls).toEqual([[keyCodes.APOSTROPHE, true]]);
            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.APOSTROPHE]]);
        });

        test.each([
            ["as normal", "Dead"],
            ["naming a different key", "\u00a8"],
        ])("lets go of a dead key once, on its key up %s", (_, keyUpKey) => {
            keyboard.keyDown(deadKey());
            keyboard.keyUp(keyEvent(keyCodes.APOSTROPHE, keyUpKey));
            keyboard.keyDown(composedEnter());

            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.APOSTROPHE]]);
        });

        test("resets the input method once when the machine takes a dead key", () => {
            keyboard.keyDown(deadKey());
            keyboard.keyDown(deadKey({ repeat: true }));

            expect(resetInputMethod).toHaveBeenCalledTimes(1);
        });

        test("leaves the input method alone for a dead key typed into the page", () => {
            mockInputEnabledFunction.mockReturnValue(true);
            keyboard.keyDown(deadKey());

            expect(resetInputMethod).not.toHaveBeenCalled();
        });

        test("holds a Return pressed after the reset dead key from its press to its key up", () => {
            const enter = (extra) => keyEvent(keyCodes.ENTER, "Enter", extra);
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_LEFT, "Shift", { shiftKey: true }));
            keyboard.keyDown(deadKey());
            keyboard.keyUp(keyEvent(keyCodes.APOSTROPHE, "Dead", { shiftKey: true }));
            keyboard.keyUp(keyEvent(keyCodes.SHIFT_LEFT, "Shift"));
            keyboard.keyDown(enter());
            keyboard.keyDown(enter({ repeat: true }));
            keyboard.keyDown(enter({ repeat: true }));
            expect(mockSysvia.keyUp).not.toHaveBeenCalledWith(keyCodes.ENTER);

            keyboard.keyUp(enter());
            expect(mockSysvia.keyDown.mock.calls.filter(([key]) => key === keyCodes.ENTER)).toHaveLength(1);
            expect(mockSysvia.keyUp).toHaveBeenLastCalledWith(keyCodes.ENTER);
        });

        test("holds a dead key through its repeats", () => {
            keyboard.keyDown(deadKey());
            keyboard.keyDown(deadKey({ repeat: true }));
            keyboard.keyDown(deadKey({ repeat: true }));

            expect(mockSysvia.keyDown).toHaveBeenCalledTimes(1);
            expect(mockSysvia.keyUp).not.toHaveBeenCalled();
        });

        test("lets go of shift and the dead key when Linux sends no key ups at all", () => {
            keyboard.keyDown(keyEvent(keyCodes.SHIFT_LEFT, "Shift", { shiftKey: true }));
            keyboard.keyDown(deadKey());
            keyboard.keyDown(keyEvent(keyCodes.ENTER, "Process", { keyCode: 229, shiftKey: true }));
            keyboard.keyDown(keyEvent(keyCodes.A, "a"));

            expect(mockSysvia.keyUp.mock.calls).toEqual([[keyCodes.APOSTROPHE], [keyCodes.SHIFT_LEFT]]);
            expect(mockSysvia.keyDown).not.toHaveBeenCalledWith(keyCodes.ENTER, expect.anything());
        });

        test.each([
            ["Process", { key: "Process", keyCode: 229 }],
            ["keyCode 229", { key: "Enter", keyCode: 229 }],
        ])("ignores a key the input method has composed into, by %s", (_, fields) => {
            keyboard.keyDown(keyEvent(keyCodes.ENTER, fields.key, { keyCode: fields.keyCode }));
            keyboard.keyUp(keyEvent(keyCodes.ENTER, "Enter"));

            expect(mockSysvia.keyDown).not.toHaveBeenCalled();
            expect(mockSysvia.keyUp).not.toHaveBeenCalled();
        });
    });

    test("keeps keys from a machine that is not running", () => {
        keyboard.keyDown(keyEvent(keyCodes.A));
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("releases a key pressed before focus moved into a text field", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
        };

        running = true;
        keyboard.keyDown(event);
        mockInputEnabledFunction.mockReturnValue(true);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(keyCodes.A);
    });

    test("does not reach the machine for a key released without being pressed", () => {
        running = true;
        keyboard.keyUp({ code: keyCodes.A, preventDefault: vi.fn(), altKey: false });

        expect(mockSysvia.keyUp).not.toHaveBeenCalled();
    });

    test("gives a key to its Ctrl handler instead of the machine", () => {
        const handler = vi.fn();
        keyboard.registerKeyHandler(keyCodes.E, handler, { alt: false, ctrl: true });
        running = true;

        keyboard.keyDown(keyEvent(keyCodes.E, "", { ctrlKey: true }));

        expect(handler).toHaveBeenCalledWith(true, keyCodes.E, false);
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("runs a shortcut once however long it is held, even when its repeats outlast a blur", () => {
        const handler = vi.fn();
        keyboard.registerKeyHandler(keyCodes.T, handler, { alt: true, ctrl: false });
        const altT = (repeat) => keyEvent(keyCodes.T, "", { altKey: true, repeat });

        keyboard.keyDown(altT(false));
        keyboard.keyDown(altT(true));
        keyboard.clearKeys();
        keyboard.keyDown(altT(true));

        expect(handler.mock.calls.filter(([down]) => down)).toHaveLength(1);
    });

    test("keeps the keyboard from the machine while a paste types, until Escape cancels it", () => {
        running = true;
        keyboard.sendRawKeyboard([BBC.A, BBC.B], false);
        expect(mockSysvia.disableKeyboard).toHaveBeenCalled();
        expect(keyboard.isPasting).toBe(true);

        keyboard.keyDown(keyEvent(keyCodes.ESCAPE));

        expect(keyboard.isPasting).toBe(false);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
    });

    test("handleMacCapsLock taps the key and says why, however often it is pressed", () => {
        const notices = [];
        keyboard.addEventListener("notice", (e) => notices.push(e.detail));

        keyboard.handleMacCapsLock();
        keyboard.handleMacCapsLock();

        expect(mockSysvia.keyDown).toHaveBeenCalledWith(keyCodes.CAPSLOCK);
        expect(notices).toHaveLength(1);
        expect(notices[0].message).toContain("caps lock");
        expect(notices[0].quietKey).toBe("warnedAboutRubbishMacs");
    });
});

describe("Keyboard Atom adapter", () => {
    let keyboard;
    let mockAtomPPIA;
    let mockProcessor;

    beforeEach(() => {
        mockProcessor = fakeKeyboardProcessor("Atom");
        mockAtomPPIA = mockProcessor.atomppia;

        keyboard = new Keyboard({
            processor: mockProcessor,
            inputEnabledFunction: () => false,
            runningFunction: () => true,
            keyLayout: "physical",
        });
    });

    test("takes the PPIA as its key interface on an Atom", () => {
        expect(keyboard.keyInterface).toBe(mockAtomPPIA);
    });

    test("keyDown should route to PPIA, not SysVia", () => {
        const evt = { code: "KeyA", shiftKey: false, altKey: false, ctrlKey: false, preventDefault: vi.fn() };
        keyboard.keyDown(evt);
        expect(mockAtomPPIA.keyDown).toHaveBeenCalledWith("KeyA", false);
        expect(mockProcessor.sysvia.keyDown).not.toHaveBeenCalled();
    });

    test("keyUp should route to PPIA", () => {
        const evt = { code: "KeyA", altKey: false, ctrlKey: false, preventDefault: vi.fn() };
        keyboard.keyDown(evt);
        keyboard.keyUp(evt);
        expect(mockAtomPPIA.keyUp).toHaveBeenCalledWith("KeyA");
    });

    test("sends the PPIA the character the host produced in the natural layout", () => {
        keyboard.setKeyLayout("natural");
        keyboard.keyDown({
            code: "Digit2",
            key: "@",
            shiftKey: true,
            altKey: false,
            ctrlKey: false,
            preventDefault: vi.fn(),
        });
        expect(mockAtomPPIA.keyDown).toHaveBeenCalledWith("@", true);
    });

    test("setKeyLayout hands the layout to the processor", () => {
        keyboard.setKeyLayout("natural");
        expect(mockProcessor.setKeyLayout).toHaveBeenCalledWith("natural");
    });
});

describe("stringToATOMKeys", () => {
    test("should insert LOCK toggles only for case transitions", () => {
        // "Hello" = H (caps on), LOCK off, e, l, l, o, LOCK on (restore)
        const keys = stringToATOMKeys("Hello");
        expect(keys).toEqual([ATOM.H, ATOM.LOCK, ATOM.E, ATOM.L, ATOM.L, ATOM.O, ATOM.LOCK]);
    });

    test("should not insert LOCK for all-uppercase", () => {
        const keys = stringToATOMKeys("ABC");
        expect(keys).toEqual([ATOM.A, ATOM.B, ATOM.C]);
    });

    test("should not toggle LOCK for non-letter characters", () => {
        // Space and digits should not force LOCK back on between lowercase runs
        const keys = stringToATOMKeys("a b");
        expect(keys).toEqual([ATOM.LOCK, ATOM.A, ATOM.SPACE, ATOM.B, ATOM.LOCK]);
    });

    test("should handle shifted characters without extra LOCK toggles", () => {
        // ' is SHIFT+7. Apostrophe doesn't care about caps lock state,
        // so no LOCK toggle between the lowercase letters and the punctuation.
        const keys = stringToATOMKeys("a'b");
        expect(keys).toEqual([ATOM.LOCK, ATOM.A, ATOM.SHIFT, ATOM.K7, ATOM.SHIFT, ATOM.B, ATOM.LOCK]);
    });
});
