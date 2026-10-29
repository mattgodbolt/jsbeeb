import { Keyboard } from "./keyboard.js";
import { showNotice } from "./reporting.js";
import { keyCodes } from "../keymap.js";
import { Shortcuts } from "./shortcuts.js";
import { RunMode } from "./emulation-loop.js";

const PasteBoxId = "paste-text";
/** The eight accessibility switches, on the number keys. */
const SwitchKeys = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"];

const NotTypedIntoInputs = ["checkbox", "radio", "range", "file", "color", "button", "submit", "reset", "image"];
const TypingTargets = [
    "textarea",
    "select",
    '[contenteditable]:not([contenteditable="false"])',
    `input:not(${NotTypedIntoInputs.map((type) => `[type="${type}"]`).join(", ")})`,
].join(", ");
const typingIntoField = () => !!document.activeElement?.matches(TypingTargets);
// Where keys are for the page, not the machine: the paste box, the media window's controls and panels' text fields.
const KeyboardSinks = `#${PasteBoxId}, #media-panel, .panel-field`;
// The media window's own shortcuts have to answer from inside it, or it cannot be re-aimed from
// the keyboard at all. The paste box keeps every key, because on a Mac Alt is Option and types
// an accented character rather than nothing.
const ShortcutSinks = `#${PasteBoxId}`;
const inKeyboardSink = () => !!document.activeElement?.closest(KeyboardSinks);

/** A pause's own keys, beneath any panel's; see panel-keys.js for the shape. */
export const PauseKeys = [
    { combo: "g", key: "g", run: "go", description: "Resume" },
    { combo: "n", key: "n", run: "step", description: "Run one frame" },
];

// Chrome resets the input method when focus moves into a text field and out again.
function resetInputMethod() {
    const focused = document.activeElement;
    const textField = document.getElementById("ime-reset");
    textField.focus({ preventScroll: true });
    textField.blur();
    focused?.focus({ preventScroll: true, focusVisible: false });
}

/**
 * Builds the emulated keyboard and wires the browser's shortcuts around it,
 * exposing it as `keyboard` for whoever needs the machine's keys.
 */
export class KeyboardSetup {
    /**
     * @param {object} opts
     * @param {object} opts.actions what each shortcut does, supplied late-bound:
     *   toggleFast, openRewind, openPrinter, openMedia, paste, onAnyKeyDown
     * @param {import("./accessibility-switches.js").AccessibilitySwitches} opts.accessibilitySwitches
     * @param {import("./emulation-loop.js").EmulationLoop} opts.loop
     * @param {import("./debug.js").Debugger} opts.dbgr
     * @param {import("./panel-keys.js").PanelKeys} opts.keys the panels' keys, answered while the machine is stopped
     */
    constructor({ actions, accessibilitySwitches, processor, loop, dbgr, keys, keyLayout }) {
        this.loop = loop;
        this.keys = keys;
        keys.register({
            table: PauseKeys,
            actions: { go: () => loop.go(), step: () => loop.step() },
            isLive: () => loop.mode === RunMode.paused,
            panel: null,
        });
        const keyboard = (this.keyboard = new Keyboard({
            processor,
            inputEnabledFunction: inKeyboardSink,
            shortcutsBlockedFunction: () => !!document.activeElement?.closest(ShortcutSinks),
            runningFunction: () => loop.isRunning(),
            resetInputMethodFunction: resetInputMethod,
            keyLayout,
        }));
        keyboard.addEventListener("notice", showNotice);

        const alt = { alt: true, ctrl: false };
        const runners = {
            toggleDebugger: () => dbgr.toggleDebugger(),
            toggleDebugPanels: () => dbgr.togglePanels(),
            togglePause: () => (loop.isRunning() ? loop.stop(false) : loop.go()),
            toggleFast: () => actions.toggleFast(),
            openPrinter: () => actions.openPrinter(),
            openRewind: () => actions.openRewind(),
            openMediaDrive: (shift) => actions.openMedia(shift ? 1 : 0),
            openMediaTape: () => actions.openMedia("tape"),
        };
        for (const shortcut of Shortcuts) {
            if (!shortcut.key) continue;
            const run = runners[shortcut.run];
            keyboard.registerKeyHandler(
                keyCodes[shortcut.key],
                (down, _code, shift) => {
                    if (down) run(shift);
                },
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
        document.addEventListener("keypress", (evt) => this.keyPress(evt));
        document.addEventListener("keyup", (evt) => keyboard.keyUp(evt));
        document.addEventListener("paste", (evt) => {
            const target = document.activeElement;
            if (target?.id !== PasteBoxId && typingIntoField()) return;
            const text = evt.clipboardData?.getData("text/plain");
            if (text) actions.paste(text);
        });
    }

    /**
     * While the machine is stopped, the panels' keys, and a pause's, are the characters they print, not positions.
     * While it runs every key is the machine's.
     */
    keyPress(evt) {
        if (inKeyboardSink() || typingIntoField()) return;
        const { mode } = this.loop;
        if (mode !== RunMode.paused && mode !== RunMode.debugging) return;
        if (this.keys.press(evt.key)) evt.preventDefault();
    }
}
