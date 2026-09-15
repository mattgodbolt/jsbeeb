import { DefaultModel, findModel } from "../models.js";
import { DefaultAudioOutput, isAudioOutput } from "../audio-output.js";
import { guessModelFromHostname } from "../url-params.js";
import { fittedRoms } from "./config.js";
import { persistenceSettings } from "./canvas.js";
import { toast } from "./toast.js";

// Kept in browser storage for next time, as well as in the URL.
const StoredSettings = ["keyLayout", "displayMode", "audioOutput", "speakerAmount"];
// Set by sliders, so a burst of changes makes one history entry.
const SlidSettings = ["speakerAmount"];
for (const { setting } of persistenceSettings()) {
    StoredSettings.push(setting);
    SlidSettings.push(setting);
}

const storedNumber = (params, name, fallback) =>
    [params[name], parseFloat(window.localStorage[name])].find(Number.isFinite) ?? fallback;

/** The URL spellings of a model plus a fitting, from before fittings had settings of their own. */
export function mapLegacyModels(parsedQuery) {
    if (!parsedQuery.model) return;
    switch (parsedQuery.model.toLowerCase()) {
        case "masterturbo":
            parsedQuery.model = "Master";
            parsedQuery.coProcessor = true;
            break;
        case "bmusic5000":
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasMusic5000 = true;
            break;
        case "bteletext":
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasTeletextAdaptor = true;
            break;
    }
}

/**
 * The user's settings, resolved from the URL, browser storage and the
 * defaults. set() adopts a change, persists it and dispatches an event named
 * for each changed setting carrying its new value, then one "change" event
 * carrying them all; whatever a setting reaches subscribes with on().
 */
export class Settings extends EventTarget {
    constructor({ urlState }) {
        super();
        this.urlState = urlState;
        const params = urlState.params;
        mapLegacyModels(params);

        const requestedModelName = params.model || guessModelFromHostname(window.location.hostname);
        this.model = findModel(requestedModelName);
        if (!this.model) {
            toast(`There is no model called "${requestedModelName}". Using ${DefaultModel.name} instead.`, {
                title: "Model",
            });
            this.model = DefaultModel;
        }
        this.keyLayout =
            (params.keyLayout && `${params.keyLayout}`.toLowerCase()) || window.localStorage.keyLayout || "physical";
        this.tubeCpuMultiplier = params.tubeCpuMultiplier || 1;
        this.microphoneChannel = params.microphoneChannel;
        this.coProcessor = !!params.coProcessor;
        this.hasEconet = !!params.hasEconet;
        this.hasMusic5000 = !!params.hasMusic5000;
        this.hasTeletextAdaptor = !!params.hasTeletextAdaptor;
        this.mouseJoystickEnabled = !!params.mouseJoystickEnabled;
        this.speechOutput = !!params.speechOutput;
        this.displayMode = params.displayMode || window.localStorage.displayMode || "rgb";
        this.audioOutput =
            [params.audioOutput, window.localStorage.audioOutput].find(isAudioOutput) ?? DefaultAudioOutput;
        this.speakerAmount = storedNumber(params, "speakerAmount", 1);
        for (const { setting, default: fallback } of persistenceSettings())
            this[setting] = storedNumber(params, setting, fallback);
    }

    get extraRoms() {
        return fittedRoms(this);
    }

    /** Calls `listener` with the new value whenever the setting `name` is set. */
    on(name, listener) {
        this.addEventListener(name, () => listener(this[name]));
    }

    /** Adopts `changes` (an undefined value clears a setting), persists them and tells the subscribers. */
    set(changes) {
        for (const [name, value] of Object.entries(changes)) {
            this[name] = name === "model" ? (findModel(value) ?? this.model) : value;
            if (!StoredSettings.includes(name)) continue;
            if (value === undefined) window.localStorage.removeItem(name);
            else window.localStorage[name] = value;
        }
        this.urlState.set(changes, { settle: Object.keys(changes).some((name) => SlidSettings.includes(name)) });
        for (const name of Object.keys(changes)) this.dispatchEvent(new Event(name));
        this.dispatchEvent(new CustomEvent("change", { detail: changes }));
    }
}
