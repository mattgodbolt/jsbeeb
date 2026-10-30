// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Settings, mapLegacyModels } from "../../src/web/settings.js";
import { DefaultModel, findModel } from "../../src/models.js";
import { DisplaySection, Parameters, urlParamType } from "../../src/web/parameters.js";
import { configForm } from "../../src/web/config-form.js";
import { Config } from "../../src/web/config.js";
import { UrlState } from "../../src/web/url-state.js";
import { ParamTypes } from "../../src/url-params.js";
import { domFromIndexHtml, fakeUrlState, teardownDom, toasts } from "./helpers.js";

describe("Settings", () => {
    let urlState;

    beforeEach(() => {
        vi.useFakeTimers();
        urlState = fakeUrlState();
        vi.spyOn(urlState, "updateUrl");
    });

    afterEach(teardownDom);

    const make = () => new Settings({ urlState });

    describe("resolving the initial values", () => {
        it("starts every setting at its default given nothing", () => {
            expect(make()).toMatchObject({
                model: DefaultModel,
                keyLayout: "physical",
                tubeCpuMultiplier: 1,
                microphoneChannel: undefined,
                coProcessor: false,
                hasEconet: false,
                hasMusic5000: false,
                hasTeletextAdaptor: false,
                hasVideoNula: false,
                mouseJoystickEnabled: false,
                speechOutput: false,
                displayMode: "rgb",
                audioOutput: "speaker",
                speakerAmount: 1,
                palPersistenceMs: 40,
                rgbPersistenceMs: 25,
            });
        });

        it("reads every setting from the URL", () => {
            urlState = fakeUrlState(
                "?keyLayout=Natural&tubeCpuMultiplier=2.5&microphoneChannel=2&coProcessor&hasEconet&hasMusic5000" +
                    "&hasTeletextAdaptor&hasVideoNula&mouseJoystickEnabled&speechOutput&displayMode=xbr&audioOutput=off" +
                    "&speakerAmount=0&palPersistenceMs=0&rgbPersistenceMs=100",
            );
            expect(make()).toMatchObject({
                keyLayout: "natural",
                tubeCpuMultiplier: 2.5,
                microphoneChannel: 2,
                coProcessor: true,
                hasEconet: true,
                hasMusic5000: true,
                hasTeletextAdaptor: true,
                hasVideoNula: true,
                mouseJoystickEnabled: true,
                speechOutput: true,
                displayMode: "xbr",
                audioOutput: "off",
                speakerAmount: 0,
                palPersistenceMs: 0,
                rgbPersistenceMs: 100,
            });
        });

        it("prefers a usable URL value to storage, and storage to an unusable one", () => {
            for (const [name, value] of Object.entries({ keyLayout: "gaming", displayMode: "pal", audioOutput: "off" }))
                window.localStorage[name] = value;
            urlState = fakeUrlState("?keyLayout&displayMode=&audioOutput=loud&tubeCpuMultiplier=0&hasEconet=false");
            expect(make()).toMatchObject({
                keyLayout: "gaming",
                displayMode: "pal",
                audioOutput: "off",
                tubeCpuMultiplier: 1,
                hasEconet: false,
            });
            urlState = fakeUrlState("?keyLayout=natural&displayMode=xbr&audioOutput=board");
            expect(make()).toMatchObject({ keyLayout: "natural", displayMode: "xbr", audioOutput: "board" });
        });

        it("ignores nonsense from storage", () => {
            window.localStorage.audioOutput = "sideways";
            window.localStorage.speakerAmount = "loud";
            const settings = make();
            expect(settings.audioOutput).toBe("speaker");
            expect(settings.speakerAmount).toBe(1);
        });

        it("resolves the model and the fittings", () => {
            urlState.params.model = "Master";
            urlState.params.hasMusic5000 = true;
            urlState.params.hasEconet = true;
            const settings = make();
            expect(settings.model).toBe(findModel("Master"));
            expect(settings.hasMusic5000).toBe(true);
            expect(settings.coProcessor).toBe(false);
            expect(settings.fittedRoms).toEqual(["master/anfs-4.25.rom", "ample.rom"]);
        });

        it("falls back to the default model with a notice when the name is unknown", () => {
            urlState.params.model = "PDP-11";
            const settings = make();
            expect(settings.model.name).toBe(DefaultModel.name);
            expect(toasts()).toEqual([expect.stringContaining('no model called "PDP-11"')]);
        });
    });

    describe("setting a value", () => {
        it("adopts it, keeps it in storage and writes the URL", () => {
            const settings = make();
            settings.set({ audioOutput: "board" });
            expect(settings.audioOutput).toBe("board");
            expect(window.localStorage.audioOutput).toBe("board");
            expect(urlState.params.audioOutput).toBe("board");
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["palPersistenceMs", [60, 70]],
            ["speakerAmount", [0.5, 0.4, 0.3]],
        ])("lets a drag of %s settle before writing one history entry", (name, values) => {
            const settings = make();
            for (const value of values) settings.set({ [name]: value });
            const last = values.at(-1);
            expect(settings[name]).toBe(last);
            expect(window.localStorage[name]).toBe(String(last));
            expect(urlState.params[name]).toBe(last);
            expect(urlState.updateUrl).not.toHaveBeenCalled();
            vi.advanceTimersByTime(300);
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("refuses a setting it does not have, naming it", () => {
            expect(() => make().set({ keyLayuot: "natural" })).toThrow('no setting called "keyLayuot"');
        });

        it("resolves a model by name and puts the name in the URL", () => {
            const settings = make();
            settings.set({ model: "Master" });
            expect(settings.model).toBe(findModel("Master"));
            expect(urlState.params.model).toBe("Master");
        });

        it("keeps the model it has when given a name it does not know", () => {
            const settings = make();
            settings.set({ model: "PDP-11" });
            expect(settings.model).toBe(DefaultModel);
        });

        it.each([
            ["palPersistenceMs", 30, 40],
            ["keyLayout", "natural", "physical"],
            ["microphoneChannel", 2, undefined],
        ])("puts %s back at its default when cleared, remembered nowhere", (name, value, byDefault) => {
            const settings = make();
            settings.set({ [name]: value });
            settings.set({ [name]: undefined });
            expect(settings[name]).toBe(byDefault);
            expect(window.localStorage[name]).toBeUndefined();
            expect(name in urlState.params).toBe(false);
        });

        it("tells each setting's subscribers its new value, then everyone about the lot", () => {
            const settings = make();
            const onAudio = vi.fn();
            const onMic = vi.fn();
            const onChange = vi.fn();
            settings.on("audioOutput", onAudio);
            settings.on("microphoneChannel", onMic);
            settings.addEventListener("change", (event) => onChange(event.detail));
            settings.set({ audioOutput: "off", microphoneChannel: undefined });
            expect(onAudio).toHaveBeenCalledWith("off");
            expect(onMic).toHaveBeenCalledWith(undefined);
            expect(onChange).toHaveBeenCalledWith({ audioOutput: "off", microphoneChannel: undefined });
            settings.set({ displayMode: "pal" });
            expect(onAudio).toHaveBeenCalledTimes(1);
        });
    });

    describe("value", () => {
        it("names the model as the menu and the URL do, and any other setting as it is", () => {
            urlState.params.model = "MasterTurbo";
            urlState.params.keyLayout = "Gaming";
            const settings = make();
            expect(settings.value("model")).toBe("Master");
            expect(settings.value("keyLayout")).toBe("gaming");
            expect(settings.value("coProcessor")).toBe(true);
        });

        it("names a model with no synonym by its name", () => {
            urlState.params.model = "Tube65C02";
            expect(make().value("model")).toBe("Tube65C02");
        });
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
            glow: { type: ParamTypes.FLOAT, stored: true, default: 10, fit: (glow) => Math.min(glow, 20) },
            frameCount: { type: ParamTypes.INT, default: 1 },
        };
        const urlStateFor = (search) =>
            new UrlState(
                { origin: "https://bbc.example", pathname: "/", search, hash: "" },
                { pushState: vi.fn() },
                (name) => urlParamType(name, withMadeUpSetting),
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

        it("reads a stored checkbox and numbers back as what was stored, not the default", () => {
            settingsFor("").set({ scanlines: false, tintLevel: 0, glow: 0.5 });
            expect(window.localStorage.scanlines).toBe("false");
            expect(settingsFor("")).toMatchObject({ scanlines: false, tintLevel: 0, glow: 0.5 });
        });

        it("is read back from storage only when it is stored", () => {
            window.localStorage.frameCount = "5";
            const settings = settingsFor("");
            expect(settings.frameCount).toBe(1);
            settings.set({ frameCount: 2 });
            expect(window.localStorage.frameCount).toBe("5");
        });

        it("is kept within its fit when read and when set, everywhere it goes", () => {
            expect(settingsFor("?glow=50").glow).toBe(20);
            const settings = settingsFor("");
            settings.set({ glow: 50 });
            expect(settings.glow).toBe(20);
            expect(window.localStorage.glow).toBe("20");
            expect(settings.urlState.params.glow).toBe(20);
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

    describe("mapLegacyModels", () => {
        it.each([
            [
                "splits MasterTurbo into the Master and a co-processor",
                { model: "MasterTurbo" },
                { model: "Master", coProcessor: true },
            ],
            [
                "splits BMusic5000 into the B and a Music 5000",
                { model: "BMusic5000" },
                { model: "B-DFS1.2", hasMusic5000: true },
            ],
            [
                "splits BTeletext into the B and a teletext adaptor",
                { model: "BTeletext" },
                { model: "B-DFS1.2", hasTeletextAdaptor: true },
            ],
            ["leaves a query with no model alone", { autoboot: true }, { autoboot: true }],
        ])("%s", (_, query, mapped) => {
            mapLegacyModels(query);
            expect(query).toEqual(mapped);
        });
    });
});
