"use strict";
import * as utils from "./utils.js";
import { ATOM } from "./utils_atom.js";

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

        // Key interface: routes key events to SysVia (BBC) or PPIA (Atom).
        // Both provide keyDown, keyUp, keyToggleRaw, setKeyLayout,
        // clearKeys, disableKeyboard, enableKeyboard.
        this.keyInterface = processor.model.isAtom ? processor.atomppia : processor.sysvia;
        // The SHIFT key constant used by stringToMachineKeys in the paste key array.
        // Compared by reference in _deliverPasteKey to avoid toggling shift off.
        this._shiftKey = processor.model.isAtom ? ATOM.SHIFT : utils.BBC.SHIFT;

        // State
        this.emuKeyHandlers = {};
        this.running = false;
        this.pauseEmu = false;
        this.stepEmuWhenPaused = false;
        this.keyLayout = keyLayout;

        // Modifier key states
        this.lastShiftLocation = 1;
        this.lastCtrlLocation = 1;
        this.lastAltLocation = 1;

        // Paste state — uses a scheduler task instead of a debugInstruction
        // hook so the CPU can remain on the fast execution path during paste.
        this._pasteKeys = [];
        this._pasteLastChar = undefined;
        this._pasteClocksPerMs = 0;
        this._pasteTask = this.processor.scheduler.newTask(() => this._deliverPasteKey());
    }

    /**
     * Translates a keyboard event to a BBC key code
     * @param {KeyboardEvent} evt - The keyboard event
     * @returns {number} - The BBC key code
     */
    keyCode(evt) {
        const ret = evt.which || evt.charCode || evt.keyCode;
        const keyCodes = utils.keyCodes;

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
                        return utils.keyCodes.NUMPADENTER;
                    case keyCodes.DELETE:
                        return utils.keyCodes.NUMPAD_DECIMAL_POINT;
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
        this.keyInterface.setKeyLayout(layout);
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

        if (this.isPasting && code === utils.keyCodes.ESCAPE) {
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
        if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            this.dispatchEvent(new CustomEvent("break", { detail: true }));
            this.processor.setReset(true);
            return true;
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
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
        if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            this.dispatchEvent(new CustomEvent("break", { detail: false }));
            this.processor.setReset(false);
            return;
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
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
        this.keyInterface.keyDown(utils.keyCodes.CAPSLOCK);

        // Simulate a key release after a short delay
        setTimeout(() => this.keyInterface.keyUp(utils.keyCodes.CAPSLOCK), CAPS_LOCK_DELAY);

        if (isMac && window.localStorage && !window.localStorage.getItem("warnedAboutRubbishMacs")) {
            this.dispatchEvent(
                new CustomEvent("showError", {
                    detail: {
                        context: "handling caps lock on Mac OS X",
                        error: `Mac OS X does not generate key up events for caps lock presses.
                jsbeeb can only simulate a 'tap' of the caps lock key. This means it doesn't work well for games
                that use caps lock for left or fire, as we can't tell if it's being held down. If you need to play
                such a game, please see the documentation about remapping keys.
                Close this window to continue (you won't see this error again)`,
                    },
                }),
            );
            window.localStorage.setItem("warnedAboutRubbishMacs", "true");
        }
    }

    /**
     * Send raw keyboard input to the emulated machine (for paste/autotype).
     * @param {Array} keysToSend - Array of machine-specific key codes to send
     * @param {boolean} checkCapsAndShiftLocks - Whether to check caps and shift locks
     */
    sendRawKeyboard(keysToSend, checkCapsAndShiftLocks) {
        if (this.isPasting) this.cancelPaste();

        this.keyInterface.disableKeyboard();
        this._pasteClocksPerMs =
            Math.floor(this.processor.cpuMultiplier * this.processor.peripheralCyclesPerSecond) / 1000;

        if (checkCapsAndShiftLocks) {
            let toggleKey = null;
            if (!this.keyInterface.capsLockLight) toggleKey = utils.BBC.CAPSLOCK;
            else if (this.keyInterface.shiftLockLight) toggleKey = utils.BBC.SHIFTLOCK;
            if (toggleKey) {
                keysToSend.unshift(toggleKey);
                keysToSend.push(toggleKey);
            }
        }

        this._pasteKeys = keysToSend;
        this._pasteLastChar = undefined;
        this._pasteTask.schedule(0);
    }

    /**
     * Scheduler callback that delivers one key per invocation, rescheduling
     * itself for the next key. Replaces the old debugInstruction hook so the
     * CPU stays on the fast execution path during paste.
     * @private
     */
    _deliverPasteKey() {
        if (this._pasteLastChar && this._pasteLastChar !== this._shiftKey) {
            this.keyInterface.keyToggleRaw(this._pasteLastChar);
        }

        if (this._pasteKeys.length === 0) {
            this._pasteLastChar = undefined;
            this.keyInterface.enableKeyboard();
            return;
        }

        const ch = this._pasteKeys[0];
        const debounce = this._pasteLastChar === ch;
        this._pasteLastChar = ch;
        if (debounce) {
            this._pasteLastChar = undefined;
            // Atom needs longer debounce time
            const debounceMs = this.processor.model.isAtom ? 60 : 30;
            this._pasteTask.schedule(debounceMs * this._pasteClocksPerMs);
            return;
        }

        let delayMs = 50;
        // Atom needs slower timing to avoid character loss during paste
        if (this.processor.model.isAtom) {
            delayMs = 120;
        }
        
        if (typeof this._pasteLastChar === "number") {
            delayMs = this._pasteLastChar;
            this._pasteLastChar = undefined;
        } else {
            this.keyInterface.keyToggleRaw(this._pasteLastChar);
        }

        this._pasteKeys.shift();
        this._pasteTask.schedule(delayMs * this._pasteClocksPerMs);
    }

    /**
     * Cancel any in-progress paste operation.
     */
    cancelPaste() {
        if (!this.isPasting) return;
        this._pasteTask.cancel();
        if (this._pasteLastChar && this._pasteLastChar !== this._shiftKey) {
            this.keyInterface.keyToggleRaw(this._pasteLastChar);
        }
        this._pasteLastChar = undefined;
        this._pasteKeys = [];
        this.keyInterface.enableKeyboard();
    }

    /**
     * Whether a paste operation is currently in progress.
     * @returns {boolean}
     */
    get isPasting() {
        return this._pasteKeys.length > 0 || this._pasteTask.scheduled();
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
