// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuickSettings } from "../../src/web/quick-settings.js";
import { Settings } from "../../src/web/settings.js";
import { domFromIndexHtml, fakeUrlState, teardownDom } from "./helpers.js";

describe("QuickSettings", () => {
    let settings;

    beforeEach(() => {
        domFromIndexHtml("quick-settings");
        settings = new Settings({ urlState: fakeUrlState() });
    });

    afterEach(teardownDom);

    const make = () => new QuickSettings(settings);
    const pressed = (selector) =>
        Array.from(document.querySelectorAll(selector))
            .filter((b) => b.classList.contains("active"))
            .map((b) => b.dataset.output ?? b.dataset.mode);
    const amount = () => document.getElementById("speaker-amount");

    it("shows the settings as they are and only enables the amount for the speaker", () => {
        settings.set({ audioOutput: "board", speakerAmount: 0.4, displayMode: "pal" });
        make();
        expect(pressed("[data-output]")).toEqual(["board"]);
        expect(amount().value).toBe("0.4");
        expect(amount().disabled).toBe(true);
        expect(pressed("[data-mode]")).toEqual(["pal"]);
        expect(document.querySelector('[data-output="board"]').getAttribute("aria-pressed")).toBe("true");
    });

    it("sets the sound output from a click anywhere on its button", () => {
        make();
        document.querySelector('[data-output="off"]').click();
        expect(settings.audioOutput).toBe("off");
        expect(pressed("[data-output]")).toEqual(["off"]);
        expect(amount().disabled).toBe(true);
        const inner = document.querySelector('[data-output="speaker"]').appendChild(document.createElement("span"));
        inner.click();
        expect(settings.audioOutput).toBe("speaker");
        expect(amount().disabled).toBe(false);
    });

    it("sets the amount as the slider moves", () => {
        make();
        amount().value = "0.5";
        amount().dispatchEvent(new Event("input"));
        expect(settings.speakerAmount).toBe(0.5);
    });

    it("sets the display mode", () => {
        make();
        document.querySelector('[data-mode="xbr"]').click();
        expect(settings.displayMode).toBe("xbr");
        expect(pressed("[data-mode]")).toEqual(["xbr"]);
    });

    it("follows a setting changed elsewhere", () => {
        make();
        settings.set({ audioOutput: "off", speakerAmount: 0.25, displayMode: "pal" });
        expect(pressed("[data-output]")).toEqual(["off"]);
        expect(amount().value).toBe("0.25");
        expect(pressed("[data-mode]")).toEqual(["pal"]);
    });

    it("does nothing on a page without the controls", () => {
        document.body.innerHTML = "";
        make();
        expect(() => settings.set({ audioOutput: "off" })).not.toThrow();
    });
});
