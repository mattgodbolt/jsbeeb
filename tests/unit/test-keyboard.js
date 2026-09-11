import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/web/keyboard.js";
import { Scheduler } from "../../src/scheduler.js";
import { ATOM, stringToATOMKeys } from "../../src/keymap-atom.js";
import { BBC, keyCodes } from "../../src/keymap.js";
import { findModel } from "../../src/models.js";

describe("Keyboard", () => {
    let keyboard;
    let mockProcessor;
    let mockSysvia;
    let mockInputEnabledFunction;

    // Helper function to create an async event tester.
    // Resolves with the event itself so callers can access .detail if needed.
    const waitForEvent = (eventName) => {
        return new Promise((resolve) => {
            keyboard.addEventListener(eventName, resolve, { once: true });
        });
    };

    // Helper to trigger an event and wait for the result
    const triggerAndWaitForEvent = async (eventName, action) => {
        const eventPromise = waitForEvent(eventName);
        action();
        return await eventPromise;
    };

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

    test("keyDown should handle F12/BREAK and emit break event", async () => {
        const event = {
            code: keyCodes.F12,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);

        const breakState = await triggerAndWaitForEvent("break", () => {
            keyboard.keyDown(event);
        });

        expect(mockProcessor.setReset).toHaveBeenCalledWith(true);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(breakState.detail).toBe(true);
    });

    test("keyUp should call sysvia.keyUp", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(keyCodes.A);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("keyUp still releases the key when input is enabled, but leaves the event to the page", () => {
        const event = {
            code: keyCodes.A,
            preventDefault: vi.fn(),
            altKey: false,
        };

        mockInputEnabledFunction.mockReturnValueOnce(true);

        keyboard.setRunning(true);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(keyCodes.A);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test("keyUp should handle F12/BREAK and emit break event", async () => {
        const event = {
            code: keyCodes.F12,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);

        const breakState = await triggerAndWaitForEvent("break", () => {
            keyboard.keyUp(event);
        });

        expect(mockProcessor.setReset).toHaveBeenCalledWith(false);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(breakState.detail).toBe(false);
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
        const event = {
            key: "g",
            preventDefault: vi.fn(),
        };

        keyboard.pauseEmu = true;

        const eventPromise = waitForEvent("resume");
        keyboard.keyPress(event);
        await eventPromise;

        expect(keyboard.pauseEmu).toBe(false);
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
        keyboard.pauseEmu = true;

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
        keyboard.keyUp(evt);
        expect(mockAtomPPIA.keyUp).toHaveBeenCalledWith("KeyA");
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
