import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/keyboard.js";
import * as utils from "../../src/utils.js";

describe("Keyboard", () => {
    let keyboard;
    let mockProcessor;
    let mockSysvia;
    let mockInputEnabledFunction;

    // Helper function to create an async event tester
    const waitForEvent = (eventName) => {
        return new Promise((resolve) => {
            keyboard.on(eventName, (...args) => {
                resolve(args);
            });
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
            sysvia: mockSysvia,
            debugInstruction: {
                add: vi.fn().mockReturnValue({
                    remove: vi.fn(),
                }),
            },
            setReset: vi.fn(),
            cpuMultiplier: 1,
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

    test("keyCode should handle location properly", () => {
        // Test SHIFT key
        const shiftEvent = { which: utils.keyCodes.SHIFT, location: 1 };
        expect(keyboard.keyCode(shiftEvent)).toBe(utils.keyCodes.SHIFT_LEFT);

        const shiftEvent2 = { which: utils.keyCodes.SHIFT, location: 2 };
        expect(keyboard.keyCode(shiftEvent2)).toBe(utils.keyCodes.SHIFT_RIGHT);

        // Test CTRL key
        const ctrlEvent = { which: utils.keyCodes.CTRL, location: 1 };
        expect(keyboard.keyCode(ctrlEvent)).toBe(utils.keyCodes.CTRL_LEFT);

        const ctrlEvent2 = { which: utils.keyCodes.CTRL, location: 2 };
        expect(keyboard.keyCode(ctrlEvent2)).toBe(utils.keyCodes.CTRL_RIGHT);

        // Test ALT key
        const altEvent = { which: utils.keyCodes.ALT, location: 1 };
        expect(keyboard.keyCode(altEvent)).toBe(utils.keyCodes.ALT_LEFT);

        const altEvent2 = { which: utils.keyCodes.ALT, location: 2 };
        expect(keyboard.keyCode(altEvent2)).toBe(utils.keyCodes.ALT_RIGHT);

        // Test numpad
        const enterEvent = { which: utils.keyCodes.ENTER, location: 3 };
        expect(keyboard.keyCode(enterEvent)).toBe(utils.keyCodes.NUMPADENTER);

        const deleteEvent = { which: utils.keyCodes.DELETE, location: 3 };
        expect(keyboard.keyCode(deleteEvent)).toBe(utils.keyCodes.NUMPAD_DECIMAL_POINT);

        // Test normal key
        const normalEvent = { which: utils.keyCodes.A, location: 0 };
        expect(keyboard.keyCode(normalEvent)).toBe(utils.keyCodes.A);
    });

    test("keyCode should remember last modifier key locations", () => {
        // First, set modifier locations to known values
        keyboard.keyCode({ which: utils.keyCodes.SHIFT, location: 1 });
        keyboard.keyCode({ which: utils.keyCodes.CTRL, location: 1 });
        keyboard.keyCode({ which: utils.keyCodes.ALT, location: 1 });

        // When location = 0 (like in keyUp events), should return based on last location
        expect(keyboard.keyCode({ which: utils.keyCodes.SHIFT, location: 0 })).toBe(utils.keyCodes.SHIFT_LEFT);
        expect(keyboard.keyCode({ which: utils.keyCodes.CTRL, location: 0 })).toBe(utils.keyCodes.CTRL_LEFT);
        expect(keyboard.keyCode({ which: utils.keyCodes.ALT, location: 0 })).toBe(utils.keyCodes.ALT_LEFT);

        // Change the locations to right side
        keyboard.keyCode({ which: utils.keyCodes.SHIFT, location: 2 });
        keyboard.keyCode({ which: utils.keyCodes.CTRL, location: 2 });
        keyboard.keyCode({ which: utils.keyCodes.ALT, location: 2 });

        // Should now use the updated locations
        expect(keyboard.keyCode({ which: utils.keyCodes.SHIFT, location: 0 })).toBe(utils.keyCodes.SHIFT_RIGHT);
        expect(keyboard.keyCode({ which: utils.keyCodes.CTRL, location: 0 })).toBe(utils.keyCodes.CTRL_RIGHT);
        expect(keyboard.keyCode({ which: utils.keyCodes.ALT, location: 0 })).toBe(utils.keyCodes.ALT_RIGHT);
    });

    test("keyDown should handle normal key press", () => {
        const event = {
            which: utils.keyCodes.A,
            location: 0,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockSysvia.keyDown).toHaveBeenCalledWith(utils.keyCodes.A, false);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("keyDown should not handle keys when not running", () => {
        const event = {
            which: utils.keyCodes.A,
            location: 0,
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
            which: utils.keyCodes.A,
            location: 0,
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
            which: utils.keyCodes.F12,
            location: 0,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);

        const [breakState] = await triggerAndWaitForEvent("break", () => {
            keyboard.keyDown(event);
        });

        expect(mockProcessor.setReset).toHaveBeenCalledWith(true);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(breakState).toBe(true);
    });

    test("keyUp should call sysvia.keyUp", () => {
        const event = {
            which: utils.keyCodes.A,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyUp(event);

        expect(mockSysvia.keyUp).toHaveBeenCalledWith(utils.keyCodes.A);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("keyUp should not proceed when input is enabled", () => {
        const event = {
            which: utils.keyCodes.A,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
        };

        // Set input enabled to true
        mockInputEnabledFunction.mockReturnValueOnce(true);

        keyboard.setRunning(true);
        keyboard.keyUp(event);

        expect(mockInputEnabledFunction).toHaveBeenCalled();
        expect(mockSysvia.keyUp).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test("keyUp should handle F12/BREAK and emit break event", async () => {
        const event = {
            which: utils.keyCodes.F12,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);

        const [breakState] = await triggerAndWaitForEvent("break", () => {
            keyboard.keyUp(event);
        });

        expect(mockProcessor.setReset).toHaveBeenCalledWith(false);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(breakState).toBe(false);
    });

    test("clearKeys should call sysvia.clearKeys", () => {
        keyboard.clearKeys();
        expect(mockSysvia.clearKeys).toHaveBeenCalled();
    });

    test("setKeyLayout should update config and call processor to update layout", () => {
        keyboard.setKeyLayout("gaming");
        expect(mockSysvia.setKeyLayout).toHaveBeenCalledWith("gaming");
    });

    test("keyPress should not proceed when input is enabled", () => {
        const event = {
            which: 103, // lowercase g key
            location: 0,
            preventDefault: vi.fn(),
        };

        // Set input enabled to true
        mockInputEnabledFunction.mockReturnValueOnce(true);

        // Add a resume event listener to check it's not called
        const resumeListener = vi.fn();
        keyboard.on("resume", resumeListener);

        keyboard.keyPress(event);

        expect(mockInputEnabledFunction).toHaveBeenCalled();
        // No events should be emitted when input is enabled
        expect(resumeListener).not.toHaveBeenCalled();
    });

    test("keyPress should emit resume event when lowercase g pressed in pause mode", async () => {
        const event = {
            which: 103, // lowercase g key
            location: 0,
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
            which: 103, // lowercase g key
            location: 0,
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
        keyboard.registerKeyHandler(utils.keyCodes.Q, mockHandler, { alt: true, ctrl: false });

        const event = {
            which: utils.keyCodes.Q,
            location: 0,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: true,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockHandler).toHaveBeenCalledWith(true, utils.keyCodes.Q);
    });

    test("registerKeyHandler should add a handler for a key with Ctrl modifier", () => {
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(utils.keyCodes.E, mockHandler, { alt: false, ctrl: true });

        const event = {
            which: utils.keyCodes.E,
            location: 0,
            preventDefault: vi.fn(),
            ctrlKey: true,
            altKey: false,
            shiftKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockHandler).toHaveBeenCalledWith(true, utils.keyCodes.E);
    });

    test("sendRawKeyboardToBBC should setup the keyboard input", () => {
        keyboard.sendRawKeyboardToBBC([utils.BBC.A], false);

        expect(mockSysvia.disableKeyboard).toHaveBeenCalled();
        expect(mockProcessor.debugInstruction.add).toHaveBeenCalled();
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

    // We don't test Mac-specific code as it requires global mocking
});
