// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Settings, mapLegacyModels } from "../../src/web/settings.js";
import { DefaultModel, findModel } from "../../src/models.js";
import { fakeUrlState, teardownDom, toasts } from "./helpers.js";

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

        it("reads only the stored settings back from storage", () => {
            const stored = {
                keyLayout: "gaming",
                displayMode: "pal",
                audioOutput: "off",
                speakerAmount: "0",
                palPersistenceMs: "10",
                rgbPersistenceMs: "20",
                tubeCpuMultiplier: "2",
                microphoneChannel: "1",
                coProcessor: "true",
                speechOutput: "true",
            };
            for (const [name, value] of Object.entries(stored)) window.localStorage[name] = value;
            expect(make()).toMatchObject({
                keyLayout: "gaming",
                displayMode: "pal",
                audioOutput: "off",
                speakerAmount: 0,
                palPersistenceMs: 10,
                rgbPersistenceMs: 20,
                tubeCpuMultiplier: 1,
                microphoneChannel: undefined,
                coProcessor: false,
                speechOutput: false,
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

        it("keeps an afterglow within what a display can show", () => {
            urlState.params.palPersistenceMs = 5000;
            expect(make().palPersistenceMs).toBe(500);
            window.localStorage.rgbPersistenceMs = "-1";
            expect(make().rgbPersistenceMs).toBe(0);
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

        it("remembers in storage the key layout, the display and the sound, and nothing else", () => {
            const settings = make();
            settings.set({
                model: "Master",
                keyLayout: "natural",
                displayMode: "pal",
                audioOutput: "board",
                speakerAmount: 0.5,
                palPersistenceMs: 60,
                rgbPersistenceMs: 30,
                coProcessor: true,
                tubeCpuMultiplier: 2,
                hasEconet: true,
                hasMusic5000: true,
                hasTeletextAdaptor: true,
                hasVideoNula: true,
                mouseJoystickEnabled: true,
                speechOutput: true,
                microphoneChannel: 1,
            });
            expect(Object.keys(window.localStorage).sort()).toEqual([
                "audioOutput",
                "displayMode",
                "keyLayout",
                "palPersistenceMs",
                "rgbPersistenceMs",
                "speakerAmount",
            ]);
        });

        it("lets only the settings sliders change live settle", () => {
            const settings = make();
            const settled = [];
            for (const [name, value] of Object.entries({
                speakerAmount: 0.5,
                palPersistenceMs: 60,
                rgbPersistenceMs: 30,
                tubeCpuMultiplier: 2,
                displayMode: "pal",
                coProcessor: true,
            })) {
                urlState.updateUrl.mockClear();
                settings.set({ [name]: value });
                if (urlState.updateUrl.mock.calls.length === 0) settled.push(name);
                vi.advanceTimersByTime(300);
            }
            expect(settled).toEqual(["speakerAmount", "palPersistenceMs", "rgbPersistenceMs"]);
        });

        it("keeps an afterglow set live within what a display can show, everywhere it goes", () => {
            const settings = make();
            settings.set({ palPersistenceMs: 5000 });
            expect(settings.palPersistenceMs).toBe(500);
            expect(window.localStorage.palPersistenceMs).toBe("500");
            expect(urlState.params.palPersistenceMs).toBe(500);
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
