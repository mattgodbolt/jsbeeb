import { expect, describe, test, beforeEach, vi } from "vitest";
import { Keyboard } from "../../src/keyboard.js";
import { Scheduler } from "../../src/scheduler.js";
import * as utils from "../../src/utils.js";
import { ATOM, stringToATOMKeys } from "../../src/utils_atom.js";

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
            model: { isAtom: false },
            sysvia: mockSysvia,
            scheduler: new Scheduler(),
            setReset: vi.fn(),
            cpuMultiplier: 1,
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

        const breakState = await triggerAndWaitForEvent("break", () => {
            keyboard.keyDown(event);
        });

        expect(mockProcessor.setReset).toHaveBeenCalledWith(true);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(breakState.detail).toBe(true);
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
        keyboard.addEventListener("resume", resumeListener);

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
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("registered handler suppresses sysvia.keyDown for that key", () => {
        // When a handler claims a key, the BBC Micro should NOT also receive it.
        const mockHandler = vi.fn();
        keyboard.registerKeyHandler(utils.keyCodes.K1, mockHandler, { alt: true, ctrl: false });

        keyboard.setRunning(true);
        keyboard.keyDown({
            which: utils.keyCodes.K1,
            location: 0,
            preventDefault: vi.fn(),
            altKey: true,
            ctrlKey: false,
            shiftKey: false,
        });

        expect(mockHandler).toHaveBeenCalledWith(true, utils.keyCodes.K1);
        expect(mockSysvia.keyDown).not.toHaveBeenCalled();
    });

    test("unhandled keys still reach sysvia.keyDown", () => {
        keyboard.setRunning(true);
        keyboard.keyDown({
            which: utils.keyCodes.A,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
        });

        expect(mockSysvia.keyDown).toHaveBeenCalledWith(utils.keyCodes.A, false);
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

    test("sendRawKeyboard should disable keyboard and schedule paste task", () => {
        keyboard.sendRawKeyboard([utils.BBC.A], false);

        expect(mockSysvia.disableKeyboard).toHaveBeenCalled();
        expect(keyboard.isPasting).toBe(true);
    });

    test("sendRawKeyboard should deliver keys via scheduler and re-enable keyboard", () => {
        keyboard.sendRawKeyboard([utils.BBC.A], false);

        // First scheduler fire: presses the key
        mockProcessor.scheduler.polltime(1);
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledWith(utils.BBC.A);
        expect(keyboard.isPasting).toBe(true);

        // Second scheduler fire after delay: releases key, sees empty queue, re-enables keyboard
        const delayCycles =
            (50 * Math.floor(mockProcessor.cpuMultiplier * mockProcessor.peripheralCyclesPerSecond)) / 1000;
        mockProcessor.scheduler.polltime(delayCycles);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
        expect(keyboard.isPasting).toBe(false);
    });

    test("cancelPaste should stop paste and re-enable keyboard", () => {
        keyboard.sendRawKeyboard([utils.BBC.A, utils.BBC.B, utils.BBC.C], false);
        mockProcessor.scheduler.polltime(1); // deliver first key

        keyboard.cancelPaste();

        expect(keyboard.isPasting).toBe(false);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
    });

    test("Escape should cancel paste during keyDown", () => {
        keyboard.sendRawKeyboard([utils.BBC.A, utils.BBC.B], false);
        keyboard.setRunning(true);

        const escEvent = {
            which: utils.keyCodes.ESCAPE,
            location: 0,
            preventDefault: vi.fn(),
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
        };
        keyboard.keyDown(escEvent);

        expect(keyboard.isPasting).toBe(false);
        expect(mockSysvia.enableKeyboard).toHaveBeenCalled();
    });

    test("sendRawKeyboard should handle numeric delay entries", () => {
        keyboard.sendRawKeyboard([1000, utils.BBC.A], false);
        const clocksPerMs = Math.floor(mockProcessor.cpuMultiplier * mockProcessor.peripheralCyclesPerSecond) / 1000;

        // First fire: numeric delay consumed, no key toggled yet
        mockProcessor.scheduler.polltime(1);
        expect(mockSysvia.keyToggleRaw).not.toHaveBeenCalled();
        expect(keyboard.isPasting).toBe(true);

        // After 1000ms delay: key A delivered
        mockProcessor.scheduler.polltime(1000 * clocksPerMs);
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledWith(utils.BBC.A);
    });

    test("sendRawKeyboard should debounce consecutive identical keys", () => {
        keyboard.sendRawKeyboard([utils.BBC.A, utils.BBC.A], false);
        const clocksPerMs = Math.floor(mockProcessor.cpuMultiplier * mockProcessor.peripheralCyclesPerSecond) / 1000;

        // First fire: press A
        mockProcessor.scheduler.polltime(1);
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledTimes(1);

        // Second fire after 50ms: release A, then debounce (same char)
        mockProcessor.scheduler.polltime(50 * clocksPerMs);
        // keyToggleRaw called twice: once to release A, once because debounce path
        // releases previous char then skips pressing
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledTimes(2);

        // After 30ms debounce: press A again
        mockProcessor.scheduler.polltime(30 * clocksPerMs);
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledTimes(3);
    });

    test("sendRawKeyboard while already pasting should cancel previous paste", () => {
        keyboard.sendRawKeyboard([utils.BBC.A, utils.BBC.B, utils.BBC.C], false);
        mockProcessor.scheduler.polltime(1); // deliver first key

        // Start a new paste mid-stream
        keyboard.sendRawKeyboard([utils.BBC.X], false);

        // Old paste should be cancelled, new one in progress
        expect(keyboard.isPasting).toBe(true);

        // Deliver new paste
        mockProcessor.scheduler.polltime(1);
        expect(mockSysvia.keyToggleRaw).toHaveBeenCalledWith(utils.BBC.X);
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
            model: { isAtom: true },
            atomppia: mockAtomPPIA,
            sysvia: { keyDown: vi.fn(), keyUp: vi.fn() },
            scheduler: new Scheduler(),
            setReset: vi.fn(),
            cpuMultiplier: 1,
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

    test("should select atomppia as keyInterface when isAtom is true", () => {
        expect(keyboard.keyInterface).toBe(mockAtomPPIA);
    });

    test("keyDown should route to PPIA, not SysVia", () => {
        const evt = { which: 65, location: 0, shiftKey: false, altKey: false, ctrlKey: false, preventDefault: vi.fn() };
        keyboard.keyDown(evt);
        expect(mockAtomPPIA.keyDown).toHaveBeenCalledWith(65, false);
        expect(mockProcessor.sysvia.keyDown).not.toHaveBeenCalled();
    });

    test("keyUp should route to PPIA", () => {
        const evt = { which: 65, location: 0, altKey: false, ctrlKey: false, preventDefault: vi.fn() };
        keyboard.keyUp(evt);
        expect(mockAtomPPIA.keyUp).toHaveBeenCalledWith(65);
    });

    test("sendRawKeyboard should not inject lock toggles for Atom", () => {
        // PPIA reports capsLockLight=true, shiftLockLight=false,
        // so the paste logic should not prepend/append any lock keys.
        mockAtomPPIA.capsLockLight = true;
        mockAtomPPIA.shiftLockLight = false;
        const keys = [utils.BBC.A];
        keyboard.sendRawKeyboard(keys, true);
        expect(mockAtomPPIA.disableKeyboard).toHaveBeenCalled();
        // The keys array should not have been modified with lock toggles
        expect(keys).toEqual([utils.BBC.A]);
    });

    test("setKeyLayout should call PPIA setKeyLayout", () => {
        keyboard.setKeyLayout("natural");
        expect(mockAtomPPIA.setKeyLayout).toHaveBeenCalledWith("natural");
    });

    test("paste should insert debounce gap between key release and next key press", () => {
        const ATOM_A = [3, 3]; // Atom 'A' key position
        const ATOM_B = [3, 4]; // Atom 'B' key position
        keyboard.sendRawKeyboard([ATOM_A, ATOM_B], false);
        const clocksPerMs = Math.floor(mockProcessor.cpuMultiplier * mockProcessor.peripheralCyclesPerSecond) / 1000;

        // First fire: press A
        mockProcessor.scheduler.polltime(1);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledTimes(1);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledWith(ATOM_A);

        // After 80ms (Atom uses longer hold): release A, then debounce gap
        mockProcessor.scheduler.polltime(80 * clocksPerMs);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledTimes(2); // release A only
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenLastCalledWith(ATOM_A); // toggle off

        // After 30ms debounce: press B
        mockProcessor.scheduler.polltime(30 * clocksPerMs);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledTimes(3);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenLastCalledWith(ATOM_B);
    });

    test("paste should not insert debounce gap after SHIFT key", () => {
        const ATOM_A = [3, 3];
        // Simulate a shifted character: SHIFT held, then A pressed
        keyboard.sendRawKeyboard([ATOM.SHIFT, ATOM_A], false);
        const clocksPerMs = Math.floor(mockProcessor.cpuMultiplier * mockProcessor.peripheralCyclesPerSecond) / 1000;

        // First fire: press SHIFT
        mockProcessor.scheduler.polltime(1);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledTimes(1);

        // After 80ms: SHIFT is not released (it's the shift key), and A should
        // be pressed immediately — no debounce gap for SHIFT.
        mockProcessor.scheduler.polltime(80 * clocksPerMs);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenCalledTimes(2);
        expect(mockAtomPPIA.keyToggleRaw).toHaveBeenLastCalledWith(ATOM_A);
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
