import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Shortcuts } from "../../src/web/shortcuts.js";

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
