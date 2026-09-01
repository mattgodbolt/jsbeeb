// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IconNames, installIcons } from "../../src/web/icons.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("installIcons", () => {
    beforeEach(() => domFromIndexHtml("header-bar"));
    afterEach(teardownDom);

    it("fills every icon placeholder on the top bar with an SVG", () => {
        installIcons();
        const placeholders = [...document.querySelectorAll("[data-icon]")];
        expect(placeholders.length).toBeGreaterThan(0);
        for (const el of placeholders) {
            expect(el.querySelector("svg"), el.dataset.icon).not.toBeNull();
            expect(IconNames).toContain(el.dataset.icon);
        }
    });

    it("keeps the button attributes the page's handlers read", () => {
        installIcons();
        expect(document.querySelector('#audio-output [data-output="speaker"] svg')).not.toBeNull();
        expect(document.querySelector('#display-mode [data-mode="pal"] svg')).not.toBeNull();
        expect(document.querySelector("#debug-play svg")).not.toBeNull();
    });

    it("refuses a name outside the bundled set and leaves the page as it was", () => {
        const el = document.body.appendChild(document.createElement("span"));
        el.dataset.icon = "unicorn";
        expect(() => installIcons()).toThrow("No icon named unicorn");
        expect(document.querySelector("[data-icon] svg")).toBeNull();
    });
});
