import * as utils from "../utils.js";
import { Config } from "./config.js";
import { DefaultModel, findModel } from "../models.js";
import { DefaultAudioOutput, isAudioOutput } from "../audio-output.js";
import { SpeechOutput } from "../speech-output.js";
import { guessModelFromHostname } from "../url-params.js";
import { toast } from "./toast.js";

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;

/**
 * The user's settings: resolved from the URL, browser storage and the
 * defaults, kept in step across the Settings dialog, the top bar, storage and
 * the URL, and applied to the machine. Built before anything it applies to;
 * wire() hands it the targets once they exist, which is before any setting
 * can change hands.
 */
export class Settings {
    constructor({ urlState, makeConfig = (...handlers) => new Config(...handlers) }) {
        this.urlState = urlState;
        this.targets = null;
        const parsedQuery = urlState.params;

        // Speech output: initialised from URL param; can be toggled at runtime via the Settings panel.
        // Must be created before Config so the onClose callback and the initial checkbox state can reference it.
        this.speechOutput = new SpeechOutput();
        this.setSpeechOutput(!!parsedQuery.speechOutput);

        this.keyLayout = window.localStorage.keyLayout || "physical";
        if (parsedQuery.keyLayout) {
            this.keyLayout = (parsedQuery.keyLayout + "").toLowerCase();
        }

        this.config = makeConfig(
            (changed) => {
                if (changed.audioOutput) this.applyAudioOutput(changed.audioOutput);
                if (changed.speakerAmount !== undefined) this.applySpeakerAmount(changed.speakerAmount);
                if (changed.displayMode) this.applyDisplayMode(changed.displayMode);
            },
            (changed) => this.onDialogClosed(changed),
            () => {
                this.targets.modals.areYouSure(
                    "Your change is saved, but only takes effect when the emulator restarts. Restart now?",
                    "Restart now",
                    "Later",
                    () => window.location.reload(),
                );
            },
        );

        // Perform mapping of legacy models to the new format
        this.config.mapLegacyModels(parsedQuery);

        const requestedModelName = parsedQuery.model || guessModelFromHostname(window.location.hostname);
        const requestedModel = findModel(requestedModelName);
        if (!requestedModel)
            toast(`There is no model called "${requestedModelName}". Using ${DefaultModel.name} instead.`, {
                title: "Model",
            });
        this.config.setModel((requestedModel ?? DefaultModel).name);
        this.config.setKeyLayout(this.keyLayout);
        this.config.setTubeCpuMultiplier(parsedQuery.tubeCpuMultiplier || 1);
        this.config.setMicrophoneChannel(parsedQuery.microphoneChannel);
        this.config.setCheckboxes({
            coProcessor: !!parsedQuery.coProcessor,
            hasEconet: !!parsedQuery.hasEconet,
            hasMusic5000: !!parsedQuery.hasMusic5000,
            hasTeletextAdaptor: !!parsedQuery.hasTeletextAdaptor,
            mouseJoystickEnabled: !!parsedQuery.mouseJoystickEnabled,
            speechOutput: this.speechOutput.enabled,
        });

        this.displayMode = parsedQuery.displayMode || window.localStorage.displayMode || "rgb";
        this.config.setDisplayMode(this.displayMode);
        this.audioOutput =
            [parsedQuery.audioOutput, window.localStorage.audioOutput].find(isAudioOutput) ?? DefaultAudioOutput;
        this.speakerAmount =
            [parsedQuery.speakerAmount, parseFloat(window.localStorage.speakerAmount)].find(Number.isFinite) ?? 1;
        this.config.setAudioOutput(this.audioOutput);
        this.config.setSpeakerAmount(this.speakerAmount);

        this.updateUrlOnceSettled = utils.debounce(() => urlState.updateUrl(), UrlSettleMs);
    }

    get model() {
        return this.config.model;
    }

    /** What applying a setting reaches: everything here exists before a setting can change. */
    wire(targets) {
        this.targets = targets;
    }

    setSpeechOutput(enabled) {
        this.speechOutput.enabled = enabled;
        if (enabled && typeof speechSynthesis === "undefined")
            toast("This browser has no speech synthesis, so speech output has nothing to speak with.", {
                title: "Speech",
            });
    }

    applyAudioOutput(output) {
        this.audioOutput = output;
        this.targets.audioHandler.setAudioOutput(output);
        this.config.setAudioOutput(output);
        this.targets.quickSettings?.showAudioOutput(output);
        window.localStorage.audioOutput = output;
        this.urlState.set({ audioOutput: output });
    }

    applySpeakerAmount(amount) {
        this.speakerAmount = amount;
        this.targets.audioHandler.setSpeakerAmount(amount);
        this.config.setSpeakerAmount(amount);
        this.targets.quickSettings?.showSpeakerAmount(amount);
        window.localStorage.speakerAmount = amount;
        this.urlState.params.speakerAmount = amount;
        this.updateUrlOnceSettled();
    }

    applyDisplayMode(mode) {
        this.displayMode = mode;
        this.targets.display.setMode(mode);
        // The monitor picture may have changed shape.
        this.targets.layout.resize();
        this.config.setDisplayMode(mode);
        this.targets.quickSettings?.showDisplayMode(mode);
        window.localStorage.displayMode = mode;
        this.urlState.set({ displayMode: mode });
    }

    onDialogClosed(changed) {
        const { urlState } = this;
        const { machine, keys, inputs } = this.targets;
        const parsedQuery = urlState.params;
        urlState.set(changed);
        if (changed.keyLayout) {
            window.localStorage.keyLayout = changed.keyLayout;
            machine.emulationConfig.keyLayout = changed.keyLayout;
            keys.setKeyLayout(changed.keyLayout);
        }
        if (changed.mouseJoystickEnabled !== undefined || Object.hasOwn(changed, "microphoneChannel")) {
            inputs.updateAdcSources(parsedQuery.mouseJoystickEnabled, parsedQuery.microphoneChannel);

            if (changed.microphoneChannel !== undefined) {
                inputs.setupMicrophone();
            }
        }
        if (changed.speechOutput !== undefined) this.setSpeechOutput(!!changed.speechOutput);
        if (changed.tubeCpuMultiplier !== undefined) {
            machine.emulationConfig.tubeCpuMultiplier = changed.tubeCpuMultiplier;
            this.config.setTubeCpuMultiplier(changed.tubeCpuMultiplier);
            if (machine.processor.hasTube) {
                machine.processor.tube.cpuMultiplier = changed.tubeCpuMultiplier;
            }
        }
    }
}
