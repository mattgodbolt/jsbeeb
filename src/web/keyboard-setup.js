import * as utils from "../utils.js";
import { Keyboard } from "../keyboard.js";
import { showNotice } from "./reporting.js";

/**
 * The page's keyboard: the emulated one, the browser shortcuts around it, and
 * the accessibility switches on the user port. Built in two steps because the
 * user port has to exist before the processor does, and the keyboard after.
 */
export class KeyboardSetup {
    /**
     * @param {object} actions what each shortcut does, supplied late-bound:
     *   enterDebugger, reload, toggleFast, openRewind, openPrinter,
     *   pause, resume, onAnyKeyDown
     */
    constructor(actions) {
        this.actions = actions;
        this.keyboard = null;

        // Accessibility switch state: bits 0-7 correspond to switches 1-8.
        // Active low: 0xff = no switches pressed; clearing a bit = that switch is pressed.
        this.switchState = 0xff;
        const setup = this;
        this.userPort = {
            write() {},
            read() {
                return setup.switchState;
            },
        };
    }

    /** Initialise keyboard now that processor exists */
    attach({ processor, dbgr, keyLayout }) {
        const { actions } = this;
        const keyboard = (this.keyboard = new Keyboard({
            processor,
            inputEnabledFunction: () => document.activeElement && document.activeElement.id === "paste-text",
            keyLayout,
            dbgr,
        }));
        keyboard.addEventListener("notice", showNotice);
        keyboard.addEventListener("pause", () => actions.pause());
        keyboard.addEventListener("resume", () => actions.resume());
        keyboard.addEventListener("break", (e) => {
            // F12/Break: Reset processor
            if (e.detail) utils.noteEvent("keyboard", "press", "break");
        });

        const onDown = (note, action) => (down) => {
            if (down) {
                if (note) utils.noteEvent("keyboard", "press", note);
                action();
            }
        };
        const alt = { alt: true, ctrl: false };
        const ctrl = { alt: false, ctrl: true };
        keyboard.registerKeyHandler(utils.keyCodes.S, onDown("S", actions.enterDebugger), alt);
        keyboard.registerKeyHandler(utils.keyCodes.R, onDown(null, actions.reload), alt);
        keyboard.registerKeyHandler(utils.keyCodes.HOME, onDown("home", actions.enterDebugger), ctrl);
        keyboard.registerKeyHandler(utils.keyCodes.INSERT, onDown("insert", actions.toggleFast), ctrl);
        keyboard.registerKeyHandler(
            utils.keyCodes.END,
            onDown("end", () => keyboard.pauseEmulation()),
            ctrl,
        );
        keyboard.registerKeyHandler(utils.keyCodes.PAGEDOWN, onDown("pagedown", actions.openRewind), alt);
        keyboard.registerKeyHandler(utils.keyCodes.B, onDown(null, actions.openPrinter), ctrl);

        // Register accessibility switch key handlers.
        // Keys 1-8 (K1-K8) and function keys F1-F8 both map to user port bits 0-7
        // (active low: pressing the key clears the corresponding bit in &FE60).
        //
        // On real hardware, the Brilliant Computing switch interface box and special-ed
        // joystick connect to the User Port only; they do not touch the analogue port
        // or the System VIA fire buttons (PB4/PB5), which belong to the standard
        // analogue joystick connector.  So we only update switchState here.
        const handleSwitch = (bit) => (down) => {
            if (down) this.switchState &= ~(1 << bit);
            else this.switchState |= 1 << bit;
        };

        // Alt+1-8 and Alt+F1-F8 trigger the switches.  Using Alt means the underlying
        // key is never forwarded to the BBC Micro (keyboard.js bails out early when a
        // handler fires), so typing numbers or using function keys works normally.
        for (let i = 0; i < 8; i++) {
            keyboard.registerKeyHandler(utils.keyCodes.K1 + i, handleSwitch(i), alt);
            keyboard.registerKeyHandler(utils.keyCodes.F1 + i, handleSwitch(i), alt);
        }

        document.addEventListener("keydown", (evt) => {
            actions.onAnyKeyDown();
            keyboard.keyDown(evt);
        });
        document.addEventListener("keypress", (evt) => keyboard.keyPress(evt));
        document.addEventListener("keyup", (evt) => keyboard.keyUp(evt));
    }

    sendRawKeyboard(keysToSend, checkCapsAndShiftLocks) {
        if (this.keyboard) {
            this.keyboard.sendRawKeyboard(keysToSend, checkCapsAndShiftLocks);
        } else {
            console.warn("Tried to send keys before keyboard was initialised");
        }
    }

    clearKeys() {
        this.keyboard.clearKeys();
    }

    setKeyLayout(keyLayout) {
        this.keyboard.setKeyLayout(keyLayout);
    }

    resumeEmulation() {
        this.keyboard.resumeEmulation();
    }

    setRunning(running) {
        this.keyboard.setRunning(running);
    }

    postFrameShouldPause() {
        return this.keyboard.postFrameShouldPause();
    }
}
