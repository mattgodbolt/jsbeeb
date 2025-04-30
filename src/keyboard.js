"use strict";
import * as utils from "./utils.js";

const isMac = typeof window !== "undefined" && /^Mac/i.test(window.navigator?.platform || "");

/**
 * Keyboard class that handles all keyboard related functionality
 */
export class Keyboard {
    /**
     * Create a new Keyboard instance with specified configuration
     * @param {Object} config - The configuration object
     */
    constructor(config) {
        const {
            processor,
            audioHandler,
            document,
            keyLayout = "physical",
            stopCallback,
            goCallback,
            checkPrinterWindow,
            showError,
            fastAsPossibleCallback,
            dbgr,
        } = config;

        // Core components
        this.processor = processor;
        this.audioHandler = audioHandler;
        this.document = document;
        this.dbgr = dbgr;

        // Callbacks
        this.stopCallback = stopCallback;
        this.goCallback = goCallback;
        this.checkPrinterWindow = checkPrinterWindow;
        this.showError = showError;
        this.fastAsPossibleCallback = fastAsPossibleCallback;

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

        // Setup default key handlers
        this._setupDefaultKeyHandlers();
    }

    /**
     * Set up the default key handlers for special emulator functions
     * @private
     */
    _setupDefaultKeyHandlers() {
        const keyCodes = utils.keyCodes;

        this.emuKeyHandlers[keyCodes.S] = (down) => {
            if (down) {
                utils.noteEvent("keyboard", "press", "S");
                this.stopCallback(true);
            }
        };

        this.emuKeyHandlers[keyCodes.R] = (down) => {
            if (down) window.location.reload();
        };
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
     * Registers a handler for a specific key
     * @param {number} keyCode - The key code to handle
     * @param {Function} handler - The handler function
     */
    registerKeyHandler(keyCode, handler) {
        this.emuKeyHandlers[keyCode] = handler;
    }

    /**
     * Updates the current key layout
     * @param {string} layout - The keyboard layout to use
     */
    setKeyLayout(layout) {
        this.keyLayout = layout;
        if (this.processor && this.processor.sysvia) {
            this.processor.sysvia.setKeyLayout(layout);
        }
    }

    /**
     * Sets the running state of the emulator
     * @param {boolean} isRunning - Whether the emulator is running
     */
    setRunning(isRunning) {
        this.running = isRunning;
    }

    /**
     * Helper method to check if text input is active and we should ignore keyboard events
     * @returns {boolean} True if text input is active
     */
    isTextInputActive() {
        return this.document.activeElement && this.document.activeElement.id === "paste-text";
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
        if (this.isTextInputActive()) return;
        if (this.running || (!this.dbgr.enabled() && !this.pauseEmu)) return;

        const code = this.keyCode(evt);

        // Handle debugger 'g' key press
        if (this.dbgr.enabled() && code === LOWERCASE_G) {
            this.dbgr.hide();
            this.goCallback();
            return;
        }

        // Handle pause/step control keys
        if (this.pauseEmu) {
            if (code === LOWERCASE_G) {
                this.resumeEmulation();
                return;
            } else if (code === LOWERCASE_N) {
                this.requestStep();
                this.goCallback();
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
        // Resume audio first (browsers often require user interaction to enable audio)
        this.audioHandler.tryResume();

        // Early returns for common scenarios
        if (this.isTextInputActive()) return;
        if (!this.running) return;

        const code = this.keyCode(evt);

        // Handle special key combinations
        if (evt.altKey) {
            // Alt key combinations trigger custom handlers
            const handler = this.emuKeyHandlers[code];
            if (handler) {
                handler(true, code);
                evt.preventDefault();
            }
        } else if (code === utils.keyCodes.HOME && evt.ctrlKey) {
            // Ctrl+Home: Stop emulation
            utils.noteEvent("keyboard", "press", "home");
            this.stopCallback(true);
        } else if (code === utils.keyCodes.INSERT && evt.ctrlKey) {
            // Ctrl+Insert: Run as fast as possible
            utils.noteEvent("keyboard", "press", "insert");
            this.fastAsPossibleCallback();
        } else if (code === utils.keyCodes.END && evt.ctrlKey) {
            // Ctrl+End: Pause emulation
            utils.noteEvent("keyboard", "press", "end");
            this.pauseEmulation();
        } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            // F12/Break: Reset processor
            utils.noteEvent("keyboard", "press", "break");
            this.processor.setReset(true);
            evt.preventDefault();
        } else if (code === utils.keyCodes.B && evt.ctrlKey) {
            // Ctrl+B: Open printer window and pass key to the BBC
            this.processor.sysvia.keyDown(code, evt.shiftKey);
            evt.preventDefault();
            this.checkPrinterWindow();
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
            // Special CapsLock handling for Mac
            this.handleMacCapsLock();
            evt.preventDefault();
        } else {
            // Pass all other keys to the BBC
            this.processor.sysvia.keyDown(code, evt.shiftKey);
            evt.preventDefault();
        }
    }

    /**
     * Handles a key up event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyUp(evt) {
        // Early return for text input
        if (this.isTextInputActive()) return;

        // Always let the key ups come through to avoid sticky keys in the debugger
        const code = this.keyCode(evt);
        this.processor.sysvia.keyUp(code);

        // No further special handling needed if not running
        if (!this.running) return;

        // Handle special key combinations
        if (evt.altKey) {
            const handler = this.emuKeyHandlers[code];
            if (handler) handler(false, code);
        } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            // Release reset on F12/Break key up
            this.processor.setReset(false);
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
            // Special CapsLock handling for Mac
            this.handleMacCapsLock();
        }

        evt.preventDefault();
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
            this.showError(
                "handling caps lock on Mac OS X",
                `Mac OS X does not generate key up events for caps lock presses. 
                jsbeeb can only simulate a 'tap' of the caps lock key. This means it doesn't work well for games 
                that use caps lock for left or fire, as we can't tell if it's being held down. If you need to play 
                such a game, please see the documentation about remapping keys.
                Close this window to continue (you won't see this error again)`,
            );
            window.localStorage.setItem("warnedAboutRubbishMacs", true);
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
        this.stopCallback(false);
    }

    /**
     * Resume the emulator
     */
    resumeEmulation() {
        this.pauseEmu = false;
        this.goCallback();
    }
}
