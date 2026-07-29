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

/**
 * The settings the dialog presents as checkboxes: the element that shows them, the field they are held
 * in, whether they only take effect on a freshly built machine, and any control they enable.
 */
export const CheckboxSettings = [
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
        for (const { field } of CheckboxSettings) this[field] = false;
        this.runningSettings = null;
        const configuration = document.getElementById("configuration");
        configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            // The startup settings are pushed in after construction, so what the running machine was
            // built with is only knowable from the first time the dialog is opened.
            if (!this.runningSettings)
                this.runningSettings = Object.fromEntries(RestartRequiredFields.map((field) => [field, this[field]]));
            this.setDropdownText(this.model.name);
            this.setTubeCpuMultiplier(this.tubeCpuMultiplier);
            this.setCheckboxes(this);
            document
                .getElementById("restart-pending")
                .classList.toggle("d-none", !restartPending(this, this.runningSettings));
        });

        configuration.addEventListener("hide.bs.modal", () => {
            const changed = this.changed;
            if (changed.model !== undefined) this.setModel(changed.model);
            this.setCheckboxes(changed);
            this.onClose(changed);
            if (Object.keys(changed).length === 0) return;
            this.dispatchEvent(new CustomEvent("settings-changed", { detail: changed }));
            // changed records which controls were touched, so a value in it can be what is already running.
            if (needsRestart(changed) && restartPending(this, this.runningSettings)) this.onRestartRequired();
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

        for (const { id, field, enables } of CheckboxSettings) {
            document.getElementById(id).addEventListener("click", () => {
                const checked = document.getElementById(id).checked;
                this.changed[field] = checked;
                if (enables) document.getElementById(enables).disabled = !checked;
            });
        }

        document.getElementById("tubeCpuMultiplier").addEventListener("input", () => {
            const val = parseInt(document.getElementById("tubeCpuMultiplier").value, 10);
            document.getElementById("tubeCpuMultiplierValue").textContent = val;
            this.changed.tubeCpuMultiplier = val;
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

        for (const option of document.querySelectorAll(".display-mode-option")) {
            option.addEventListener("click", (e) => {
                const mode = e.target.dataset.mode;
                this.changed.displayMode = mode;
                this.setDisplayMode(mode);
                this.onChange({ displayMode: mode });
            });
        }
    }

    /** Ticks the boxes named in `values` and adopts them, leaving any the object does not mention alone. */
    setCheckboxes(values) {
        for (const { id, field, enables } of CheckboxSettings) {
            if (values[field] === undefined) continue;
            const checked = !!values[field];
            document.getElementById(id).checked = checked;
            this[field] = checked;
            if (enables) document.getElementById(enables).disabled = !checked;
        }
    }

    setMicrophoneChannel(channel) {
        const text = channel !== undefined ? `Channel ${channel}` : "Disabled";
        for (const el of document.querySelectorAll(".mic-channel-text")) el.textContent = text;
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

    setTubeCpuMultiplier(value) {
        this.tubeCpuMultiplier = value;
        document.getElementById("tubeCpuMultiplier").value = value;
        document.getElementById("tubeCpuMultiplierValue").textContent = value;
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
