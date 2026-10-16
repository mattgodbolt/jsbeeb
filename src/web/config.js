import { getFilterForMode, persistenceSettings } from "./canvas.js";
import { MasterAnfsRom } from "../econet.js";
import { ConfigForm, controlId, readoutId, renderConfigForm, settingFields, showValue } from "./config-form.js";

/**
 * The sideways ROMs the optional fittings need, in the order they claim banks.
 *
 * @param {{model: object, hasEconet: boolean, hasMusic5000: boolean, hasTeletextAdaptor: boolean}} settings
 * @returns {string[]}
 */
export function fittedRoms({ model, hasEconet, hasMusic5000, hasTeletextAdaptor }) {
    return [
        ...(hasEconet && model.isMaster ? [MasterAnfsRom] : []),
        ...(hasMusic5000 ? ["ample.rom"] : []),
        ...(hasTeletextAdaptor ? ["ats-3.0.rom"] : []),
    ];
}

const SettingFields = settingFields();
const RestartRequiredFields = SettingFields.filter((field) => field.restart).map((field) => field.setting);
const PersistenceField = ConfigForm.flat().find((field) => field.id === "persistence");

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
        // The setting the display in use declares, which is the mode asked for
        // unless that fell back; the page says which once the display exists.
        this.persistenceSetting = undefined;

        const configuration = document.getElementById("configuration");
        configuration
            .querySelector(".modal-body")
            .append(...renderConfigForm(ConfigForm, (field, value) => this.pick(field, value)));

        // Built before anything can change, so this is what the running machine was built with.
        this.runningSettings = this.proposedSettings();
        this.setModel(settings.model);
        this.showSaved();
        for (const field of SettingFields) {
            settings.on(field.setting, () => {
                showValue(field, this.saved(field.setting));
                this.showDependents();
            });
        }
        settings.on("displayMode", (displayMode) => this.setDisplayMode(displayMode));
        this.setDisplayMode(settings.displayMode);

        configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            this.showSaved();
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

        document.getElementById(controlId(PersistenceField)).addEventListener("input", (e) => {
            if (this.persistenceSetting) settings.set({ [this.persistenceSetting]: parseFloat(e.currentTarget.value) });
        });
        for (const { setting } of persistenceSettings()) settings.on(setting, () => this.setPersistenceSlider());
    }

    /** A setting as saved, in the form the menu and the URL use: the model by synonym rather than resolved. */
    saved(setting) {
        return setting === "model" ? this.settings.model.synonyms[0] : this.settings[setting];
    }

    /** Every setting the dialog shows, as it would be saved if the dialog were closed now. */
    proposedSettings() {
        return Object.fromEntries(
            SettingFields.map(({ setting }) => [
                setting,
                setting in this.changed ? this.changed[setting] : this.saved(setting),
            ]),
        );
    }

    pick(field, value) {
        if (field.live) {
            this.settings.set({ [field.setting]: value });
            return;
        }
        this.changed[field.setting] = value;
        showValue(field, value);
        this.showDependents();
    }

    showSaved() {
        for (const field of SettingFields) showValue(field, this.saved(field.setting));
        this.showDependents();
    }

    /** The parts of the dialog that follow from the settings as they would be saved. */
    showDependents() {
        const proposed = this.proposedSettings();
        for (const field of SettingFields) {
            if (field.enabledWhen) document.getElementById(controlId(field)).disabled = !field.enabledWhen(proposed);
            if (field.readout)
                document.getElementById(readoutId(field)).textContent = field.readout(
                    proposed[field.setting],
                    proposed,
                );
        }
        document
            .getElementById("restart-pending")
            .classList.toggle("d-none", !restartPending(proposed, this.runningSettings));
    }

    setDisplayMode(mode) {
        this.setPersistenceInUse(getFilterForMode(mode).getDisplayConfig().persistence?.setting);
    }

    /** The slider edits the persistence of the display in use, and is disabled for one without it. */
    setPersistenceInUse(setting) {
        this.persistenceSetting = setting;
        this.setPersistenceSlider();
    }

    setPersistenceSlider() {
        const slider = document.getElementById(controlId(PersistenceField));
        const afterglowMs = this.persistenceSetting ? this.settings[this.persistenceSetting] : 0;
        slider.disabled = !this.persistenceSetting;
        slider.value = afterglowMs;
        document.getElementById(readoutId(PersistenceField)).textContent = this.persistenceSetting
            ? PersistenceField.readout(afterglowMs)
            : "not available";
    }

    /** Names the running machine everywhere the page shows it. */
    setModel(model) {
        for (const el of document.querySelectorAll(".bbc-model")) el.textContent = model.name;
        for (const el of document.querySelectorAll(".bbc-model-short")) el.textContent = model.shortName;
        const settingsLink = document.getElementById("model-settings");
        if (settingsLink) settingsLink.title = `${model.name}: emulation settings`;
    }
}
