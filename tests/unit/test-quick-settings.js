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
    let callbacks;

    beforeEach(() => {
        document.body.innerHTML = Markup;
        callbacks = { onAudioOutput: vi.fn(), onSpeakerAmount: vi.fn(), onDisplayMode: vi.fn() };
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    const make = (initial = { audioOutput: "speaker", speakerAmount: 1, displayMode: "rgb" }) =>
        new QuickSettings(callbacks, initial);
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

    it("reports a chosen sound output, from a click anywhere on its button, without showing it itself", () => {
        make();
        document.querySelector('[data-output="off"] ').click();
        expect(callbacks.onAudioOutput).toHaveBeenCalledWith("off");
        document.querySelector('[data-output="speaker"] span').click();
        expect(callbacks.onAudioOutput).toHaveBeenLastCalledWith("speaker");
        expect(pressed("[data-output]")).toEqual(["speaker"]);
    });

    it("follows the sound output it is shown", () => {
        const settings = make();
        settings.showAudioOutput("off");
        expect(pressed("[data-output]")).toEqual(["off"]);
        expect(amount().disabled).toBe(true);
        settings.showAudioOutput("speaker");
        expect(amount().disabled).toBe(false);
    });

    it("reports the amount as it moves and follows the amount it is shown", () => {
        const settings = make();
        amount().value = "0.5";
        amount().dispatchEvent(new Event("input"));
        expect(callbacks.onSpeakerAmount).toHaveBeenCalledWith(0.5);
        settings.showSpeakerAmount(0.25);
        expect(amount().value).toBe("0.25");
    });

    it("reports the display mode and follows the one it is shown", () => {
        const settings = make();
        document.querySelector('[data-mode="xbr"]').click();
        expect(callbacks.onDisplayMode).toHaveBeenCalledWith("xbr");
        expect(pressed("[data-mode]")).toEqual(["rgb"]);
        settings.showDisplayMode("pal");
        expect(pressed("[data-mode]")).toEqual(["pal"]);
    });

    it("does nothing on a page without the controls", () => {
        document.body.innerHTML = "";
        const settings = make();
        expect(() => {
            settings.showAudioOutput("off");
            settings.showSpeakerAmount(0.5);
            settings.showDisplayMode("pal");
        }).not.toThrow();
    });
});
