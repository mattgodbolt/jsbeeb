import { BBC } from "./keymap.js";

const RepeatedKeyGapMs = 30;

/**
 * Types a key sequence into the keyboard matrix from the processor's
 * scheduler, one key per tick, so the CPU stays on its fast path while the
 * text arrives. An entry is one of the model's raw keys, or a number of
 * milliseconds to wait. SHIFT toggles and stays held; any other key is pressed
 * on one tick and released on the next.
 */
export class Typist {
    constructor(processor) {
        this.processor = processor;
        this.keyInterface = processor.keyboardInterface;
        this._shiftKey = processor.model.keys.SHIFT;
        this._keys = [];
        this._lastKey = undefined;
        this._clocksPerMs = 0;
        this._task = processor.scheduler.newTask(() => this._deliver());
    }

    /**
     * @param {Array} keys raw keys and millisecond delays, consumed as they are sent
     * @param {boolean} checkCapsAndShiftLocks bracket the keys with a lock toggle when
     *   the machine's lock lights say the letters would come out in the wrong case
     */
    type(keys, checkCapsAndShiftLocks) {
        if (this.isTyping) this.cancel();
        this.keyInterface.disableKeyboard();
        // The task lives on the processor's scheduler, which is polled with peripheral
        // cycles, so the delays stay in real time whatever the CPU multiplier is.
        this._clocksPerMs = this.processor.peripheralCyclesPerSecond / 1000;

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
        this._task.schedule(0);
    }

    cancel() {
        if (!this.isTyping) return;
        this._task.cancel();
        this._releaseLastKey();
        this._lastKey = undefined;
        this._keys = [];
        this.keyInterface.enableKeyboard();
    }

    get isTyping() {
        return this._keys.length > 0 || this._task.scheduled();
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
            this._task.schedule(releaseGapMs * this._clocksPerMs);
            return;
        }

        const key = this._keys[0];
        const repeated = this._lastKey === key;
        this._lastKey = key;
        if (repeated) {
            this._lastKey = undefined;
            this._task.schedule(RepeatedKeyGapMs * this._clocksPerMs);
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
        this._task.schedule(delayMs * this._clocksPerMs);
    }
}
