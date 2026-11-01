import { BBC } from "./keymap.js";
import { cycleCount } from "./lockstep.js";

const RepeatedKeyGapMs = 30;
const StoppedPollMs = 100;

// Counted in the cycles Typist.execute runs, so the delays stay in emulated time whatever the CPU multiplier is,
// and each key change goes in between instructions, where the replay's InputLog records it as any key press.
function cycleTimer(processor, callback) {
    let cyclesLeft = Infinity;
    return {
        start(ms) {
            cyclesLeft = Math.ceil((ms * processor.peripheralCyclesPerSecond * processor.cpuMultiplier) / 1000);
        },
        cancel() {
            cyclesLeft = Infinity;
        },
        running: () => cyclesLeft !== Infinity,
        get cyclesLeft() {
            return cyclesLeft;
        },
        ran(cycles) {
            cyclesLeft -= cycles;
            if (cyclesLeft > 0) return;
            cyclesLeft = Infinity;
            callback();
        },
    };
}

// Keys typed while the machine is stopped would all go in at the cycle it starts again, so a delay that comes due
// with the machine stopped starts again once it runs.
function wallClockTimer(callback, isRunning) {
    let timeout = null;
    const fire = () => {
        timeout = null;
        callback();
    };
    const waitForMachine = (ms) => {
        timeout = setTimeout(() => (isRunning() ? timer.start(ms) : waitForMachine(ms)), StoppedPollMs);
    };
    const timer = {
        start(ms) {
            timeout = setTimeout(() => (isRunning() ? fire() : waitForMachine(ms)), ms);
        },
        cancel() {
            clearTimeout(timeout);
            timeout = null;
        },
        running: () => timeout !== null,
        cyclesLeft: Infinity,
        ran() {},
    };
    return timer;
}

/**
 * The keyboard as the typist drives it, with each key pressed and released through `input` (a Keyboard's) instead
 * of in the matrix. Nothing is disabled: the machine's keys are not this page's to take.
 */
function keysThrough(input, keyInterface) {
    const held = new Map();
    return {
        get capsLockLight() {
            return keyInterface.capsLockLight;
        },
        get shiftLockLight() {
            return keyInterface.shiftLockLight;
        },
        keyToggleRaw(key) {
            const name = key.join();
            const down = !held.has(name);
            if (down) held.set(name, key);
            else held.delete(name);
            input.keyRaw(key, down);
        },
        disableKeyboard() {},
        enableKeyboard() {
            for (const key of held.values()) input.keyRaw(key, false);
            held.clear();
        },
    };
}

/**
 * Types a key sequence into the keyboard, one key per tick. An entry is one of the model's raw keys, or a number
 * of milliseconds to wait. SHIFT toggles and stays held; any other key is pressed on one tick and released on the
 * next.
 */
export class Typist {
    /**
     * @param {object} processor
     * @param {{input: object, isRunning: function(): boolean}} [through] an input, as `Keyboard.setInput` takes, to
     *   press the keys through one by one as someone typing would, timed by the wall clock while `isRunning` says
     *   the machine runs; without one they go straight into the matrix, timed by the cycles `execute` runs
     */
    constructor(processor, through) {
        this.processor = processor;
        this.keyInterface = through
            ? keysThrough(through.input, processor.keyboardInterface)
            : processor.keyboardInterface;
        this._shiftKey = processor.model.keys.SHIFT;
        this._keys = [];
        this._lastKey = undefined;
        const deliver = () => this._deliver();
        this._timer = through ? wallClockTimer(deliver, through.isRunning) : cycleTimer(processor, deliver);
    }

    /**
     * Runs the processor for `cycles`, as its own execute does, stopping between instructions to change each key
     * that comes due on the way.
     */
    execute(cycles) {
        const { processor } = this;
        let left = cycles;
        for (;;) {
            const run = Math.min(left, this._timer.cyclesLeft);
            const from = cycleCount(processor);
            const running = processor.execute(run);
            left -= run;
            this._timer.ran(cycleCount(processor) - from);
            if (!running || left <= 0) return running;
        }
    }

    /**
     * @param {Array} keys raw keys and millisecond delays, consumed as they are sent
     * @param {boolean} checkCapsAndShiftLocks bracket the keys with a lock toggle when
     *   the machine's lock lights say the letters would come out in the wrong case
     */
    type(keys, checkCapsAndShiftLocks) {
        if (this.isTyping) this.cancel();
        this.keyInterface.disableKeyboard();

        if (checkCapsAndShiftLocks) {
            let toggleKey = null;
            if (!this.keyInterface.capsLockLight) toggleKey = BBC.CAPSLOCK;
            else if (this.keyInterface.shiftLockLight) toggleKey = BBC.SHIFTLOCK;
            if (toggleKey) {
                keys.unshift(toggleKey);
                keys.push(toggleKey);
            }
        }

        this._keys = keys;
        this._lastKey = undefined;
        // The first press gets the release gap too, as the key before it may have gone up just now.
        this._timer.start(this.processor.model.pasteReleaseGapMs);
    }

    cancel() {
        if (!this.isTyping) return;
        this._timer.cancel();
        this._releaseLastKey();
        this._lastKey = undefined;
        this._keys = [];
        this.keyInterface.enableKeyboard();
    }

    get isTyping() {
        return this._keys.length > 0 || this._timer.running();
    }

    _releaseLastKey() {
        if (this._lastKey && this._lastKey !== this._shiftKey) this.keyInterface.keyToggleRaw(this._lastKey);
    }

    _deliver() {
        this._releaseLastKey();

        if (this._keys.length === 0) {
            this._lastKey = undefined;
            this.keyInterface.enableKeyboard();
            return;
        }

        const releaseGapMs = this.processor.model.pasteReleaseGapMs;
        if (this._lastKey && this._lastKey !== this._shiftKey && releaseGapMs) {
            this._lastKey = undefined;
            this._timer.start(releaseGapMs);
            return;
        }

        const key = this._keys[0];
        const repeated = this._lastKey === key;
        this._lastKey = key;
        if (repeated) {
            this._lastKey = undefined;
            this._timer.start(RepeatedKeyGapMs);
            return;
        }

        let delayMs = this.processor.model.pasteKeyDelayMs;
        if (typeof key === "number") {
            delayMs = key;
            this._lastKey = undefined;
        } else {
            this.keyInterface.keyToggleRaw(key);
        }

        this._keys.shift();
        this._timer.start(delayMs);
    }
}
