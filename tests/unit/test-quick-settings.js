// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickSettings } from "../../src/web/quick-settings.js";

const Markup = `
<div id="audio-output">
  <button data-output="speaker"><span>S</span></button><button data-output="board">B</button><button data-output="off">O</button>
</div>
<input id="speaker-amount" type="range" min="0" max="1" step="0.05" value="1" />
<div id="display-mode">
  <button data-mode="rgb">R</button><button data-mode="pal">P</button><button data-mode="xbr">X</button>
</div>`;

describe("QuickSettings", () => {
    let audioHandler;
    let onDisplayMode;
    let storage;

    beforeEach(() => {
        document.body.innerHTML = Markup;
        audioHandler = { setAudioOutput: vi.fn(), setSpeakerAmount: vi.fn() };
        onDisplayMode = vi.fn();
        storage = {};
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    const make = (initial = { audioOutput: "speaker", speakerAmount: 1, displayMode: "rgb" }) =>
        new QuickSettings({ audioHandler, onDisplayMode, storage }, initial);
    const pressed = (selector) =>
        Array.from(document.querySelectorAll(selector))
            .filter((b) => b.classList.contains("active"))
            .map((b) => b.dataset.output ?? b.dataset.mode);
    const amount = () => document.getElementById("speaker-amount");

    it("shows the initial settings and only enables the amount for the speaker", () => {
        make({ audioOutput: "board", speakerAmount: 0.4, displayMode: "pal" });
        expect(pressed("[data-output]")).toEqual(["board"]);
        expect(amount().value).toBe("0.4");
        expect(amount().disabled).toBe(true);
        expect(pressed("[data-mode]")).toEqual(["pal"]);
        expect(document.querySelector('[data-output="board"]').getAttribute("aria-pressed")).toBe("true");
    });

    it("applies and remembers a new sound output, from a click anywhere on its button", () => {
        make();
        document.querySelector('[data-output="off"]').click();
        expect(audioHandler.setAudioOutput).toHaveBeenCalledWith("off");
        expect(storage.audioOutput).toBe("off");
        expect(pressed("[data-output]")).toEqual(["off"]);
        expect(amount().disabled).toBe(true);
        document.querySelector('[data-output="speaker"] span').click();
        expect(audioHandler.setAudioOutput).toHaveBeenLastCalledWith("speaker");
        expect(amount().disabled).toBe(false);
    });

    it("applies the amount as it moves and remembers it when released", () => {
        make();
        amount().value = "0.5";
        amount().dispatchEvent(new Event("input"));
        expect(audioHandler.setSpeakerAmount).toHaveBeenCalledWith(0.5);
        expect(storage.speakerAmount).toBeUndefined();
        amount().dispatchEvent(new Event("change"));
        expect(storage.speakerAmount).toBe("0.5");
    });

    it("hands the display mode to its callback and follows changes made elsewhere", () => {
        const settings = make();
        document.querySelector('[data-mode="xbr"]').click();
        expect(onDisplayMode).toHaveBeenCalledWith("xbr");
        expect(pressed("[data-mode]")).toEqual(["rgb"]);
        settings.showDisplayMode("pal");
        expect(pressed("[data-mode]")).toEqual(["pal"]);
    });

    it("does nothing on a page without the controls", () => {
        document.body.innerHTML = "";
        const settings = make();
        expect(() => settings.showDisplayMode("pal")).not.toThrow();
    });
});
