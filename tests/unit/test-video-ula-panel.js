// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { findModel } from "../../src/models.js";
import { Video } from "../../src/video.js";
import { VideoUlaPanel } from "../../src/web/video-ula-panel.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { decodedMeanings, decodedRow, teardownDom } from "./helpers.js";

const Control = 0xfe20;
const Palette = 0xfe21;
const NulaControl = 0xfe22;
const NulaPalette = 0xfe23;
const Mode2Control = 0xf4;
const Mode7Control = 0x4b;
const FramebufferPixels = 1024 * 768;

function makePanel(hasVideoNula) {
    const video = new Video(false, FramebufferPixels, () => {}, { hasVideoNula });
    const panel = new VideoUlaPanel({
        cpu: { video },
        arrangement: new PanelArrangement(() => window.localStorage),
    });
    const write = (address, value) => {
        video.ula.write(address, value);
        panel.update();
    };
    return { panel, write };
}

const swatches = (className) =>
    [...document.querySelectorAll(`#videoula-panel .${className} .videoula-palette-entry`)].map((entry) => ({
        colour: entry.querySelector(".videoula-palette-swatch").style.background,
        label: entry.querySelector(".videoula-palette-label").textContent,
    }));
const meanings = (name) => decodedMeanings("videoula-panel", name);

describe("VideoUlaPanel", () => {
    afterEach(teardownDom);

    it("is made for a BBC or a Master, not for an Atom, which has no video ULA", () => {
        const fits = (name) => VideoUlaPanel.fits({ model: findModel(name) });
        expect([fits("B-DFS1.2"), fits("Master"), fits("Atom")]).toEqual([true, true, false]);
    });

    it("is filled before it opens, so that it is laid out at its size", () => {
        makePanel(false);
        expect(meanings("CTRL")).toHaveLength(7);
        expect(swatches("videoula-ula-palette")[0].label).toBe("white");
        expect(document.querySelector("#videoula-panel .videoula-ula-heading").textContent).toBe("Palette");
    });

    it("decodes the control register: cursor, clock rate, characters per line, teletext and flash", () => {
        const { write } = makePanel(false);
        write(Control, Mode2Control);
        const charactersTitle = decodedRow("videoula-panel", "CTRL").querySelectorAll(".decoded-meaning span")[4].title;
        expect(charactersTitle).toBe("Bits 2 and 3: pixels are shifted out at 4 MHz");
        expect(meanings("CTRL")).toEqual([
            "+cursor 1",
            "+cursor 2",
            "+cursor 3-4",
            "2 MHz",
            "20 chars",
            "-teletext",
            "-flash",
        ]);
        write(Control, Mode7Control);
        expect(meanings("CTRL")).toEqual([
            "-cursor 1",
            "+cursor 2",
            "-cursor 3-4",
            "1 MHz",
            "40 chars",
            "+teletext",
            "+flash",
        ]);
    });

    it("shows each palette entry in the colour it shows now, naming both colours of a flashing one", () => {
        const { write } = makePanel(false);
        const RedSteady = 0x1 ^ 7;
        const BlueFlashing = (0x4 ^ 7) | 8;
        write(Palette, 0x00 | RedSteady);
        write(Palette, 0x30 | BlueFlashing);
        expect(swatches("videoula-ula-palette")[0]).toEqual({ colour: "rgb(255, 0, 0)", label: "red" });
        expect(swatches("videoula-ula-palette")[3]).toEqual({ colour: "rgb(0, 0, 255)", label: "blue/yellow" });
        write(Control, 1);
        expect(swatches("videoula-ula-palette")[3]).toEqual({ colour: "rgb(255, 255, 0)", label: "blue/yellow" });
        expect(document.querySelector("#videoula-panel .videoula-nula-palette")).toBeNull();
    });

    it("shows NuLA's palette, palette mode and flash flags, and when a program switches it off", () => {
        const { write } = makePanel(true);
        const EntryDrawingNulaColour9 = 0x2e;
        write(Palette, EntryDrawingNulaColour9);
        write(NulaPalette, 0x9f);
        write(NulaPalette, 0x80);
        write(NulaControl, 0x95);
        const orange = { colour: "rgb(255, 136, 0)", label: "f80" };
        expect(swatches("videoula-nula-palette")[9]).toEqual(orange);
        expect(swatches("videoula-ula-palette")[2]).toEqual({ colour: orange.colour, label: "NuLA 9" });
        expect(swatches("videoula-nula-palette")[8].label).toBe("000 flash");
        expect(meanings("R8")).toEqual(["+8", "-9", "+a", "+b"]);
        expect(meanings("R9")).toEqual(["-c", "+d", "-e", "+f"]);
        write(NulaControl, 0x8f);
        expect(swatches("videoula-ula-palette")[2].label).toBe("NuLA 9/e");
        const ulaHeading = document.querySelector("#videoula-panel .videoula-ula-heading");
        expect(ulaHeading.textContent).toBe("Palette");
        write(NulaControl, 0x11);
        expect(meanings("R1")).toEqual(["+direct"]);
        expect(ulaHeading.textContent).toBe("Palette: bypassed");
        const heading = document.querySelector("#videoula-panel .videoula-nula-heading");
        expect(heading.textContent).toBe("NuLA palette");
        write(NulaControl, 0x50);
        expect(heading.textContent).toBe("NuLA palette: switched off");
    });
});
