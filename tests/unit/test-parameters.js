// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DisplaySection,
    LocalToPageParams,
    Parameters,
    tubeCpuSpeedLabel,
    UrlParamTypes,
    urlParamTypes,
} from "../../src/web/parameters.js";
import { configForm } from "../../src/web/config-form.js";
import { Settings } from "../../src/web/settings.js";
import { Config } from "../../src/web/config.js";
import { UrlState } from "../../src/web/url-state.js";
import { ParamTypes } from "../../src/url-params.js";
import { MaxPersistenceMs, persistenceSettings } from "../../src/web/canvas.js";
import { findModel } from "../../src/models.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("Parameters", () => {
    afterEach(teardownDom);

    it("types every parameter", () => {
        for (const [name, type] of Object.entries(UrlParamTypes)) {
            expect(Object.values(ParamTypes), name).toContain(type);
        }
    });

    it("never makes a startup action or a setting that needs a fresh machine local to the page", () => {
        for (const name of LocalToPageParams) {
            expect(Parameters[name].field?.restart, name).toBeFalsy();
            expect(Parameters[name].startupAction, name).toBeFalsy();
        }
    });

    it("declares each display's afterglow a remembered slider setting, kept within what a display can show", () => {
        for (const { setting, default: afterglowMs } of persistenceSettings()) {
            expect(Parameters[setting], setting).toMatchObject({
                type: ParamTypes.FLOAT,
                stored: true,
                slid: true,
                default: afterglowMs,
            });
            expect(Parameters[setting].fit(MaxPersistenceMs + 1)).toBe(MaxPersistenceMs);
        }
    });

    it("lays the dialog out in the order the parameters are declared, sections and group together", () => {
        const layout = configForm().map((entry) =>
            Array.isArray(entry)
                ? entry.map((field) => field.setting ?? field.id)
                : entry.type === "group"
                  ? { [entry.label]: entry.fields.map((field) => field.setting) }
                  : entry.setting,
        );
        expect(layout).toEqual([
            "model",
            "keyLayout",
            ["displayMode", "persistence"],
            {
                "Additional peripherals": [
                    "coProcessor",
                    "tubeCpuMultiplier",
                    "hasMusic5000",
                    "hasTeletextAdaptor",
                    "hasEconet",
                ],
            },
            ["audioOutput", "speakerAmount"],
            ["microphoneChannel"],
            ["mouseJoystickEnabled"],
            ["speechOutput"],
        ]);
    });

    describe("adding a setting takes its declaration alone", () => {
        const withMadeUpSetting = {
            ...Parameters,
            screenTint: {
                type: ParamTypes.STRING,
                stored: true,
                default: "amber",
                fromUrl: (tint) => tint.toLowerCase(),
                valid: (tint) => ["amber", "green"].includes(tint),
                field: {
                    type: "menu",
                    section: DisplaySection,
                    label: "Screen tint",
                    options: [
                        { value: "amber", text: "Amber" },
                        { value: "green", text: "Green" },
                    ],
                },
            },
            scanlines: { type: ParamTypes.BOOL, stored: true, default: true },
            tintLevel: { type: ParamTypes.INT, stored: true, default: 3 },
        };
        const urlStateFor = (search) =>
            new UrlState(
                { origin: "https://bbc.example", pathname: "/", search, hash: "" },
                { pushState: vi.fn() },
                urlParamTypes(withMadeUpSetting),
            );
        const settingsFor = (search) => new Settings({ urlState: urlStateFor(search), parameters: withMadeUpSetting });

        it("is read, with its default", () => {
            expect(settingsFor("").screenTint).toBe("amber");
            expect(settingsFor("?screenTint=green").screenTint).toBe("green");
        });

        it("is adjusted from the URL before it is checked", () => {
            expect(settingsFor("?screenTint=Green").screenTint).toBe("green");
            expect(settingsFor("?screenTint=Blue").screenTint).toBe("amber");
        });

        it("is stored and read back", () => {
            settingsFor("").set({ screenTint: "green" });
            expect(window.localStorage.screenTint).toBe("green");
            expect(settingsFor("").screenTint).toBe("green");
        });

        it("reads a stored checkbox and number back as what was stored, not the default", () => {
            settingsFor("").set({ scanlines: false, tintLevel: 5 });
            expect(window.localStorage.scanlines).toBe("false");
            expect(settingsFor("")).toMatchObject({ scanlines: false, tintLevel: 5 });
        });

        it("round-trips through the URL", () => {
            const settings = settingsFor("?model=Master");
            settings.set({ screenTint: "green" });
            expect(settings.urlState.url()).toBe("https://bbc.example/?model=Master&screenTint=green");
            expect(settingsFor(new URL(settings.urlState.url()).search).screenTint).toBe("green");
        });

        it("appears in the dialog where it is declared, and sets the setting", () => {
            domFromIndexHtml("configuration");
            const settings = settingsFor("?screenTint=green");
            new Config(settings);
            const layout = configForm(withMadeUpSetting).find(Array.isArray);
            expect(layout.map((field) => field.setting ?? field.id)).toEqual([
                "displayMode",
                "screenTint",
                "persistence",
            ]);
            expect(document.getElementById("screenTintDropdown").textContent.trim()).toBe("Green");
            document.querySelector('.screen-tint-menu a[data-value="amber"]').click();
            document.getElementById("configuration").dispatchEvent(new Event("hide.bs.modal"));
            expect(settings.screenTint).toBe("amber");
        });
    });
});

describe("tubeCpuSpeedLabel", () => {
    const bbcB = findModel("B-DFS1.2");
    const master = findModel("Master");

    it("shows each machine's own second processor at 1x", () => {
        expect(tubeCpuSpeedLabel(1, bbcB)).toBe("1x (3MHz)");
        expect(tubeCpuSpeedLabel(1, master)).toBe("1x (4MHz)");
    });

    it("shows a fractional overclock", () => {
        expect(tubeCpuSpeedLabel(1.6, bbcB)).toBe("1.6x (4.8MHz)");
    });

    it("keeps a repeating multiplier from a URL readable", () => {
        expect(tubeCpuSpeedLabel(4 / 3, bbcB)).toBe("1.33x (4MHz)");
    });
});
