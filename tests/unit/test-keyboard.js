import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/web/keyboard.js";
import { Scheduler } from "../../src/scheduler.js";
import { ATOM, stringToATOMKeys } from "../../src/keymap-atom.js";
import { BBC, keyCodes, userKeymap } from "../../src/keymap.js";
import { findModel } from "../../src/models.js";

describe("Keyboard", () => {
    let keyboard;
    let mockProcessor;
    let mockSysvia;
    let mockInputEnabledFunction;

    const waitForEvent = (eventName) => {
        return new Promise((resolve) => {
            keyboard.addEventListener(eventName, resolve, { once: true });
        });
    };

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
        mockSysvia = {
            keyDown: vi.fn(),
            keyUp: vi.fn(),
            clearKeys: vi.fn(),
            disableKeyboard: vi.fn(),
            enableKeyboard: vi.fn(),
            keyToggleRaw: vi.fn(),
            setKeyLayout: vi.fn(),
            capsLockLight: false,
            shiftLockLight: false,
        };

        mockProcessor = {
            model: findModel("B-DFS1.2"),
            sysvia: mockSysvia,
            keyboardInterface: mockSysvia,
            setKeyLayout: vi.fn(),
            scheduler: new Scheduler(),
            setReset: vi.fn(),
            peripheralCyclesPerSecond: 2000000,
            cycleSeconds: 0,
            currentCycles: 0,
        };

        mockInputEnabledFunction = vi.fn().mockReturnValue(false);

        keyboard = new Keyboard({
            processor: mockProcessor,
            inputEnabledFunction: mockInputEnabledFunction,
            keyLayout: "physical",
            dbgr: {
                enabled: vi.fn().mockReturnValue(false),
                keyPress: vi.fn(),
                hide: vi.fn(),
            },
        });
    });

    test("should create a keyboard instance", () => {
        expect(keyboard).toBeDefined();
    });

    describe("in a shared session", () => {
        let input;
        beforeEach(() => {
            input = { keyDown: vi.fn(), keyUp: vi.fn(), setReset: vi.fn(), clearKeys: vi.fn() };
            keyboard.setRunning(true);
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
            keyboard.setRunning(true);
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
        keyboard.setRunning(true);
        keyboard.keyDown(evt);
        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(true);

        keyboard.setRunning(false);
        keyboard.keyUp(evt);

        expect(mockProcessor.setReset).toHaveBeenLastCalledWith(false);
    });

    test("brings the machine out of reset when the window loses focus with Break held", () => {
        const evt = breakKey();
        keyboard.setRunning(true);
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
        keyboard.setRunning(true);
        keyboard.keyDown(key);
        mockInputEnabledFunction.mockReturnValue(true);

        const repeat = { ...key, repeat: true, preventDefault: vi.fn() };
        keyboard.keyDown(repeat);

        expect(repeat.preventDefault).not.toHaveBeenCalled();
        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(1);
    });

    test("brings a key held through a paste back once the paste is over", () => {
        const key = { code: keyCodes.A, preventDefault: vi.fn(), altKey: false, ctrlKey: false, shiftKey: false };
        mockSysvia.keyUpRaw = vi.fn();
        keyboard.setRunning(true);
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
        keyboard.setRunning(true);

        keyboard.keyDown(key);
        keyboard.keyDown(key);
        keyboard.keyUp(key);

        expect(mockSysvia.keyDown).toHaveBeenCalledTimes(2);
        expect(mockSysvia.keyUp).toHaveBeenCalledTimes(2);
    });

    describe.each(["physical", "natural", "gaming"])("the keypad in the %s layout", (layout) => {
        beforeEach(() => {
            keyboard.setKeyLayout(layout);
            keyboard.setRunning(true);
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
        beforeEach(() => keyboard.setRunning(true));

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

        beforeEach(() => keyboard.setRunning(true));

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

    test("keyCode is the physical position the event came from", () => {
        expect(keyboard.keyCode({ code: "ShiftLeft" })).toBe(keyCodes.SHIFT_LEFT);
        expect(keyboard.keyCode({ code: "ShiftRight" })).toBe(keyCodes.SHIFT_RIGHT);
        expect(keyboard.keyCode({ code: "NumpadEnter" })).toBe(keyCodes.NUMPADENTER);
        expect(keyboard.keyCode({ code: "NumpadDecimal" })).toBe(keyCodes.NUMPAD_DECIMAL_POINT);
        expect(keyboard.keyCode({ code: "KeyA" })).toBe(keyCodes.A);
    });

    test("keyDown should handle normal key press", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockSysvia.keyDown).toHaveBeenCalledWith(keyCodes.A, false);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("keyDown should not handle keys when not running", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(false);
        keyboard.keyDown(event);

        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("keyDown should not handle keys when input is enabled", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        // Set input enabled to true
        mockInputEnabledFunction.mockReturnValueOnce(true);

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockInputEnabledFunction).toHaveBeenCalled();
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("keyDown should hold reset for F12/BREAK", () => {
        const event = {
            code: keyCodes.F12,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockProcessor.setReset).toHaveBeenCalledWith(true);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("keyUp should call sysvia.keyUp", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(keyCodes.A);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("releases a key pressed before focus moved into a text field", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);
        mockInputEnabledFunction.mockReturnValue(true);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(keyCodes.A);
    });

    test("does not reach the machine for a key released without being pressed", () => {
        keyboard.setRunning(true);
        keyboard.keyUp({ code: keyCodes.A, preventDefault: vi.fn(), altKey: false });

        expect(mockSysvia.keyUp).not.toHaveBeenCalled();
    });

    test("keyUp should release reset for F12/BREAK", () => {
        const event = {
            code: keyCodes.F12,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);
        keyboard.keyUp(event);

        expect(mockProcessor.setReset).toHaveBeenCalledWith(false);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("clearKeys should call sysvia.clearKeys", () => {
        keyboard.clearKeys();
        expect(mockSysvia.clearKeys).toHaveBeenCalled();
    });

    test("setKeyLayout hands the layout to the processor", () => {
        keyboard.setKeyLayout("gaming");
        expect(mockProcessor.setKeyLayout).toHaveBeenCalledWith("gaming");
    });

    test("keyPress should not proceed when input is enabled", () => {
        const event = {
            key: "g",
            preventDefault: vi.fn(),
        };

        // Set input enabled to true
        mockInputEnabledFunction.mockReturnValueOnce(true);

        // Add a resume event listener to check it's not called
        const resumeListener = vi.fn();
        keyboard.addEventListener("resume", resumeListener);

        keyboard.keyPress(event);

        expect(mockInputEnabledFunction).toHaveBeenCalled();
        // No events should be emitted when input is enabled
        expect(resumeListener).not.toHaveBeenCalled();
    });

    test("keyPress should emit resume event when lowercase g pressed in pause mode", async () => {
        keyboard.setRunning(true);
        keyboard.pauseEmulation();
        keyboard.setRunning(false);

        const eventPromise = waitForEvent("resume");
        keyboard.keyPress({ key: "g" });
        await eventPromise;
    });

    test("a pause ends when the loop starts again, by whatever route", () => {
        const resumeListener = vi.fn();
        keyboard.addEventListener("resume", resumeListener);
        keyboard.setRunning(true);
        keyboard.pauseEmulation();
        keyboard.setRunning(false);

        keyboard.setRunning(true);
        keyboard.setRunning(false);
        keyboard.keyPress({ key: "g" });

        expect(resumeListener).not.toHaveBeenCalled();
    });

    test("keyPress should handle debugger g key and emit resume event", async () => {
        const event = {
            key: "g",
            preventDefault: vi.fn(),
        };

        // Mock debugger enabled
        const mockDbgr = {
            enabled: vi.fn().mockReturnValue(true),
            keyPress: vi.fn(),
            hide: vi.fn(),
        };
        keyboard.dbgr = mockDbgr;

        const eventPromise = waitForEvent("resume");
        keyboard.keyPress(event);
        await eventPromise;

        expect(mockDbgr.hide).toHaveBeenCalled();
    });

    test("registerKeyHandler should add a handler for a key with Alt modifier", () => {
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(keyCodes.Q, mockHandler, { alt: true, ctrl: false });

        const event = {
            code: keyCodes.Q,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: true,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockHandler).toHaveBeenCalledWith(true, keyCodes.Q, false);
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("registered handler suppresses sysvia.keyDown for that key", () => {
        // When a handler claims a key, the BBC Micro should NOT also receive it.
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(keyCodes.K1, mockHandler, { alt: true, ctrl: false });

        keyboard.setRunning(true);
        keyboard.keyDown({
            code: keyCodes.K1,
            preventDefault: vi.fn(),
            altKey: true,
            ctrlKey: false,
            shiftKey: false,
        });

        expect(mockHandler).toHaveBeenCalledWith(true, keyCodes.K1, false);
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("unhandled keys still reach sysvia.keyDown", () => {
        keyboard.setRunning(true);
        keyboard.keyDown({
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
        });

        expect(mockSysvia.keyDown).toHaveBeenCalledWith(keyCodes.A, false);
    });

    test("registerKeyHandler should add a handler for a key with Ctrl modifier", () => {
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(keyCodes.E, mockHandler, { alt: false, ctrl: true });

        const event = {
            code: keyCodes.E,
            preventDefault: vi.fn(),
            ctrlKey: true,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockHandler).toHaveBeenCalledWith(true, keyCodes.E, false);
    });

    test("sendRawKeyboard should disable keyboard and schedule paste task", () => {
        keyboard.sendRawKeyboard([BBC.A], false);

        expect(mockSysvia.disableKeyboard).toHaveBeenCalled();
        expect(keyboard.isPasting).toBe(true);
    });

    test("cancelPaste should stop paste and re-enable keyboard", () => {
        keyboard.sendRawKeyboard([BBC.A, BBC.B, BBC.C], false);
        mockProcessor.scheduler.polltime(1); // deliver first key

        keyboard.cancelPaste();

        expect(keyboard.isPasting).toBe(false);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
    });

    test("Escape should cancel paste during keyDown", () => {
        keyboard.sendRawKeyboard([BBC.A, BBC.B], false);
        keyboard.setRunning(true);

        const escEvent = {
            code: keyCodes.ESCAPE,
            preventDefault: vi.fn(),
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
        };
        keyboard.keyDown(escEvent);

        expect(keyboard.isPasting).toBe(false);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
    });

    test("postFrameShouldPause should handle single step", () => {
        // Initially should not pause
        expect(keyboard.postFrameShouldPause()).toBe(false);

        // Set step to true
        keyboard.stepEmuWhenPaused = true;

        // Should pause and reset flag
        expect(keyboard.postFrameShouldPause()).toBe(true);

        // Flag should be reset
        expect(keyboard.stepEmuWhenPaused).toBe(false);

        // Subsequent call should not pause
        expect(keyboard.postFrameShouldPause()).toBe(false);
    });

    test("requestStep should set the step flag", () => {
        expect(keyboard.stepEmuWhenPaused).toBe(false);
        keyboard.requestStep();
        expect(keyboard.stepEmuWhenPaused).toBe(true);
    });

    test("pauseEmulation should set pause flag and emit pause event", async () => {
        const eventPromise = waitForEvent("pause");
        keyboard.pauseEmulation();
        await eventPromise;

        expect(keyboard.pauseEmu).toBe(true);
    });

    test("resumeEmulation should clear pause flag and emit resume event", async () => {
        keyboard.setRunning(true);
        keyboard.pauseEmulation();
        keyboard.setRunning(false);

        const eventPromise = waitForEvent("resume");
        keyboard.resumeEmulation();
        await eventPromise;

        expect(keyboard.pauseEmu).toBe(false);
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
        mockAtomPPIA = {
            keyDown: vi.fn(),
            keyUp: vi.fn(),
            clearKeys: vi.fn(),
            disableKeyboard: vi.fn(),
            enableKeyboard: vi.fn(),
            keyToggleRaw: vi.fn(),
            setKeyLayout: vi.fn(),
        };

        mockProcessor = {
            model: findModel("Atom"),
            atomppia: mockAtomPPIA,
            keyboardInterface: mockAtomPPIA,
            setKeyLayout: vi.fn(),
            sysvia: { keyDown: vi.fn(), keyUp: vi.fn() },
            scheduler: new Scheduler(),
            setReset: vi.fn(),
            peripheralCyclesPerSecond: 1000000,
            cycleSeconds: 0,
            currentCycles: 0,
        };

        keyboard = new Keyboard({
            processor: mockProcessor,
            inputEnabledFunction: () => false,
            keyLayout: "physical",
            dbgr: { enabled: () => false },
        });
        keyboard.setRunning(true);
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
