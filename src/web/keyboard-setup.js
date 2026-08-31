import * as utils from "../utils.js";
import { Keyboard } from "../keyboard.js";
import { showNotice } from "./reporting.js";

/** The page's keyboard: the emulated one and the browser shortcuts around it. */
export class KeyboardSetup {
    /**
     * @param {object} opts
     * @param {object} opts.actions what each shortcut does, supplied late-bound:
     *   enterDebugger, reload, toggleFast, openRewind, openPrinter,
     *   pause, resume, onAnyKeyDown
     * @param {import("./accessibility-switches.js").AccessibilitySwitches} opts.accessibilitySwitches
     */
    constructor({ actions, accessibilitySwitches, processor, dbgr, keyLayout }) {
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

        // Alt+1-8 and Alt+F1-F8 trigger the accessibility switches. Using Alt means
        // the underlying key is never forwarded to the BBC Micro (keyboard.js bails
        // out early when a handler fires), so typing numbers or using function keys
        // works normally.
        const handleSwitch = (index) => (down) => accessibilitySwitches.setSwitch(index, down);
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
        this.keyboard.sendRawKeyboard(keysToSend, checkCapsAndShiftLocks);
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
