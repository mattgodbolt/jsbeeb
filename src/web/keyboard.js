import { keyCodes } from "../keymap.js";
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
        const { processor, inputEnabledFunction, keyLayout = "physical", dbgr } = config;

        // Core components
        this.processor = processor;
        this.inputEnabledFunction = inputEnabledFunction;
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

        // Modifier key states
        this.lastShiftLocation = 1;
        this.lastCtrlLocation = 1;
        this.lastAltLocation = 1;
    }

    /**
     * Translates a keyboard event to a BBC key code
     * @param {KeyboardEvent} evt - The keyboard event
     * @returns {number} - The BBC key code
     */
    keyCode(evt) {
        const ret = evt.which || evt.charCode || evt.keyCode;

        switch (evt.location) {
            default:
                // keyUp events seem to pass location = 0 (Chrome)
                switch (ret) {
                    case keyCodes.SHIFT:
                        return this.lastShiftLocation === 1 ? keyCodes.SHIFT_LEFT : keyCodes.SHIFT_RIGHT;
                    case keyCodes.ALT:
                        return this.lastAltLocation === 1 ? keyCodes.ALT_LEFT : keyCodes.ALT_RIGHT;
                    case keyCodes.CTRL:
                        return this.lastCtrlLocation === 1 ? keyCodes.CTRL_LEFT : keyCodes.CTRL_RIGHT;
                }
                break;
            case 1:
                switch (ret) {
                    case keyCodes.SHIFT:
                        this.lastShiftLocation = 1;
                        return keyCodes.SHIFT_LEFT;
                    case keyCodes.ALT:
                        this.lastAltLocation = 1;
                        return keyCodes.ALT_LEFT;
                    case keyCodes.CTRL:
                        this.lastCtrlLocation = 1;
                        return keyCodes.CTRL_LEFT;
                }
                break;
            case 2:
                switch (ret) {
                    case keyCodes.SHIFT:
                        this.lastShiftLocation = 2;
                        return keyCodes.SHIFT_RIGHT;
                    case keyCodes.ALT:
                        this.lastAltLocation = 2;
                        return keyCodes.ALT_RIGHT;
                    case keyCodes.CTRL:
                        this.lastCtrlLocation = 2;
                        return keyCodes.CTRL_RIGHT;
                }
                break;
            case 3: // numpad
                switch (ret) {
                    case keyCodes.ENTER:
                        return keyCodes.NUMPADENTER;
                    case keyCodes.DELETE:
                        return keyCodes.NUMPAD_DECIMAL_POINT;
                }
                break;
        }

        return ret;
    }

    /**
     * Registers a handler for a specific key with optional modifiers
     * @param {number} keyCode - The key code to handle
     * @param {Function} handler - The handler function
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
     * @param {number} keyCode - The key code
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
        // Common key constants
        const LOWERCASE_G = 103;
        const LOWERCASE_N = 110;

        // Early returns for common scenarios
        // Check if input is enabled. If inputEnabledFunction returns true, keyboard events should not be processed.
        if (this.inputEnabledFunction()) return;
        if (this.running || (!this.dbgr.enabled() && !this.pauseEmu)) return;

        const code = this.keyCode(evt);

        // Handle debugger 'g' key press
        if (this.dbgr.enabled() && code === LOWERCASE_G) {
            this.dbgr.hide();
            this.dispatchEvent(new Event("resume"));
            return;
        }

        // Handle pause/step control keys
        if (this.pauseEmu) {
            if (code === LOWERCASE_G) {
                this.resumeEmulation();
                return;
            } else if (code === LOWERCASE_N) {
                this.requestStep();
                this.dispatchEvent(new Event("resume"));
                return;
            }
        }

        // Pass any other keys to the debugger if it's enabled
        if (this.dbgr.enabled()) {
            const handled = this.dbgr.keyPress(this.keyCode(evt));
            if (handled) evt.preventDefault();
        }
    }

    /**
     * Handles a key down event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyDown(evt) {
        // Early returns for common scenarios
        if (this.inputEnabledFunction()) return;
        if (!this.running) return;

        const code = this.keyCode(evt);
        evt.preventDefault();

        if (this.isPasting && code === keyCodes.ESCAPE) {
            this.cancelPaste();
            return;
        }

        // Special handling cases that we always want to keep within keyboard.js
        const isSpecialHandled = this._handleSpecialKeys(code);
        if (isSpecialHandled) return;

        // Check for registered handlers first; if one fires, don't pass to the emulator.
        // This lets Alt+key and Ctrl+key handlers cleanly own their keys without the
        // underlying key leaking through to the emulated machine.
        const handler = this._findKeyHandler(code, evt.altKey, evt.ctrlKey);
        if (handler) {
            handler.handler(true, code);
            return;
        }

        // No handler claimed the key; pass it to the emulated machine.
        this.keyInterface.keyDown(code, evt.shiftKey);
    }

    /**
     * Handle special keys that must remain in keyboard.js
     * @param {number} code - The key code
     * @returns {boolean} True if the key was handled specially
     * @private
     */
    _handleSpecialKeys(code) {
        if (code === keyCodes.F12 || code === keyCodes.BREAK) {
            this.dispatchEvent(new CustomEvent("break", { detail: true }));
            this.processor.setReset(true);
            return true;
        } else if (isMac && code === keyCodes.CAPSLOCK) {
            // Special CapsLock handling for Mac
            this.handleMacCapsLock();
            return true;
        }

        return false;
    }

    /**
     * Handles a key up event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyUp(evt) {
        // Early return for text input
        if (this.inputEnabledFunction()) return;

        // Always let the key ups come through to avoid sticky keys in the debugger
        const code = this.keyCode(evt);
        this.keyInterface.keyUp(code);

        // No further special handling needed if not running
        if (!this.running) return;

        evt.preventDefault();

        // Handle special key cases
        if (code === keyCodes.F12 || code === keyCodes.BREAK) {
            this.dispatchEvent(new CustomEvent("break", { detail: false }));
            this.processor.setReset(false);
            return;
        } else if (isMac && code === keyCodes.CAPSLOCK) {
            // Special CapsLock handling for Mac
            this.handleMacCapsLock();
            return;
        }

        // Check for registered handlers
        const handler = this._findKeyHandler(code, evt.altKey, evt.ctrlKey);
        if (handler) {
            handler.handler(false, code);
        }
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
