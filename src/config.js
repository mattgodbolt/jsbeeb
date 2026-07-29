"use strict";
import { allModels, findModel } from "./models.js";
import { getFilterForMode } from "./canvas.js";

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

/** Settings that only take effect on a freshly built machine, so changing them leaves a restart pending. */
const RestartRequiredSettings = ["model", "coProcessor", "hasEconet", "hasMusic5000", "hasTeletextAdaptor"];

export class Config extends EventTarget {
    /**
     * @param {function(object)} onChange called as soon as a setting the emulator can follow live changes
     * @param {function(object)} onClose called with the settings to apply and persist
     * @param {function()} onRestartRequired called after the settings have been saved, when some of them
     *     will only take effect once the machine is rebuilt
     */
    constructor(onChange, onClose, onRestartRequired) {
        super();
        this.onChange = onChange;
        this.onClose = onClose;
        this.onRestartRequired = onRestartRequired;
        this.changed = {};
        this.model = null;
        this.coProcessor = false;
        this.hasEconet = false;
        this.hasMusic5000 = false;
        this.hasTeletextAdaptor = false;
        this.runningMachine = null;
        const configuration = document.getElementById("configuration");
        configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            // The startup settings are pushed in after construction, so the machine that is actually running
            // is only knowable from the first time the dialog is opened.
            if (!this.runningMachine) this.runningMachine = this.restartRequiredSettings();
            this.showCurrentSettings();
        });

        configuration.addEventListener("hide.bs.modal", () => {
            const changed = this.changed;
            this.adoptRestartSettings(changed);
            this.onClose(changed);
            if (Object.keys(changed).length === 0) return;
            this.dispatchEvent(new CustomEvent("settings-changed", { detail: changed }));
            if (RestartRequiredSettings.some((key) => key in changed)) this.onRestartRequired();
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
        });

        document.getElementById("65c02").addEventListener("click", () => {
            this.changed.coProcessor = document.getElementById("65c02").checked;
            document.getElementById("tubeCpuMultiplier").disabled = !document.getElementById("65c02").checked;
        });

        document.getElementById("tubeCpuMultiplier").addEventListener("input", () => {
            const val = parseInt(document.getElementById("tubeCpuMultiplier").value, 10);
            document.getElementById("tubeCpuMultiplierValue").textContent = val;
            this.changed.tubeCpuMultiplier = val;
        });

        document.getElementById("hasTeletextAdaptor").addEventListener("click", () => {
            this.changed.hasTeletextAdaptor = document.getElementById("hasTeletextAdaptor").checked;
        });

        document.getElementById("hasEconet").addEventListener("click", () => {
            this.changed.hasEconet = document.getElementById("hasEconet").checked;
        });

        document.getElementById("hasMusic5000").addEventListener("click", () => {
            this.changed.hasMusic5000 = document.getElementById("hasMusic5000").checked;
        });

        for (const link of document.querySelectorAll(".keyboard-menu a")) {
            link.addEventListener("click", (e) => {
                const keyLayout = e.target.dataset.target;
                this.changed.keyLayout = keyLayout;
                this.setKeyLayout(keyLayout);
            });
        }

        for (const option of document.querySelectorAll(".mic-channel-option")) {
            option.addEventListener("click", (e) => {
                const channelString = e.target.dataset.channel;
                const channel = channelString === "" ? undefined : parseInt(channelString, 10);
                this.changed.microphoneChannel = channel;
                this.setMicrophoneChannel(channel);
            });
        }

        document.getElementById("mouseJoystickEnabled").addEventListener("click", () => {
            this.changed.mouseJoystickEnabled = document.getElementById("mouseJoystickEnabled").checked;
        });

        document.getElementById("speechOutput").addEventListener("click", () => {
            this.changed.speechOutput = document.getElementById("speechOutput").checked;
        });

        for (const option of document.querySelectorAll(".display-mode-option")) {
            option.addEventListener("click", (e) => {
                const mode = e.target.dataset.mode;
                this.changed.displayMode = mode;
                this.setDisplayMode(mode);
                this.onChange({ displayMode: mode });
            });
        }
    }

    restartRequiredSettings() {
        return {
            model: this.model,
            coProcessor: this.coProcessor,
            hasEconet: this.hasEconet,
            hasMusic5000: this.hasMusic5000,
            hasTeletextAdaptor: this.hasTeletextAdaptor,
        };
    }

    /** @returns {boolean} whether the saved settings differ from the machine that is running. */
    get restartPending() {
        if (!this.runningMachine) return false;
        const settings = this.restartRequiredSettings();
        return RestartRequiredSettings.some((key) => settings[key] !== this.runningMachine[key]);
    }

    showCurrentSettings() {
        this.setDropdownText(this.model.name);
        this.set65c02(this.coProcessor);
        this.setTubeCpuMultiplier(this.tubeCpuMultiplier);
        this.setTeletext(this.hasTeletextAdaptor);
        this.setMusic5000(this.hasMusic5000);
        this.setEconet(this.hasEconet);
        document.getElementById("restart-pending").classList.toggle("d-none", !this.restartPending);
    }

    adoptRestartSettings(changed) {
        if (changed.model !== undefined) this.setModel(changed.model);
        if (changed.coProcessor !== undefined) this.set65c02(changed.coProcessor);
        if (changed.hasEconet !== undefined) this.setEconet(changed.hasEconet);
        if (changed.hasMusic5000 !== undefined) this.setMusic5000(changed.hasMusic5000);
        if (changed.hasTeletextAdaptor !== undefined) this.setTeletext(changed.hasTeletextAdaptor);
    }

    setMicrophoneChannel(channel) {
        const text = channel !== undefined ? `Channel ${channel}` : "Disabled";
        for (const el of document.querySelectorAll(".mic-channel-text")) el.textContent = text;
    }

    setMouseJoystickEnabled(enabled) {
        document.getElementById("mouseJoystickEnabled").checked = !!enabled;
    }

    setSpeechOutput(enabled) {
        document.getElementById("speechOutput").checked = !!enabled;
    }

    setDisplayMode(mode) {
        const config = getFilterForMode(mode).getDisplayConfig();
        for (const el of document.querySelectorAll(".display-mode-text")) el.textContent = config.name;
    }

    setModel(modelName) {
        this.model = findModel(modelName);
        for (const el of document.querySelectorAll(".bbc-model")) el.textContent = this.model.name;
    }

    setKeyLayout(keyLayout) {
        const text = keyLayout[0].toUpperCase() + keyLayout.substring(1);
        for (const el of document.querySelectorAll(".keyboard-layout")) el.textContent = text;
    }

    set65c02(enabled) {
        enabled = !!enabled;
        document.getElementById("65c02").checked = enabled;
        this.coProcessor = enabled;
        document.getElementById("tubeCpuMultiplier").disabled = !enabled;
    }

    setTubeCpuMultiplier(value) {
        this.tubeCpuMultiplier = value;
        document.getElementById("tubeCpuMultiplier").value = value;
        document.getElementById("tubeCpuMultiplierValue").textContent = value;
    }

    setEconet(enabled) {
        enabled = !!enabled;
        document.getElementById("hasEconet").checked = enabled;
        this.hasEconet = enabled;
    }

    setMusic5000(enabled) {
        enabled = !!enabled;
        document.getElementById("hasMusic5000").checked = enabled;
        this.hasMusic5000 = enabled;
    }

    setTeletext(enabled) {
        enabled = !!enabled;
        document.getElementById("hasTeletextAdaptor").checked = enabled;
        this.hasTeletextAdaptor = enabled;
    }

    setDropdownText(modelName) {
        const el = document.querySelector("#bbc-model-dropdown .bbc-model");
        if (el) el.textContent = modelName;
    }

    get extraRoms() {
        return fittedRoms(this);
    }

    mapLegacyModels(parsedQuery) {
        if (!parsedQuery.model) {
            return;
        }

        // "MasterTurbo" = Master + 6502 second processor
        if (parsedQuery.model.toLowerCase() === "masterturbo") {
            parsedQuery.model = "Master";
            parsedQuery.coProcessor = true;
        }

        // "BMusic5000" = BBC DFS 1.2 + Music 5000
        if (parsedQuery.model.toLowerCase() === "bmusic5000") {
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasMusic5000 = true;
        }

        // "BTeletext" = BBC DFS 1.2 + Teletext adaptor
        if (parsedQuery.model.toLowerCase() === "bteletext") {
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasTeletextAdaptor = true;
        }
    }
}
