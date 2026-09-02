import { allModels, findModel, tubeModelFor } from "../models.js";
import { getFilterForMode } from "../canvas.js";
import { AudioOutputs } from "../audio-output.js";

const round = (value) => Number(value.toFixed(2));

/** @returns {string} the speed a multiplier gives this machine's co-processor, e.g. "1.6x (4.8MHz)". */
export function tubeCpuSpeedLabel(multiplier, model) {
    return `${round(multiplier)}x (${round(multiplier * tubeModelFor(model).clockMhz)}MHz)`;
}

/**
 * The sideways ROMs the optional fittings need, in the order they claim banks.
 *
 * @param {{model: object, hasEconet: boolean, hasMusic5000: boolean, hasTeletextAdaptor: boolean}} settings
 * @returns {string[]}
 */
export function fittedRoms({ model, hasEconet, hasMusic5000, hasTeletextAdaptor }) {
    return [
        ...(hasEconet && model.isMaster ? ["master/anfs-4.25.rom"] : []),
        ...(hasMusic5000 ? ["ample.rom"] : []),
        ...(hasTeletextAdaptor ? ["ats-3.0.rom"] : []),
    ];
}

/** The settings the dialog presents as checkboxes. `enables` names a control only usable while ticked. */
const CheckboxSettings = [
    { id: "65c02", field: "coProcessor", restartRequired: true, enables: "tubeCpuMultiplier" },
    { id: "hasTeletextAdaptor", field: "hasTeletextAdaptor", restartRequired: true },
    { id: "hasEconet", field: "hasEconet", restartRequired: true },
    { id: "hasMusic5000", field: "hasMusic5000", restartRequired: true },
    { id: "mouseJoystickEnabled", field: "mouseJoystickEnabled" },
    { id: "speechOutput", field: "speechOutput" },
];

/** The model is not a checkbox, but changing it needs a restart just the same. */
const RestartRequiredFields = [
    "model",
    ...CheckboxSettings.filter((setting) => setting.restartRequired).map((setting) => setting.field),
];

/** @returns {boolean} whether any of the changed settings only take effect on a freshly built machine. */
export function needsRestart(changed) {
    return RestartRequiredFields.some((field) => field in changed);
}

/** @returns {boolean} whether the saved settings differ from those the running machine was built with. */
export function restartPending(settings, running) {
    return RestartRequiredFields.some((field) => settings[field] !== running[field]);
}

/**
 * The Settings dialog: shows the settings, applies the ones the machine can
 * follow live as they are picked, and saves the rest when it closes. Dispatches
 * "restart-required" after saving a change the running machine cannot follow.
 */
export class Config extends EventTarget {
    constructor(settings) {
        super();
        this.settings = settings;
        this.changed = {};
        // Built before anything can change, so this is what the running machine was built with.
        this.runningSettings = this.proposedSettings();
        this.setModel(settings.model);
        this.setKeyLayout(settings.keyLayout);
        this.setMicrophoneChannel(settings.microphoneChannel);
        this.setDisplayMode(settings.displayMode);
        this.setAudioOutput(settings.audioOutput);
        this.setSpeakerAmount(settings.speakerAmount);
        settings.on("audioOutput", (audioOutput) => this.setAudioOutput(audioOutput));
        settings.on("speakerAmount", (speakerAmount) => this.setSpeakerAmount(speakerAmount));
        settings.on("displayMode", (displayMode) => this.setDisplayMode(displayMode));

        const configuration = document.getElementById("configuration");
        configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            this.setDropdownText(settings.model.name);
            this.setTubeCpuMultiplier(settings.tubeCpuMultiplier);
            this.setCheckboxes(settings);
            this.showRestartPending();
        });

        configuration.addEventListener("hide.bs.modal", () => {
            const changed = this.changed;
            this.changed = {};
            if (Object.keys(changed).length === 0) return;
            settings.set(changed);
            // changed records which controls were touched, so a value in it can be what is already running.
            if (needsRestart(changed) && restartPending(this.proposedSettings(), this.runningSettings))
                this.dispatchEvent(new Event("restart-required"));
        });

        const modelMenu = document.querySelector(".model-menu");
        for (const model of allModels) {
            if (model.synonyms.length === 0) continue; // skip non-selectable models (e.g. Tube65C02)
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = "#";
            a.className = "dropdown-item";
            a.dataset.target = model.synonyms[0];
            a.textContent = model.name;
            li.appendChild(a);
            modelMenu.appendChild(li);
        }
        modelMenu.addEventListener("click", (e) => {
            const link = e.target.closest("a[data-target]");
            if (!link) return;
            this.changed.model = link.dataset.target;
            this.setDropdownText(link.textContent);
            this.showTubeCpuMultiplier(
                this.changed.tubeCpuMultiplier ?? this.settings.tubeCpuMultiplier,
                findModel(link.dataset.target),
            );
            this.showRestartPending();
        });

        for (const { id, field, enables } of CheckboxSettings) {
            document.getElementById(id).addEventListener("click", () => {
                const checked = document.getElementById(id).checked;
                this.changed[field] = checked;
                if (enables) document.getElementById(enables).disabled = !checked;
                this.showRestartPending();
            });
        }

        document.getElementById("tubeCpuMultiplier").addEventListener("input", () => {
            const val = parseFloat(document.getElementById("tubeCpuMultiplier").value);
            this.showTubeCpuMultiplier(val);
            this.changed.tubeCpuMultiplier = val;
        });

        for (const link of document.querySelectorAll(".keyboard-menu a")) {
            link.addEventListener("click", (e) => {
                e.preventDefault();
                const keyLayout = e.currentTarget.dataset.target;
                this.changed.keyLayout = keyLayout;
                this.setKeyLayout(keyLayout);
            });
        }

        for (const option of document.querySelectorAll(".mic-channel-option")) {
            option.addEventListener("click", (e) => {
                e.preventDefault();
                const channelString = e.currentTarget.dataset.channel;
                const channel = channelString === "" ? undefined : parseInt(channelString, 10);
                this.changed.microphoneChannel = channel;
                this.setMicrophoneChannel(channel);
            });
        }

        for (const option of document.querySelectorAll(".audio-output-option")) {
            option.addEventListener("click", (e) => {
                e.preventDefault();
                settings.set({ audioOutput: e.currentTarget.dataset.output });
            });
        }

        document.getElementById("speakerAmountSetting").addEventListener("input", (e) => {
            settings.set({ speakerAmount: parseFloat(e.currentTarget.value) });
        });

        for (const option of document.querySelectorAll(".display-mode-option")) {
            option.addEventListener("click", (e) => {
                e.preventDefault();
                settings.set({ displayMode: e.currentTarget.dataset.mode });
            });
        }
    }

    /**
     * The restart-required settings as they would be saved if the dialog were closed now, in the form the
     * menu and the URL use: the model by synonym rather than resolved, the fittings as booleans.
     */
    proposedSettings() {
        const saved = (field) => (field === "model" ? this.settings.model.synonyms[0] : this.settings[field]);
        return Object.fromEntries(RestartRequiredFields.map((field) => [field, this.changed[field] ?? saved(field)]));
    }

    showRestartPending() {
        const pending = restartPending(this.proposedSettings(), this.runningSettings);
        document.getElementById("restart-pending").classList.toggle("d-none", !pending);
    }

    /** Ticks the boxes named in `values`, leaving any the object does not mention alone. */
    setCheckboxes(values) {
        for (const { id, field, enables } of CheckboxSettings) {
            if (values[field] === undefined) continue;
            const checked = !!values[field];
            document.getElementById(id).checked = checked;
            if (enables) document.getElementById(enables).disabled = !checked;
        }
    }

    setAudioOutput(audioOutput) {
        const option = document.querySelector(`.audio-output-option[data-output="${audioOutput}"]`);
        for (const el of document.querySelectorAll(".audio-output-text")) el.textContent = option.textContent;
        document.getElementById("speakerAmountSetting").disabled = audioOutput !== AudioOutputs.speaker;
    }
    setSpeakerAmount(speakerAmount) {
        document.getElementById("speakerAmountSetting").value = speakerAmount;
    }
    setMicrophoneChannel(channel) {
        const text = channel !== undefined ? `Channel ${channel}` : "Disabled";
        for (const el of document.querySelectorAll(".mic-channel-text")) el.textContent = text;
    }

    setDisplayMode(mode) {
        const config = getFilterForMode(mode).getDisplayConfig();
        for (const el of document.querySelectorAll(".display-mode-text")) el.textContent = config.name;
    }

    /** Names the running machine everywhere the page shows it. */
    setModel(model) {
        for (const el of document.querySelectorAll(".bbc-model")) el.textContent = model.name;
        for (const el of document.querySelectorAll(".bbc-model-short")) el.textContent = model.shortName;
        const settingsLink = document.getElementById("model-settings");
        if (settingsLink) settingsLink.title = `${model.name}: emulation settings`;
    }

    setKeyLayout(keyLayout) {
        const text = keyLayout[0].toUpperCase() + keyLayout.substring(1);
        for (const el of document.querySelectorAll(".keyboard-layout")) el.textContent = text;
    }

    setTubeCpuMultiplier(value) {
        document.getElementById("tubeCpuMultiplier").value = value;
        this.showTubeCpuMultiplier(value);
    }

    showTubeCpuMultiplier(value, model = this.settings.model) {
        document.getElementById("tubeCpuMultiplierValue").textContent = tubeCpuSpeedLabel(value, model);
    }

    setDropdownText(modelName) {
        const el = document.querySelector("#bbc-model-dropdown .bbc-model");
        if (el) el.textContent = modelName;
    }
}
