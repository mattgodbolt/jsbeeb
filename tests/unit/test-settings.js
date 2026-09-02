// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Settings } from "../../src/web/settings.js";
import { DefaultModel, findModel } from "../../src/models.js";
import { fakeUrlState, teardownDom } from "./helpers.js";

/** Stands in for the Config dialog: remembers what it was told and hands back the callbacks. */
function fakeConfig(onChange, onClose, onRestartRequired) {
    return {
        onChange,
        onClose,
        onRestartRequired,
        model: undefined,
        mapLegacyModels: vi.fn(),
        setModel: vi.fn(function (name) {
            this.model = findModel(name);
        }),
        setKeyLayout: vi.fn(),
        setTubeCpuMultiplier: vi.fn(),
        setMicrophoneChannel: vi.fn(),
        setCheckboxes: vi.fn(),
        setDisplayMode: vi.fn(),
        setAudioOutput: vi.fn(),
        setSpeakerAmount: vi.fn(),
    };
}

describe("Settings", () => {
    let urlState;
    let targets;

    beforeEach(() => {
        vi.useFakeTimers();
        urlState = fakeUrlState();
        vi.spyOn(urlState, "updateUrl");
        targets = {
            audioHandler: { setAudioOutput: vi.fn(), setSpeakerAmount: vi.fn() },
            display: { setMode: vi.fn() },
            layout: { resize: vi.fn() },
            quickSettings: { showAudioOutput: vi.fn(), showSpeakerAmount: vi.fn(), showDisplayMode: vi.fn() },
            machine: { emulationConfig: {}, processor: { hasTube: false, tube: {} } },
            keyboard: { setKeyLayout: vi.fn() },
            inputs: { updateAdcSources: vi.fn(), setupMicrophone: vi.fn() },
            modals: { confirm: vi.fn().mockResolvedValue(false) },
        };
    });

    afterEach(teardownDom);

    const make = () => {
        const settings = new Settings({ urlState, makeConfig: (...handlers) => fakeConfig(...handlers) });
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
            expect(document.querySelector(".toast").textContent).toContain('no model called "PDP-11"');
        });

        it("tells the dialog everything it resolved", () => {
            urlState.params.model = "Master";
            const settings = make();
            expect(settings.config.setModel).toHaveBeenCalledWith(findModel("Master").name);
            expect(settings.config.setCheckboxes).toHaveBeenCalled();
            expect(settings.config.setAudioOutput).toHaveBeenCalledWith("speaker");
        });
    });

    describe("applying a setting", () => {
        it("fans a sound output out to the audio, the dialog, the bar, storage and the URL", () => {
            const settings = make();
            settings.applyAudioOutput("board");
            expect(targets.audioHandler.setAudioOutput).toHaveBeenCalledWith("board");
            expect(settings.config.setAudioOutput).toHaveBeenCalledWith("board");
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
            const settings = make();
            settings.config.onChange({ displayMode: "rgb" });
            expect(targets.display.setMode).toHaveBeenCalledWith("rgb");
            settings.config.onChange({ speakerAmount: 0.7 });
            expect(targets.audioHandler.setSpeakerAmount).toHaveBeenCalledWith(0.7);
        });
    });

    describe("closing the dialog", () => {
        it("merges the changes into the URL parameters and updates the URL", () => {
            const settings = make();
            settings.config.onClose({ hasMusic5000: true });
            expect(urlState.params.hasMusic5000).toBe(true);
            expect(urlState.updateUrl).toHaveBeenCalledTimes(1);
        });

        it("fans a key layout out to storage, the machine and the keyboard", () => {
            const settings = make();
            settings.config.onClose({ keyLayout: "natural" });
            expect(window.localStorage.keyLayout).toBe("natural");
            expect(targets.machine.emulationConfig.keyLayout).toBe("natural");
            expect(targets.keyboard.setKeyLayout).toHaveBeenCalledWith("natural");
        });

        it("reroutes the analogue channels when the mouse joystick or microphone change", () => {
            const settings = make();
            settings.config.onClose({ mouseJoystickEnabled: true });
            expect(targets.inputs.updateAdcSources).toHaveBeenCalledWith(true, undefined);
            expect(targets.inputs.setupMicrophone).not.toHaveBeenCalled();
            settings.config.onClose({ microphoneChannel: 2 });
            expect(targets.inputs.setupMicrophone).toHaveBeenCalled();
        });

        it("reroutes the analogue channels when the microphone is disabled, without starting it", () => {
            urlState.params.microphoneChannel = 2;
            const settings = make();
            settings.config.onClose({ microphoneChannel: undefined });
            expect(targets.inputs.updateAdcSources).toHaveBeenCalledWith(undefined, undefined);
            expect(targets.inputs.setupMicrophone).not.toHaveBeenCalled();
        });

        it("passes a tube multiplier to a fitted tube only", () => {
            const settings = make();
            settings.config.onClose({ tubeCpuMultiplier: 4 });
            expect(targets.machine.emulationConfig.tubeCpuMultiplier).toBe(4);
            expect(targets.machine.processor.tube.cpuMultiplier).toBeUndefined();

            targets.machine.processor.hasTube = true;
            settings.config.onClose({ tubeCpuMultiplier: 8 });
            expect(targets.machine.processor.tube.cpuMultiplier).toBe(8);
        });
    });

    describe("a change that needs a restart", () => {
        it("asks before reloading", () => {
            const settings = make();
            settings.config.onRestartRequired();
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
            settings.config.onClose({ speechOutput: false });
            expect(settings.speechOutput.enabled).toBe(false);
        });
    });
});
