"use strict";
import * as utils from "./utils.js";
import EventEmitter from "event-emitter-es6";

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
export class Keyboard extends EventEmitter {
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
        this.processor.sysvia.setKeyLayout(layout);
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
            this.emit("resume");
            return;
        }

        // Handle pause/step control keys
        if (this.pauseEmu) {
            if (code === LOWERCASE_G) {
                this.resumeEmulation();
                return;
            } else if (code === LOWERCASE_N) {
                this.requestStep();
                this.emit("resume");
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

        // Special handling cases that we always want to keep within keyboard.js
        const isSpecialHandled = this._handleSpecialKeys(code);
        if (isSpecialHandled) return;

        // Always pass the key to the BBC Micro (unless it was a special key)
        this.processor.sysvia.keyDown(code, evt.shiftKey);

        // Check for registered handlers
        const handler = this._findKeyHandler(code, evt.altKey, evt.ctrlKey);
        if (handler) {
            handler.handler(true, code);
        }
    }

    /**
     * Handle special keys that must remain in keyboard.js
     * @param {number} code - The key code
     * @returns {boolean} True if the key was handled specially
     * @private
     */
    _handleSpecialKeys(code) {
        if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            this.emit("break", true);
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
        this.processor.sysvia.keyUp(code);

        // No further special handling needed if not running
        if (!this.running) return;

        evt.preventDefault();

        // Handle special key cases
        if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            this.emit("break", false);
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
        this.processor.sysvia.keyDown(utils.keyCodes.CAPSLOCK);

        // Simulate a key release after a short delay
        setTimeout(() => this.processor.sysvia.keyUp(utils.keyCodes.CAPSLOCK), CAPS_LOCK_DELAY);

        if (isMac && window.localStorage && !window.localStorage.getItem("warnedAboutRubbishMacs")) {
            this.emit("showError", {
                context: "handling caps lock on Mac OS X",
                error: `Mac OS X does not generate key up events for caps lock presses. 
                jsbeeb can only simulate a 'tap' of the caps lock key. This means it doesn't work well for games 
                that use caps lock for left or fire, as we can't tell if it's being held down. If you need to play 
                such a game, please see the documentation about remapping keys.
                Close this window to continue (you won't see this error again)`,
            });
            window.localStorage.setItem("warnedAboutRubbishMacs", "true");
        }
    }

    /**
     * Send raw keyboard input to the BBC
     * @param {Array} keysToSend - Array of keys to send
     * @param {boolean} checkCapsAndShiftLocks - Whether to check caps and shift locks
     */
    sendRawKeyboardToBBC(keysToSend, checkCapsAndShiftLocks) {
        let lastChar;
        let nextKeyMillis = 0;
        this.processor.sysvia.disableKeyboard();
        const clocksPerSecond = Math.floor(this.processor.cpuMultiplier * 2000000);

        if (checkCapsAndShiftLocks) {
            let toggleKey = null;
            if (!this.processor.sysvia.capsLockLight) toggleKey = utils.BBC.CAPSLOCK;
            else if (this.processor.sysvia.shiftLockLight) toggleKey = utils.BBC.SHIFTLOCK;
            if (toggleKey) {
                keysToSend.unshift(toggleKey);
                keysToSend.push(toggleKey);
            }
        }

        const sendCharHook = this.processor.debugInstruction.add(() => {
            const millis = this.processor.cycleSeconds * 1000 + this.processor.currentCycles / (clocksPerSecond / 1000);
            if (millis < nextKeyMillis) {
                return;
            }

            if (lastChar && lastChar !== utils.BBC.SHIFT) {
                this.processor.sysvia.keyToggleRaw(lastChar);
            }

            if (keysToSend.length === 0) {
                // Finished
                this.processor.sysvia.enableKeyboard();
                sendCharHook.remove();
                return;
            }

            const ch = keysToSend[0];
            const debounce = lastChar === ch;
            lastChar = ch;
            if (debounce) {
                lastChar = undefined;
                nextKeyMillis = millis + 30;
                return;
            }

            let time = 50;
            if (typeof lastChar === "number") {
                time = lastChar;
                lastChar = undefined;
            } else {
                this.processor.sysvia.keyToggleRaw(lastChar);
            }

            // remove first character
            keysToSend.shift();

            nextKeyMillis = millis + time;
        });
    }

    /**
     * Clears all pressed keys
     */
    clearKeys() {
        this.processor.sysvia.clearKeys();
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
        this.emit("pause");
    }

    /**
     * Resume the emulator
     */
    resumeEmulation() {
        this.pauseEmu = false;
        this.emit("resume");
    }
}
