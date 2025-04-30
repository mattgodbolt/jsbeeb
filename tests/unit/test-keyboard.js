import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/keyboard.js";
import * as utils from "../../src/utils.js";

describe("Keyboard", () => {
    let keyboard;
    let mockProcessor;
    let mockSysvia;
    let mockAudioHandler;
    let mockDocument;

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

        mockAudioHandler = {
            tryResume: vi.fn(),
        };

        mockDocument = {
            activeElement: {
                id: "not-paste-text",
            },
        };

        keyboard = new Keyboard({
            processor: mockProcessor,
            audioHandler: mockAudioHandler,
            document: mockDocument,
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

        expect(mockAudioHandler.tryResume).toHaveBeenCalled();
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

        expect(mockAudioHandler.tryResume).toHaveBeenCalled();
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("keyDown should not handle keys when paste-text is active", () => {
        const event = {
            which: utils.keyCodes.A,
            location: 0,
            preventDefault: vi.fn(),
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
        };

        // Change the active element
        mockDocument.activeElement.id = "paste-text";

        keyboard.setRunning(true);
        keyboard.keyDown(event);

        expect(mockAudioHandler.tryResume).toHaveBeenCalled();
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();

        // Reset for other tests
        mockDocument.activeElement.id = "not-paste-text";
    });

    test("keyDown should handle F12/BREAK", () => {
        const event = {
            which: utils.keyCodes.F12,
            location: 0,
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

    test("keyUp should handle F12/BREAK", () => {
        const event = {
            which: utils.keyCodes.F12,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
        };

        keyboard.setRunning(true);
        keyboard.keyUp(event);

        expect(mockProcessor.setReset).toHaveBeenCalledWith(false);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    test("clearKeys should call sysvia.clearKeys", () => {
        keyboard.clearKeys();
        expect(mockSysvia.clearKeys).toHaveBeenCalled();
    });

    test("setKeyLayout should update config and call processor to update layout", () => {
        keyboard.setKeyLayout("gaming");
        expect(mockSysvia.setKeyLayout).toHaveBeenCalledWith("gaming");
    });

    test("registerKeyHandler should add a handler for a key", () => {
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(utils.keyCodes.Q, mockHandler);

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

    test("pauseEmulation should set pause flag and call stopCallback", () => {
        const stopCallback = vi.fn();
        keyboard.stopCallback = stopCallback;

        keyboard.pauseEmulation();

        expect(keyboard.pauseEmu).toBe(true);
        expect(stopCallback).toHaveBeenCalledWith(false);
    });

    test("resumeEmulation should clear pause flag and call goCallback", () => {
        const goCallback = vi.fn();
        keyboard.goCallback = goCallback;
        keyboard.pauseEmu = true;

        keyboard.resumeEmulation();

        expect(keyboard.pauseEmu).toBe(false);
        expect(goCallback).toHaveBeenCalled();
    });
});
