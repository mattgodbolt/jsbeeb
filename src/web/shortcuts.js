import { isMac } from "./keyboard.js";

/**
 * Every shortcut jsbeeb answers. The handlers in keyboard-setup.js and both lists of documentation, in the
 * README and in the page's own help, are checked against this, so a shortcut cannot be added
 * without appearing in all three.
 *
 * All of them are on Alt, because Ctrl belongs to the emulated machine: Ctrl-B is VDU 2 on a
 * BBC, Ctrl-L clears the screen, and so on. A row with no `key` is documentation for another
 * row's handler.
 */
export const Shortcuts = [
    { combo: "Alt-S", key: "S", run: "toggleDebugger", description: "Enter the debugger, or leave it and resume" },
    {
        combo: "Alt-D",
        key: "D",
        run: "toggleDebugPanels",
        description: "Show or hide the debug panels, leaving the machine running or stopped",
    },
    { combo: "Alt-P", key: "P", run: "togglePause", description: "Pause emulation, or resume" },
    { combo: "Alt-T", key: "T", run: "toggleFast", description: "Toggle turbo (fast-as-possible)" },
    { combo: "Alt-B", key: "B", run: "openPrinter", description: "Open printer output window" },
    { combo: "Alt-W", key: "W", run: "openRewind", description: "Open rewind scrubber" },
    { combo: "Alt-M", key: "M", run: "openMediaDrive", description: "Media window, aimed at drive 0" },
    { combo: "Alt-Shift-M", description: "Media window, aimed at drive 1" },
    { combo: "Alt-C", key: "C", run: "openMediaTape", description: "Media window, aimed at the cassette" },
    { combo: "Alt-1 to Alt-8", description: "Hold an accessibility switch down" },
];

/** A shortcut, or text naming some, as the keyboard prints it: ⌥ and ⇧ on a Mac. */
export function shortcutLabel(text, mac = isMac) {
    return mac ? text.replaceAll("Alt-Shift-", "⌥⇧").replaceAll(/\bAlt\b-?/g, "⌥") : text;
}

/** Relabels the shortcuts the page's own markup names: the help's key caps and the tooltips. */
export function labelPageShortcuts(mac = isMac) {
    if (!mac) return;
    for (const key of document.querySelectorAll("#help .key, .menu-key"))
        key.textContent = shortcutLabel(key.textContent, mac);
    for (const element of document.querySelectorAll("[title*='Alt']")) {
        element.title = shortcutLabel(element.title, mac);
    }
}
