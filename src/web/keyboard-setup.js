import { Keyboard } from "./keyboard.js";
import { showNotice } from "./reporting.js";
import { noteEvent } from "./analytics.js";
import { keyCodes } from "../keymap.js";
import { Shortcuts } from "./shortcuts.js";

const PasteBoxId = "paste-text";
/** The eight accessibility switches, on the number keys. */
const SwitchKeys = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"];

const TypingTargets = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
// Where keys are for the page, not the machine: the paste box, and the media window's controls.
const KeyboardSinks = `#${PasteBoxId}, #media-panel`;

/**
 * Builds the emulated keyboard and wires the browser's shortcuts around it,
 * exposing it as `keyboard` for whoever needs the machine's keys.
 */
export class KeyboardSetup {
    /**
     * @param {object} opts
     * @param {object} opts.actions what each shortcut does, supplied late-bound:
     *   toggleDebugger, toggleFast, openRewind, openPrinter, openMedia,
     *   pause, resume, paste, onAnyKeyDown
     * @param {import("./accessibility-switches.js").AccessibilitySwitches} opts.accessibilitySwitches
     */
    constructor({ actions, accessibilitySwitches, processor, dbgr, keyLayout }) {
        const keyboard = (this.keyboard = new Keyboard({
            processor,
            inputEnabledFunction: () => !!document.activeElement?.closest(KeyboardSinks),
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
        const runners = {
            toggleDebugger: () => actions.toggleDebugger(),
            togglePause: () => (keyboard.pauseEmu ? keyboard.resumeEmulation() : keyboard.pauseEmulation()),
            toggleFast: () => actions.toggleFast(),
            openPrinter: () => actions.openPrinter(),
            openRewind: () => actions.openRewind(),
            openMediaTape: () => actions.openMedia("tape"),
        };
        for (const shortcut of Shortcuts) {
            if (!shortcut.key) continue;
            if (shortcut.run === "openMediaDrive") {
                // The only shortcut whose shift state changes what it does, rather than which key it is.
                keyboard.registerKeyHandler(
                    keyCodes[shortcut.key],
                    (down, _code, shift) => {
                        if (down) actions.openMedia(shift ? 1 : 0);
                    },
                    alt,
                );
                continue;
            }
            keyboard.registerKeyHandler(
                keyCodes[shortcut.key],
                onDown(shortcut.note ?? null, runners[shortcut.run]),
                alt,
            );
        }

        // Alt means the underlying key is never forwarded to the BBC Micro (keyboard.js bails
        // out early when a handler fires), so typing numbers works normally.
        const handleSwitch = (index) => (down) => accessibilitySwitches.setSwitch(index, down);
        SwitchKeys.forEach((name, index) => keyboard.registerKeyHandler(keyCodes[name], handleSwitch(index), alt));

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
