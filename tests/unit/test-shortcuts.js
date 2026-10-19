// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { labelPageShortcuts, shortcutLabel, Shortcuts } from "../../src/web/shortcuts.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

const readme = readFileSync("README.md", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

/** Every `Alt-...` the two lists of documentation claim jsbeeb answers. */
function documentedCombos(text, pattern) {
    return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

describe("Emulator shortcuts", () => {
    const combos = Shortcuts.map((shortcut) => shortcut.combo);

    it("puts every shortcut on Alt, leaving Ctrl to the emulated machine", () => {
        for (const combo of combos) expect(combo.startsWith("Alt-")).toBe(true);
    });

    it("names a handler for every shortcut that is not documentation for another", () => {
        for (const shortcut of Shortcuts) {
            if (!shortcut.key) continue;
            expect(shortcut.run, shortcut.combo).toBeTruthy();
        }
    });

    it.each([
        ["the README", () => documentedCombos(readme, /\| `(Alt-[^`]+)`/g)],
        ["the page's own help", () => documentedCombos(indexHtml, /<span class="key">(Alt-[^<]+)<\/span>/g)],
    ])("is listed in %s, exactly", (_where, documented) => {
        expect([...documented()].sort()).toEqual([...combos].sort());
    });
});

describe("Shortcut labels", () => {
    afterEach(teardownDom);

    it("leave Alt as it is off a Mac", () => {
        expect(shortcutLabel("Alt-Shift-M", false)).toBe("Alt-Shift-M");
    });

    it.each([
        ["Alt-T", "⌥T"],
        ["Alt-Shift-M", "⌥⇧M"],
        ["Alt-1 to Alt-8", "⌥1 to ⌥8"],
        ["the left Alt", "the left ⌥"],
        ["Alternatively, press Alt-B", "Alternatively, press ⌥B"],
    ])("turn %s into %s on a Mac", (text, label) => {
        expect(shortcutLabel(text, true)).toBe(label);
    });

    const pageLabels = () => ({
        help: [...document.querySelectorAll("#help .key")].map((key) => key.textContent).filter((t) => /Alt|⌥/.test(t)),
        tooltips: [...document.querySelectorAll("#leds [title]")].map((el) => el.title).filter((t) => /Alt|⌥/.test(t)),
    });

    it("relabel the help's caps and the tooltips on a Mac, and leave them as they are off one", () => {
        domFromIndexHtml("help", "leds");
        labelPageShortcuts(false);
        const offMac = pageLabels();
        expect(offMac.help).toContain("Alt-S");
        expect(offMac.tooltips).toEqual([expect.stringContaining("Alt-T"), expect.stringContaining("Alt-T")]);
        labelPageShortcuts(true);
        const onMac = pageLabels();
        expect(onMac.help).toEqual(offMac.help.map((text) => shortcutLabel(text, true)));
        expect(onMac.tooltips).toEqual([expect.stringContaining("⌥T"), expect.stringContaining("⌥T")]);
        expect(JSON.stringify(onMac)).not.toContain("Alt");
    });
});
