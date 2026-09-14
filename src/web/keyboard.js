import { isUserRemapped, keyCodes } from "../keymap.js";
import { Typist } from "../typist.js";

const isMac = typeof window !== "undefined" && /^Mac/i.test(window.navigator?.platform || "");

/**
 * @typedef {Object} KeyboardConfig
 * @property {Object} processor - The processor instance
 * @property {Function} inputEnabledFunction - A function to check if input is enabled
 * @property {string} [keyLayout="physical"] - The keyboard layout
 * @property {Debugger} dbgr - The debugger instance
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
        const { processor, inputEnabledFunction, shortcutsBlockedFunction, keyLayout = "physical", dbgr } = config;

        // Core components
        this.processor = processor;
        this.inputEnabledFunction = inputEnabledFunction;
        this.shortcutsBlockedFunction = shortcutsBlockedFunction ?? (() => false);
        this.dbgr = dbgr;

        this.keyInterface = processor.keyboardInterface;
        this.typist = new Typist(processor);

        // State
        this.emuKeyHandlers = {};
        this.running = false;
        this.pauseEmu = false;
        this.stepEmuWhenPaused = false;
        this.keyLayout = keyLayout;
        this.saidCapsLockIsTapped = false;
        this.releases = new Map();
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
     * right whatever layout the host keyboard is in; every other layout is by position.
     * @param {KeyboardEvent} evt - The keyboard event
     * @returns {string}
     */
    _machineKey(evt) {
        if (this.keyLayout !== "natural") return evt.code;
        // A `KEY.` parameter names a key by where it is, so it outranks what the key prints.
        if (isUserRemapped(evt.code)) return evt.code;
        // The Master's keypad is a separate set of keys from the digits above the letters, and
        // the characters cannot tell them apart.
        if (evt.code?.startsWith("Numpad")) return evt.code;
        return evt.key?.length === 1 ? evt.key : evt.code;
    }

    /**
     * Registers a handler for a specific key with optional modifiers
     * @param {string} keyCode - The host key, by physical position
     * @param {Function} handler - Called as (down, code, shiftKey) on the way down and up
     * @param {Object} [options] - Options for this handler
     * @param {boolean} [options.alt=true] - Whether this handler requires the Alt key
     * @param {boolean} [options.ctrl=false] - Whether this handler requires the Ctrl key
     */
    registerKeyHandler(keyCode, handler, options = { alt: true, ctrl: false }) {
        // Generate a unique key that includes modifiers
        const handlerKey = `${options.alt ? "alt:" : ""}${options.ctrl ? "ctrl:" : ""}${keyCode}`;
        this.emuKeyHandlers[handlerKey] = {
            handler,
            alt: !!options.alt,
            ctrl: !!options.ctrl,
            keyCode,
        };
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
     * Sets the running state of the emulator
     * @param {boolean} isRunning - Whether the emulator is running
     */
    setRunning(isRunning) {
        this.running = isRunning;
    }

    /**
     * Find a matching key handler for the given key event
     * @param {string} keyCode - The host key, by physical position
     * @param {boolean} altKey - Whether Alt is pressed
     * @param {boolean} ctrlKey - Whether Ctrl is pressed
     * @returns {Object|null} The handler object or null if none found
     * @private
     */
    _findKeyHandler(keyCode, altKey, ctrlKey) {
        // Try to find a handler with exact modifier match first
        const exactModKey = `${altKey ? "alt:" : ""}${ctrlKey ? "ctrl:" : ""}${keyCode}`;
        if (this.emuKeyHandlers[exactModKey]) {
            return this.emuKeyHandlers[exactModKey];
        }

        return null;
    }

    /**
     * Handles a key press event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyPress(evt) {
        // Early returns for common scenarios
        // Check if input is enabled. If inputEnabledFunction returns true, keyboard events should not be processed.
        if (this.inputEnabledFunction()) return;
        if (this.running || (!this.dbgr.enabled() && !this.pauseEmu)) return;

        // The debugger's keys are the characters they print, not positions.
        const key = evt.key;

        // Handle debugger 'g' key press
        if (this.dbgr.enabled() && key === "g") {
            this.dbgr.hide();
            this.dispatchEvent(new Event("resume"));
            return;
        }

        // Handle pause/step control keys
        if (this.pauseEmu) {
            if (key === "g") {
                this.resumeEmulation();
                return;
            } else if (key === "n") {
                this.requestStep();
                this.dispatchEvent(new Event("resume"));
                return;
            }
        }

        // Pass any other keys to the debugger if it's enabled
        if (this.dbgr.enabled()) {
            const handled = this.dbgr.keyPress(key);
            if (handled) evt.preventDefault();
        }
    }

    /**
     * Handles a key down event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyDown(evt) {
        const code = this.keyCode(evt);
        const stale = this.releases.get(code);
        if (stale && evt.repeat) {
            evt.preventDefault();
            return;
        }
        // A fresh press of a key still held means its key up was lost, as macOS does for a key
        // released while Cmd is down.
        stale?.();
        this.releases.delete(code);
        const release = this._press(evt, code);
        if (release) this.releases.set(code, release);
    }

    /** @returns {(() => void)|null} how to undo the press, or null if there is nothing to undo */
    _press(evt, code) {
        // Shortcuts come first, so they work while the machine is stopped and from inside the media window.
        const handler = this.shortcutsBlockedFunction() ? null : this._findKeyHandler(code, evt.altKey, evt.ctrlKey);
        if (handler) {
            evt.preventDefault();
            handler.handler(true, code, evt.shiftKey);
            return () => handler.handler(false, code);
        }

        if (this.inputEnabledFunction() || !this.running) return null;
        evt.preventDefault();

        if (this.isPasting && code === keyCodes.ESCAPE) {
            this.cancelPaste();
            return null;
        }

        if (code === keyCodes.F12 || code === keyCodes.BREAK) {
            this.dispatchEvent(new CustomEvent("break", { detail: true }));
            this.processor.setReset(true);
            return () => {
                this.dispatchEvent(new CustomEvent("break", { detail: false }));
                this.processor.setReset(false);
            };
        }

        if (isMac && code === keyCodes.CAPSLOCK) {
            this.handleMacCapsLock();
            return null;
        }

        const machineKey = this._machineKey(evt);
        this.keyInterface.keyDown(machineKey, evt.shiftKey);
        return () => this.keyInterface.keyUp(machineKey);
    }

    /**
     * Handles a key up event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyUp(evt) {
        const code = this.keyCode(evt);
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
        this.keyInterface.keyDown(keyCodes.CAPSLOCK);

        // Simulate a key release after a short delay
        setTimeout(() => this.keyInterface.keyUp(keyCodes.CAPSLOCK), CAPS_LOCK_DELAY);

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
        this.keyInterface.clearKeys();
    }

    /**
     * Called after each frame to determine if emulation should pause
     * @returns {boolean} - True if emulation should pause
     */
    postFrameShouldPause() {
        if (this.stepEmuWhenPaused) {
            this.stepEmuWhenPaused = false;
            return true;
        }
        return false;
    }

    /**
     * Request a single step of the emulator
     */
    requestStep() {
        this.stepEmuWhenPaused = true;
    }

    /**
     * Pause the emulator
     */
    pauseEmulation() {
        this.pauseEmu = true;
        this.dispatchEvent(new Event("pause"));
    }

    /**
     * Resume the emulator
     */
    resumeEmulation() {
        this.pauseEmu = false;
        this.dispatchEvent(new Event("resume"));
    }
}
