import { vi } from "vitest";

import { findModel } from "../../src/models.js";
import { Scheduler } from "../../src/scheduler.js";

const BbcPeripheralCyclesPerSecond = 2 * 1000 * 1000;
const AtomPeripheralCyclesPerSecond = 1000 * 1000;

/**
 * Enough of a processor for a Keyboard: its key interface (the System VIA, or the PPIA on an Atom) as spies,
 * the reset line, and a scheduler for a paste to type on.
 */
export function fakeKeyboardProcessor(modelName = "B-DFS1.2") {
    const model = findModel(modelName);
    const keys = {
        keyDown: vi.fn(),
        keyUp: vi.fn(),
        keyUpRaw: vi.fn(),
        clearKeys: vi.fn(),
        disableKeyboard: vi.fn(),
        enableKeyboard: vi.fn(),
        keyToggleRaw: vi.fn(),
        setKeyLayout: vi.fn(),
        capsLockLight: false,
        shiftLockLight: false,
    };
    return {
        model,
        keyboardInterface: keys,
        ...(model.isAtom ? { atomppia: keys, sysvia: { keyDown: vi.fn(), keyUp: vi.fn() } } : { sysvia: keys }),
        setKeyLayout: vi.fn(),
        setReset: vi.fn(),
        scheduler: new Scheduler(),
        peripheralCyclesPerSecond: model.isAtom ? AtomPeripheralCyclesPerSecond : BbcPeripheralCyclesPerSecond,
        cycleSeconds: 0,
        currentCycles: 0,
    };
}
