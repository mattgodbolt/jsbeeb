import { BBC } from "./keymap.js";

const RepeatedKeyGapMs = 30;
const StoppedPollMs = 100;

// The processor's scheduler is polled with peripheral cycles, so the delays stay in real time whatever the CPU
// multiplier is. A task fires part way through an instruction, so it only stops the processor (see deliverPending).
function schedulerTimer(processor, callback) {
    const task = processor.scheduler.newTask(callback);
    return {
        start: (ms) => task.schedule((ms * processor.peripheralCyclesPerSecond) / 1000),
        cancel: () => task.cancel(),
        running: () => task.scheduled(),
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
     *   the machine runs; without one they go straight into the matrix, timed by the processor's scheduler
     */
    constructor(processor, through) {
        this.processor = processor;
        this.keyInterface = through
            ? keysThrough(through.input, processor.keyboardInterface)
            : processor.keyboardInterface;
        this._shiftKey = processor.model.keys.SHIFT;
        this._keys = [];
        this._lastKey = undefined;
        this._pending = false;
        this._stoppedByOther = false;
        this._stopsAtDue = 0;
        this._loadsAtDue = 0;
        this._timer = through
            ? wallClockTimer(() => this._deliver(), through.isRunning)
            : schedulerTimer(processor, () => this._due());
    }

    /**
     * Changes the keys that came due while the processor ran, which stopped it at the end of the instruction they
     * came due in. Returns whether the run should go on: false if nothing was due, or if something else (a
     * breakpoint, a watch) stopped the processor in that instruction too.
     */
    deliverPending() {
        // A restored snapshot has cancelled the scheduler task and replaced the matrix, so the text left to type
        // is stranded.
        if (this._stranded || (this._pending && this.processor.resetsAndLoads !== this._loadsAtDue)) {
            this._pending = false;
            this._abandon();
            return false;
        }
        if (!this._pending) return false;
        this._pending = false;
        this._deliver();
        return !this._stoppedByOther && this.processor.stops === this._stopsAtDue;
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
        if (!this._stranded) this._releaseLastKey();
        this._pending = false;
        this._abandon();
    }

    get _stranded() {
        return this._keys.length > 0 && !this._timer.running() && !this._pending;
    }

    _abandon() {
        this._timer.cancel();
        this._lastKey = undefined;
        this._keys = [];
        this.keyInterface.enableKeyboard();
    }

    get isTyping() {
        return this._keys.length > 0 || this._timer.running() || this._pending;
    }

    _due() {
        const { processor } = this;
        this._stoppedByOther = processor.halted;
        processor.stop();
        this._stopsAtDue = processor.stops;
        this._loadsAtDue = processor.resetsAndLoads;
        this._pending = true;
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
