// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "../../src/web/settings.js";
import { DefaultModel, findModel } from "../../src/models.js";
import { domFromIndexHtml, fakeUrlState, teardownDom, toasts } from "./helpers.js";

describe("Settings", () => {
    let urlState;
    let targets;

    const dialog = () => document.getElementById("configuration");
    const openDialog = () => dialog().dispatchEvent(new Event("show.bs.modal", { bubbles: true }));
    const closeDialog = () => dialog().dispatchEvent(new Event("hide.bs.modal", { bubbles: true }));
    const dragTubeSlider = (value) => {
        const slider = document.getElementById("tubeCpuMultiplier");
        slider.value = value;
        slider.dispatchEvent(new Event("input"));
    };

    beforeEach(() => {
        vi.useFakeTimers();
        domFromIndexHtml("configuration");
        urlState = fakeUrlState();
        vi.spyOn(urlState, "updateUrl");
        targets = {
            audioHandler: { setAudioOutput: vi.fn(), setSpeakerAmount: vi.fn() },
            display: { setMode: vi.fn() },
            layout: { resize: vi.fn() },
            quickSettings: { showAudioOutput: vi.fn(), showSpeakerAmount: vi.fn(), showDisplayMode: vi.fn() },
            machine: { emulationConfig: {}, processor: { hasTube: false, tube: {} } },
            keys: { setKeyLayout: vi.fn() },
            inputs: { updateAdcSources: vi.fn(), setupMicrophone: vi.fn() },
            modals: { confirm: vi.fn().mockResolvedValue(false) },
        };
    });

    afterEach(teardownDom);

    const make = () => {
        const settings = new Settings({ urlState });
        settings.wire(targets);
        return settings;
    };

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

        it("falls back to the default model with a notice when the name is unknown", () => {
            urlState.params.model = "PDP-11";
            const settings = make();
            expect(settings.model.name).toBe(DefaultModel.name);
            expect(toasts()).toEqual([expect.stringContaining('no model called "PDP-11"')]);
        });

        it("shows the dialog everything it resolved", () => {
            urlState.params.model = "Master";
            urlState.params.hasMusic5000 = true;
            const settings = make();
            expect(settings.model).toBe(findModel("Master"));
            expect(document.querySelector("#bbc-model-dropdown .bbc-model").textContent).toBe(findModel("Master").name);
            expect(document.getElementById("hasMusic5000").checked).toBe(true);
            expect(document.querySelector(".audio-output-text").textContent).toBe("Internal speaker");
        });
    });

    describe("applying a setting", () => {
        it("fans a sound output out to the audio, the dialog, the bar, storage and the URL", () => {
            const settings = make();
            settings.applyAudioOutput("board");
            expect(targets.audioHandler.setAudioOutput).toHaveBeenCalledWith("board");
            expect(document.querySelector(".audio-output-text").textContent).toBe("Line out");
            expect(targets.quickSettings.showAudioOutput).toHaveBeenCalledWith("board");
            expect(window.localStorage.audioOutput).toBe("board");
            expect(urlState.params.audioOutput).toBe("board");
            expect(settings.audioOutput).toBe("board");
            expect(urlState.updateUrl).toHaveBeenCalled();
        });

        it("applies a display mode through the display and writes the URL at once", () => {
            const settings = make();
            settings.applyDisplayMode("pal");
            expect(targets.display.setMode).toHaveBeenCalledWith("pal");
            expect(targets.layout.resize).toHaveBeenCalledTimes(1);
            expect(settings.displayMode).toBe("pal");
            expect(urlState.params.displayMode).toBe("pal");
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("lets a speaker amount drag settle before writing one history entry", () => {
            const settings = make();
            settings.applySpeakerAmount(0.5);
            settings.applySpeakerAmount(0.4);
            settings.applySpeakerAmount(0.3);
            expect(targets.audioHandler.setSpeakerAmount).toHaveBeenCalledTimes(3);
            expect(urlState.params.speakerAmount).toBe(0.3);
            expect(settings.speakerAmount).toBe(0.3);
            expect(urlState.updateUrl).not.toHaveBeenCalled();
            vi.advanceTimersByTime(300);
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("routes the dialog's live changes through the same appliers", () => {
            make();
            document.querySelector('.display-mode-option[data-mode="rgb"]').click();
            expect(targets.display.setMode).toHaveBeenCalledWith("rgb");
            const slider = document.getElementById("speakerAmountSetting");
            slider.value = 0.7;
            slider.dispatchEvent(new Event("input"));
            expect(targets.audioHandler.setSpeakerAmount).toHaveBeenCalledWith(0.7);
        });
    });

    describe("closing the dialog", () => {
        it("merges the changes into the URL parameters and updates the URL", () => {
            make();
            openDialog();
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(urlState.params.hasMusic5000).toBe(true);
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("fans a key layout out to storage, the machine and the keyboard", () => {
            make();
            openDialog();
            document.querySelector('.keyboard-menu a[data-target="natural"]').click();
            closeDialog();
            expect(window.localStorage.keyLayout).toBe("natural");
            expect(targets.machine.emulationConfig.keyLayout).toBe("natural");
            expect(targets.keys.setKeyLayout).toHaveBeenCalledWith("natural");
        });

        it("reroutes the analogue channels when the mouse joystick or microphone change", () => {
            make();
            openDialog();
            document.getElementById("mouseJoystickEnabled").click();
            closeDialog();
            expect(targets.inputs.updateAdcSources).toHaveBeenCalledWith(true, undefined);
            expect(targets.inputs.setupMicrophone).not.toHaveBeenCalled();
            openDialog();
            document.querySelector('.mic-channel-option[data-channel="2"]').click();
            closeDialog();
            expect(targets.inputs.setupMicrophone).toHaveBeenCalled();
        });

        it("reroutes the analogue channels when the microphone is disabled, without starting it", () => {
            urlState.params.microphoneChannel = 2;
            make();
            openDialog();
            document.querySelector('.mic-channel-option[data-channel=""]').click();
            closeDialog();
            expect(targets.inputs.updateAdcSources).toHaveBeenCalledWith(undefined, undefined);
            expect(targets.inputs.setupMicrophone).not.toHaveBeenCalled();
        });

        it("passes a tube multiplier to a fitted tube only", () => {
            make();
            openDialog();
            dragTubeSlider(4);
            closeDialog();
            expect(targets.machine.emulationConfig.tubeCpuMultiplier).toBe(4);
            expect(targets.machine.processor.tube.cpuMultiplier).toBeUndefined();

            targets.machine.processor.hasTube = true;
            openDialog();
            dragTubeSlider(8);
            closeDialog();
            expect(targets.machine.processor.tube.cpuMultiplier).toBe(8);
        });
    });

    describe("a change that needs a restart", () => {
        it("asks before reloading", () => {
            make();
            openDialog();
            document.getElementById("hasEconet").click();
            closeDialog();
            expect(targets.modals.confirm).toHaveBeenCalledWith(
                expect.stringContaining("Restart now?"),
                "Restart now",
                "Later",
            );
        });
    });

    describe("speech output", () => {
        it("follows the URL parameter and the dialog", () => {
            urlState.params.speechOutput = true;
            const settings = make();
            expect(settings.speechOutput.enabled).toBe(true);
            openDialog();
            expect(document.getElementById("speechOutput").checked).toBe(true);
            document.getElementById("speechOutput").click();
            closeDialog();
            expect(settings.speechOutput.enabled).toBe(false);
        });
    });
});
