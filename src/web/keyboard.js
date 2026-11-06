import { isUserRemapped, keyCodes } from "../keymap.js";
import { Typist } from "../typist.js";

export const isMac = typeof window !== "undefined" && /^Mac/i.test(window.navigator?.platform || "");
const InputMethodKeyCode = 229;
const KeypadNavigationKeys = new Set([
    keyCodes.END,
    keyCodes.HOME,
    keyCodes.PAGEUP,
    keyCodes.PAGEDOWN,
    keyCodes.INSERT,
    keyCodes.LEFT,
    keyCodes.UP,
    keyCodes.RIGHT,
    keyCodes.DOWN,
]);
const Modifiers = [
    { codes: [keyCodes.SHIFT_LEFT, keyCodes.SHIFT_RIGHT], isDown: (evt) => evt.shiftKey },
    { codes: [keyCodes.CTRL_LEFT, keyCodes.CTRL_RIGHT], isDown: (evt) => evt.ctrlKey },
];

const isComposing = (evt) => evt.key === "Process" || evt.keyCode === InputMethodKeyCode;

/**
 * @typedef {Object} KeyboardConfig
 * @property {Object} processor - The processor instance
 * @property {Typist} typist - The machine's own, which pastes are typed by outside a session and the machine is run through
 * @property {Function} inputEnabledFunction - A function to check if input is enabled
 * @property {Function} runningFunction - Whether the machine is running, and so takes keys
 * @property {Function} [resetInputMethodFunction] - Drops a dead key the host's input method is holding
 * @property {string} [keyLayout="physical"] - The keyboard layout
 */

/**
 * Keyboard class that handles all keyboard related functionality
 */
export class Keyboard extends EventTarget {
    /**
     * Create a new Keyboard instance with specified configuration
     * @param {KeyboardConfig} config - The configuration object
     */
    constructor(config) {
        super();
        const {
            processor,
            typist,
            inputEnabledFunction,
            shortcutsBlockedFunction,
            runningFunction,
            resetInputMethodFunction = () => {},
            keyLayout = "physical",
        } = config;

        // Core components
        this.processor = processor;
        this.inputEnabledFunction = inputEnabledFunction;
        this.shortcutsBlockedFunction = shortcutsBlockedFunction ?? (() => false);
        this.runningFunction = runningFunction;
        this.resetInputMethodFunction = resetInputMethodFunction;

        this.keyInterface = processor.keyboardInterface;
        this.machineTypist = typist;
        this.typist = this.machineTypist;
        this.input = this.directInput();

        // State
        this.altKeyHandlers = new Map();
        this.keyLayout = keyLayout;
        this.saidCapsLockIsTapped = false;
        this.releases = new Map();
        this.heldDeadKeys = new Set();
    }

    /** Key presses and BREAK straight to the machine. */
    directInput() {
        return {
            keyDown: (...args) => this.keyInterface.keyDown(...args),
            keyUp: (key) => this.keyInterface.keyUp(key),
            keyRaw: (colRow, down) =>
                down ? this.keyInterface.keyDownRaw(colRow) : this.keyInterface.keyUpRaw(colRow),
            setReset: (resetting) => this.processor.setReset(resetting),
            clearKeys: () => this.keyInterface.clearKeys(),
        };
    }

    /**
     * Routes key presses, pastes and BREAK through `input`, or straight to the machine again with
     * null, which starts it with nothing held: a session's keys go with the session. A paste is typed
     * through `input.keyRaw(colRow, down)`.
     */
    setInput(input) {
        this.cancelPaste();
        this.clearKeys();
        this.input = input ?? this.directInput();
        this.typist = input
            ? new Typist(this.processor, { input, isRunning: this.runningFunction })
            : this.machineTypist;
        this.input.clearKeys();
    }

    /**
     * The host key a keyboard event came from, by physical position. jsbeeb's own shortcuts
     * and special keys are always by position, whatever layout the machine is using.
     * @param {KeyboardEvent} evt - The keyboard event
     * @returns {string} - A `KeyboardEvent.code` name
     */
    keyCode(evt) {
        return evt.code;
    }

    /**
     * How the emulated machine's key map names the key this event came from. The natural
     * layout is keyed by the character the host produced, so that what you type comes out
     * right whatever layout the host keyboard is in; every other layout is by position. A
     * keypad key with Num Lock off is, in every layout, the navigation key it stands in for.
     * @param {KeyboardEvent} evt - The keyboard event
     * @returns {string}
     */
    _machineKey(evt) {
        // A `KEY.` parameter names a key by where it is, so it outranks what the key prints.
        if (isUserRemapped(evt.code)) return evt.code;
        // Even in the natural layout, a keypad key is the Master's keypad, not the character it types.
        if (evt.code?.startsWith("Numpad")) return KeypadNavigationKeys.has(evt.key) ? evt.key : evt.code;
        if (this.keyLayout !== "natural") return evt.code;
        return evt.key?.length === 1 ? evt.key : evt.code;
    }

    /**
     * Registers a handler for Alt and a key, held without Ctrl.
     * @param {string} keyCode - The host key, by physical position
     * @param {Function} handler - Called as (down, code, shiftKey) on the way down and up
     */
    registerAltKeyHandler(keyCode, handler) {
        this.altKeyHandlers.set(keyCode, handler);
    }

    /**
     * Updates the current key layout
     * @param {string} layout - The keyboard layout to use
     */
    setKeyLayout(layout) {
        // Anything still held was named by the old layout, so release it before the names change.
        this.clearKeys();
        this.keyLayout = layout;
        this.processor.setKeyLayout(layout);
    }

    /**
     * Handles a key down event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyDown(evt) {
        const code = this.keyCode(evt);
        this._releaseKeysShownUp(evt, code);
        const stale = this.releases.get(code);
        if (evt.repeat && this._shortcutFor(evt, code)) {
            evt.preventDefault();
            return;
        }
        if (evt.repeat && stale) {
            if (!this.inputEnabledFunction()) evt.preventDefault();
            return;
        }
        // A fresh press of a key still held means its key up was lost, as macOS does for a key
        // released while Cmd is down.
        stale?.();
        this.releases.delete(code);
        const release = this._press(evt, code);
        if (release) this.releases.set(code, release);
    }

    _shortcutFor(evt, code) {
        if (!evt.altKey || evt.ctrlKey || this.shortcutsBlockedFunction()) return null;
        return this.altKeyHandlers.get(code) ?? null;
    }

    /** @returns {(() => void)|null} how to undo the press, or null if there is nothing to undo */
    _press(evt, code) {
        // Shortcuts come first, so they work while the machine is stopped and from inside the media window.
        const handler = this._shortcutFor(evt, code);
        if (handler) {
            evt.preventDefault();
            handler(true, code, evt.shiftKey);
            return () => handler(false, code);
        }

        if (this.inputEnabledFunction() || !this.runningFunction()) return null;
        evt.preventDefault();

        if (code === keyCodes.F12 || code === keyCodes.BREAK) {
            this.input.setReset(true);
            return () => this.input.setReset(false);
        }

        if (isMac && code === keyCodes.CAPSLOCK) {
            this.handleMacCapsLock();
            return null;
        }

        if (this.isPasting) {
            if (code === keyCodes.ESCAPE) this.cancelPaste();
            return null;
        }

        if (isComposing(evt)) return null;
        const machineKey = this._machineKey(evt);
        this.input.keyDown(machineKey, evt.shiftKey);
        if (evt.key !== "Dead") return () => this.input.keyUp(machineKey);
        // Stops the host's input method composing the next key with this one, as "Process" with no key up.
        this.resetInputMethodFunction();
        this.heldDeadKeys.add(code);
        return () => {
            this.heldDeadKeys.delete(code);
            this.input.keyUp(machineKey);
        };
    }

    /**
     * Lets go of held keys whose key up was lost, when this event shows they are up: a modifier
     * the event says is not held, and, once the input method composes the next key (which is
     * what Linux sends in place of a dead key's key up), any dead key.
     */
    _releaseKeysShownUp(evt, code) {
        const up = [];
        for (const { codes, isDown } of Modifiers) {
            if (!isDown(evt) && !codes.includes(code)) up.push(...codes);
        }
        if (isComposing(evt)) up.push(...this.heldDeadKeys);
        for (const heldCode of up) {
            const release = this.releases.get(heldCode);
            if (!release) continue;
            this.releases.delete(heldCode);
            release();
        }
    }

    /**
     * Handles a key up event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyUp(evt) {
        const code = this.keyCode(evt);
        this._releaseKeysShownUp(evt, code);
        if (isMac && code === keyCodes.CAPSLOCK) {
            this._press(evt, code);
            return;
        }
        const release = this.releases.get(code);
        if (!release) return;
        this.releases.delete(code);
        evt.preventDefault();
        release();
    }

    /**
     * Special handling for Mac's Caps Lock key behavior
     */
    handleMacCapsLock() {
        const CAPS_LOCK_DELAY = 100;

        // Mac browsers seem to model caps lock as a physical key that's down when capslock is on, and up when it's off.
        // No event is generated when it is physically released on the keyboard. So, we simulate a "tap" here.
        this.input.keyDown(keyCodes.CAPSLOCK);

        // Simulate a key release after a short delay
        setTimeout(() => this.input.keyUp(keyCodes.CAPSLOCK), CAPS_LOCK_DELAY);

        if (this.saidCapsLockIsTapped) return;
        this.saidCapsLockIsTapped = true;
        this.dispatchEvent(
            new CustomEvent("notice", {
                detail: {
                    message:
                        "macOS sends no key up for caps lock, so jsbeeb can only tap it. " +
                        "For a game that holds caps lock for left or fire, remap that key instead.",
                    title: "Keyboard",
                    quietKey: "warnedAboutRubbishMacs",
                },
            }),
        );
    }

    /** Sends raw keys, and millisecond delays, to the machine: paste and autoboot come through here. */
    sendRawKeyboard(keysToSend, checkCapsAndShiftLocks) {
        this.clearKeys();
        this.typist.type(keysToSend, checkCapsAndShiftLocks);
    }

    cancelPaste() {
        this.typist.cancel();
    }

    get isPasting() {
        return this.typist.isTyping;
    }

    /**
     * Clears all pressed keys
     */
    clearKeys() {
        for (const release of this.releases.values()) release();
        this.releases.clear();
        // A session's machine is everyone's: only this person's keys are theirs to let go.
        this.input.clearKeys();
    }
}
