// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickSettings } from "../../src/web/quick-settings.js";

const Markup = `
<select id="audio-output"><option value="speaker">S</option><option value="board">B</option><option value="off">O</option></select>
<input id="speaker-amount" type="range" min="0" max="1" step="0.05" value="1" />
<select id="display-mode"><option value="rgb">R</option><option value="pal">P</option><option value="xbr">X</option></select>`;

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

    const change = (id, value) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event("change"));
    };

    it("shows the initial settings and only enables the amount for the speaker", () => {
        make({ audioOutput: "board", speakerAmount: 0.4, displayMode: "pal" });
        expect(document.getElementById("audio-output").value).toBe("board");
        expect(document.getElementById("speaker-amount").value).toBe("0.4");
        expect(document.getElementById("speaker-amount").disabled).toBe(true);
        expect(document.getElementById("display-mode").value).toBe("pal");
    });

    it("applies and remembers a new sound output", () => {
        make();
        change("audio-output", "off");
        expect(audioHandler.setAudioOutput).toHaveBeenCalledWith("off");
        expect(storage.audioOutput).toBe("off");
        expect(document.getElementById("speaker-amount").disabled).toBe(true);
        change("audio-output", "speaker");
        expect(document.getElementById("speaker-amount").disabled).toBe(false);
    });

    it("applies the amount as it moves and remembers it when released", () => {
        make();
        const amount = document.getElementById("speaker-amount");
        amount.value = "0.5";
        amount.dispatchEvent(new Event("input"));
        expect(audioHandler.setSpeakerAmount).toHaveBeenCalledWith(0.5);
        expect(storage.speakerAmount).toBeUndefined();
        amount.dispatchEvent(new Event("change"));
        expect(storage.speakerAmount).toBe("0.5");
    });

    it("hands the display mode to its callback and follows changes made elsewhere", () => {
        const settings = make();
        change("display-mode", "xbr");
        expect(onDisplayMode).toHaveBeenCalledWith("xbr");
        settings.showDisplayMode("pal");
        expect(document.getElementById("display-mode").value).toBe("pal");
    });

    it("does nothing on a page without the controls", () => {
        document.body.innerHTML = "";
        const settings = make();
        expect(() => settings.showDisplayMode("pal")).not.toThrow();
    });
});
