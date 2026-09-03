import { Keyboard } from "../keyboard.js";
import { showNotice } from "./reporting.js";
import { noteEvent } from "./analytics.js";
import { keyCodes } from "../keymap.js";

const PasteBoxId = "paste-text";
const TypingTargets = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Builds the emulated keyboard and wires the browser's shortcuts around it,
 * exposing it as `keyboard` for whoever needs the machine's keys.
 */
export class KeyboardSetup {
    /**
     * @param {object} opts
     * @param {object} opts.actions what each shortcut does, supplied late-bound:
     *   enterDebugger, reload, toggleFast, openRewind, openPrinter,
     *   pause, resume, paste, onAnyKeyDown
     * @param {import("./accessibility-switches.js").AccessibilitySwitches} opts.accessibilitySwitches
     */
    constructor({ actions, accessibilitySwitches, processor, dbgr, keyLayout }) {
        const keyboard = (this.keyboard = new Keyboard({
            processor,
            inputEnabledFunction: () => document.activeElement && document.activeElement.id === PasteBoxId,
            keyLayout,
            dbgr,
        }));
        keyboard.addEventListener("notice", showNotice);
        keyboard.addEventListener("pause", () => actions.pause());
        keyboard.addEventListener("resume", () => actions.resume());
        keyboard.addEventListener("break", (e) => {
            // F12/Break: Reset processor
            if (e.detail) noteEvent("keyboard", "press", "break");
        });

        const onDown = (note, action) => (down) => {
            if (down) {
                if (note) noteEvent("keyboard", "press", note);
                action();
            }
        };
        const alt = { alt: true, ctrl: false };
        const ctrl = { alt: false, ctrl: true };
        keyboard.registerKeyHandler(keyCodes.S, onDown("S", actions.enterDebugger), alt);
        keyboard.registerKeyHandler(keyCodes.R, onDown(null, actions.reload), alt);
        keyboard.registerKeyHandler(keyCodes.HOME, onDown("home", actions.enterDebugger), ctrl);
        keyboard.registerKeyHandler(keyCodes.INSERT, onDown("insert", actions.toggleFast), ctrl);
        keyboard.registerKeyHandler(
            keyCodes.END,
            onDown("end", () => keyboard.pauseEmulation()),
            ctrl,
        );
        keyboard.registerKeyHandler(keyCodes.PAGEDOWN, onDown("pagedown", actions.openRewind), alt);
        keyboard.registerKeyHandler(keyCodes.B, onDown(null, actions.openPrinter), ctrl);

        // Alt+1-8 and Alt+F1-F8 trigger the accessibility switches. Using Alt means
        // the underlying key is never forwarded to the BBC Micro (keyboard.js bails
        // out early when a handler fires), so typing numbers or using function keys
        // works normally.
        const handleSwitch = (index) => (down) => accessibilitySwitches.setSwitch(index, down);
        for (let i = 0; i < 8; i++) {
            keyboard.registerKeyHandler(keyCodes.K1 + i, handleSwitch(i), alt);
            keyboard.registerKeyHandler(keyCodes.F1 + i, handleSwitch(i), alt);
        }

        document.addEventListener("keydown", (evt) => {
            actions.onAnyKeyDown();
            keyboard.keyDown(evt);
        });
        document.addEventListener("keypress", (evt) => keyboard.keyPress(evt));
        document.addEventListener("keyup", (evt) => keyboard.keyUp(evt));
        document.addEventListener("paste", (evt) => {
            const target = document.activeElement;
            if (target && target.id !== PasteBoxId && target.matches(TypingTargets)) return;
            const text = evt.clipboardData?.getData("text/plain");
            if (text) actions.paste(text);
        });
    }
}
