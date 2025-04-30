"use strict";
import * as utils from "./utils.js";

// Stores modifier key states between events
let lastShiftLocation = 1;
let lastCtrlLocation = 1;
let lastAltLocation = 1;
const isMac =
    typeof window !== "undefined" &&
    window.navigator &&
    window.navigator.platform &&
    window.navigator.platform.indexOf("Mac") === 0;

/**
 * Keyboard class that handles all keyboard related functionality
 */
export class Keyboard {
    /**
     * Create a new Keyboard instance
     * @param {Object} config - Configuration object
     */
    constructor(config) {
        this.processor = config.processor;
        this.audioHandler = config.audioHandler;
        this.document = config.document;
        this.emuKeyHandlers = {};
        this.running = false;
        this.pauseEmu = false;
        this.stepEmuWhenPaused = false;
        this.keyLayout = config.keyLayout || "physical";
        this.stopCallback = config.stopCallback;
        this.goCallback = config.goCallback;
        this.checkPrinterWindow = config.checkPrinterWindow;
        this.showError = config.showError;
        this.fastAsPossibleCallback = config.fastAsPossibleCallback;
        this.dbgr = config.dbgr;

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
                if (this.stopCallback) this.stopCallback(true);
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
                        if (lastShiftLocation === 1) {
                            return keyCodes.SHIFT_LEFT;
                        } else {
                            return keyCodes.SHIFT_RIGHT;
                        }

                    case keyCodes.ALT:
                        if (lastAltLocation === 1) {
                            return keyCodes.ALT_LEFT;
                        } else {
                            return keyCodes.ALT_RIGHT;
                        }

                    case keyCodes.CTRL:
                        if (lastCtrlLocation === 1) {
                            return keyCodes.CTRL_LEFT;
                        } else {
                            return keyCodes.CTRL_RIGHT;
                        }
                }
                break;
            case 1:
                switch (ret) {
                    case keyCodes.SHIFT:
                        lastShiftLocation = 1;
                        return keyCodes.SHIFT_LEFT;

                    case keyCodes.ALT:
                        lastAltLocation = 1;
                        return keyCodes.ALT_LEFT;

                    case keyCodes.CTRL:
                        lastCtrlLocation = 1;
                        return keyCodes.CTRL_LEFT;
                }
                break;
            case 2:
                switch (ret) {
                    case keyCodes.SHIFT:
                        lastShiftLocation = 2;
                        return keyCodes.SHIFT_RIGHT;

                    case keyCodes.ALT:
                        lastAltLocation = 2;
                        return keyCodes.ALT_RIGHT;

                    case keyCodes.CTRL:
                        lastCtrlLocation = 2;
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
     * Handles a key press event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyPress(evt) {
        if (this.document.activeElement && this.document.activeElement.id === "paste-text") return;
        if (this.running || (!this.dbgr.enabled() && !this.pauseEmu)) return;

        const code = this.keyCode(evt);

        if (this.dbgr.enabled() && code === 103 /* lower case g */) {
            this.dbgr.hide();
            if (this.goCallback) this.goCallback();
            return;
        }

        if (this.pauseEmu) {
            if (code === 103 /* lower case g */) {
                this.resumeEmulation();
                return;
            } else if (code === 110 /* lower case n */) {
                this.requestStep();
                if (this.goCallback) this.goCallback();
                return;
            }
        }

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
        if (this.audioHandler) this.audioHandler.tryResume();
        if (this.document.activeElement && this.document.activeElement.id === "paste-text") return;
        if (!this.running) return;

        const code = this.keyCode(evt);

        if (evt.altKey) {
            const handler = this.emuKeyHandlers[code];
            if (handler) {
                handler(true, code);
                evt.preventDefault();
            }
        } else if (code === utils.keyCodes.HOME && evt.ctrlKey) {
            utils.noteEvent("keyboard", "press", "home");
            if (this.stopCallback) this.stopCallback(true);
        } else if (code === utils.keyCodes.INSERT && evt.ctrlKey) {
            utils.noteEvent("keyboard", "press", "insert");
            if (this.fastAsPossibleCallback) this.fastAsPossibleCallback();
        } else if (code === utils.keyCodes.END && evt.ctrlKey) {
            utils.noteEvent("keyboard", "press", "end");
            this.pauseEmulation();
        } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            utils.noteEvent("keyboard", "press", "break");
            this.processor.setReset(true);
            evt.preventDefault();
        } else if (code === utils.keyCodes.B && evt.ctrlKey) {
            // Ctrl-B turns on the printer, so we open a printer output
            // window in addition to passing the keypress along to the beeb.
            this.processor.sysvia.keyDown(code, evt.shiftKey);
            evt.preventDefault();
            if (this.checkPrinterWindow) this.checkPrinterWindow();
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
            this.handleMacCapsLock();
            evt.preventDefault();
        } else {
            this.processor.sysvia.keyDown(code, evt.shiftKey);
            evt.preventDefault();
        }
    }

    /**
     * Handles a key up event
     * @param {KeyboardEvent} evt - The keyboard event
     */
    keyUp(evt) {
        if (this.document.activeElement && this.document.activeElement.id === "paste-text") return;
        // Always let the key ups come through. That way we don't cause sticky keys in the debugger.
        const code = this.keyCode(evt);
        if (this.processor && this.processor.sysvia) this.processor.sysvia.keyUp(code);
        if (!this.running) return;

        if (evt.altKey) {
            const handler = this.emuKeyHandlers[code];
            if (handler) handler(false, code);
        } else if (code === utils.keyCodes.F12 || code === utils.keyCodes.BREAK) {
            this.processor.setReset(false);
        } else if (isMac && code === utils.keyCodes.CAPSLOCK) {
            this.handleMacCapsLock();
        }

        evt.preventDefault();
    }

    /**
     * Special handling for Mac's Caps Lock key
     */
    handleMacCapsLock() {
        // Mac browsers seem to model caps lock as a physical key that's down when capslock is on, and up when it's off.
        // No event is generated when it is physically released on the keyboard. So, we simulate a "tap" here.
        this.processor.sysvia.keyDown(utils.keyCodes.CAPSLOCK);

        // Simulate a key release after a short delay
        setTimeout(() => this.processor.sysvia.keyUp(utils.keyCodes.CAPSLOCK), 100);

        if (isMac && window.localStorage && !window.localStorage.getItem("warnedAboutRubbishMacs")) {
            if (this.showError) {
                this.showError(
                    "handling caps lock on Mac OS X",
                    "Mac OS X does not generate key up events for caps lock presses. " +
                        "jsbeeb can only simulate a 'tap' of the caps lock key. This means it doesn't work well for games " +
                        " that use caps lock for left or fire, as we can't tell if it's being held down. If you need to play " +
                        "such a game, please see the documentation about remapping keys." +
                        "Close this window to continue (you won't see this error again)",
                );
            }
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
        const clocksPerSecond = (this.processor.cpuMultiplier * 2 * 1000 * 1000) | 0;

        if (checkCapsAndShiftLocks) {
            let toggleKey = null;
            if (!this.processor.sysvia.capsLockLight) toggleKey = utils.BBC.CAPSLOCK;
            else if (this.processor.sysvia.shiftLockLight) toggleKey = utils.BBC.SHIFTLOCK;
            if (toggleKey) {
                keysToSend.unshift(toggleKey);
                keysToSend.push(toggleKey);
            }
        }

        const sendCharHook = this.processor.debugInstruction.add(
            function nextCharHook() {
                const millis =
                    this.processor.cycleSeconds * 1000 + this.processor.currentCycles / (clocksPerSecond / 1000);
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
            }.bind(this),
        );
    }

    /**
     * Clears all pressed keys
     */
    clearKeys() {
        if (this.processor && this.processor.sysvia) {
            this.processor.sysvia.clearKeys();
        }
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
        if (this.stopCallback) this.stopCallback(false);
    }

    /**
     * Resume the emulator
     */
    resumeEmulation() {
        this.pauseEmu = false;
        if (this.goCallback) this.goCallback();
    }
}
