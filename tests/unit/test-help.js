// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { fillHelp, openHelpOnTheTabForNow } from "../../src/web/help.js";
import { Shortcuts } from "../../src/web/shortcuts.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("Help", () => {
    afterEach(teardownDom);

    it("lists every shortcut, and a block of keys for each window that answers them while stopped", () => {
        domFromIndexHtml("help");
        fillHelp();
        expect([...document.querySelectorAll("#shortcuts-help tr")].map((row) => row.textContent)).toEqual(
            Shortcuts.map(({ combo, description }) => `${combo}${description}`),
        );
        expect([...document.querySelectorAll("#debug-keys-help h6")].map((heading) => heading.textContent)).toEqual([
            "Paused",
            "Debugger",
            "Disassembly",
            "Memory",
        ]);
    });

    it("opens on the debugging tab while stopped, and otherwise on the tab last chosen", () => {
        domFromIndexHtml("help");
        let stopped = false;
        openHelpOnTheTabForNow(() => stopped);
        const help = document.getElementById("help");
        const openedOn = (nowStopped) => {
            stopped = nowStopped;
            help.dispatchEvent(new Event("show.bs.modal"));
            return help.querySelector(".nav-link.active").dataset.bsTarget;
        };

        expect(openedOn(false)).toBe("#help-start");
        help.querySelector('[data-bs-target="#help-keyboard"]').click();
        expect(openedOn(true)).toBe("#help-debugging");
        expect(openedOn(false)).toBe("#help-keyboard");
    });
});
