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
        it("prefers the URL, then browser storage, then the defaults", () => {
            window.localStorage.displayMode = "pal";
            window.localStorage.audioOutput = "board";
            urlState.params.displayMode = "xbr";
            const settings = make();
            expect(settings.displayMode).toBe("xbr");
            expect(settings.audioOutput).toBe("board");
            expect(settings.speakerAmount).toBe(1);
            expect(settings.keyLayout).toBe("physical");
            expect(settings.tubeCpuMultiplier).toBe(1);
        });

        it("ignores nonsense from storage", () => {
            window.localStorage.audioOutput = "sideways";
            window.localStorage.speakerAmount = "loud";
            const settings = make();
            expect(settings.audioOutput).toBe("speaker");
            expect(settings.speakerAmount).toBe(1);
        });

        it("lower-cases a key layout from the URL", () => {
            urlState.params.keyLayout = "GAMING";
            expect(make().keyLayout).toBe("gaming");
        });

        it("resolves the model and the fittings", () => {
            urlState.params.model = "Master";
            urlState.params.hasMusic5000 = true;
            urlState.params.hasEconet = true;
            const settings = make();
            expect(settings.model).toBe(findModel("Master"));
            expect(settings.hasMusic5000).toBe(true);
            expect(settings.coProcessor).toBe(false);
            expect(settings.extraRoms).toEqual(["master/anfs-4.25.rom", "ample.rom"]);
        });

        it("falls back to the default model with a notice when the name is unknown", () => {
            urlState.params.model = "PDP-11";
            const settings = make();
            expect(settings.model.name).toBe(DefaultModel.name);
            expect(toasts()).toEqual([expect.stringContaining('no model called "PDP-11"')]);
        });

        it("understands the old combination model names", () => {
            urlState.params.model = "MasterTurbo";
            const settings = make();
            expect(settings.model).toBe(findModel("Master"));
            expect(settings.coProcessor).toBe(true);
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

        it("keeps only the settings worth remembering in storage", () => {
            const settings = make();
            settings.set({ hasMusic5000: true, keyLayout: "natural" });
            expect(window.localStorage.hasMusic5000).toBeUndefined();
            expect(window.localStorage.keyLayout).toBe("natural");
            expect(urlState.params.hasMusic5000).toBe(true);
        });

        it("lets a speaker amount drag settle before writing one history entry", () => {
            const settings = make();
            settings.set({ speakerAmount: 0.5 });
            settings.set({ speakerAmount: 0.4 });
            settings.set({ speakerAmount: 0.3 });
            expect(settings.speakerAmount).toBe(0.3);
            expect(urlState.params.speakerAmount).toBe(0.3);
            expect(urlState.updateUrl).not.toHaveBeenCalled();
            vi.advanceTimersByTime(300);
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("resolves a model by name and puts the name in the URL", () => {
            const settings = make();
            settings.set({ model: "Master" });
            expect(settings.model).toBe(findModel("Master"));
            expect(urlState.params.model).toBe("Master");
        });

        it("clears a setting given undefined", () => {
            urlState.params.microphoneChannel = 2;
            const settings = make();
            settings.set({ microphoneChannel: undefined });
            expect(settings.microphoneChannel).toBeUndefined();
            expect("microphoneChannel" in urlState.params).toBe(false);
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

    describe("mapLegacyModels", () => {
        it("splits the combination models into a model and its fitting", () => {
            const turbo = { model: "MasterTurbo" };
            mapLegacyModels(turbo);
            expect(turbo).toEqual({ model: "Master", coProcessor: true });

            const music = { model: "BMusic5000" };
            mapLegacyModels(music);
            expect(music).toEqual({ model: "B-DFS1.2", hasMusic5000: true });

            const teletext = { model: "BTeletext" };
            mapLegacyModels(teletext);
            expect(teletext).toEqual({ model: "B-DFS1.2", hasTeletextAdaptor: true });
        });

        it("leaves a query with no model alone", () => {
            const query = { autoboot: true };
            mapLegacyModels(query);
            expect(query).toEqual({ autoboot: true });
        });
    });
});
