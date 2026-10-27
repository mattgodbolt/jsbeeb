import { DefaultModel, findModel } from "../models.js";
import { guessModelFromHostname, ParamTypes } from "../url-params.js";
import { fittedRoms } from "./config.js";
import { toast } from "./toast.js";
import { Parameters } from "./parameters.js";

const fromStorage = {
    [ParamTypes.STRING]: (stored) => stored,
    [ParamTypes.INT]: (stored) => parseInt(stored, 10),
    [ParamTypes.FLOAT]: (stored) => parseFloat(stored),
    [ParamTypes.BOOL]: (stored) => (stored === undefined ? undefined : stored === "true"),
};

const suitsType = {
    [ParamTypes.STRING]: (value) => typeof value === "string" && value !== "",
    [ParamTypes.INT]: Number.isFinite,
    [ParamTypes.FLOAT]: Number.isFinite,
    [ParamTypes.BOOL]: (value) => typeof value === "boolean",
};

/** @returns {*} a setting's value as the URL, browser storage and its default give it, in that order of preference. */
function resolve(name, parameter, params) {
    const { type, valid, fromUrl = (value) => value, fit = (value) => value } = parameter;
    const usable = (value) => suitsType[type](value) && (!valid || valid(value));
    const candidates = [];
    if (suitsType[type](params[name])) candidates.push(fromUrl(params[name]));
    if (parameter.stored) candidates.push(fromStorage[type](window.localStorage[name]));
    const value = candidates.find(usable);
    return fit(value === undefined ? parameter.default : value);
}

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
    constructor({ urlState, parameters = Parameters }) {
        super();
        this.urlState = urlState;
        this.parameters = parameters;
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
        for (const [name, parameter] of Object.entries(parameters))
            if ("default" in parameter) this[name] = resolve(name, parameter, params);
    }

    /** A setting's value as the menu and the URL name it: the model by its synonym, or its name if it has none. */
    value(name) {
        return name === "model" ? (this.model.synonyms[0] ?? this.model.name) : this[name];
    }

    get fittedRoms() {
        return fittedRoms(this);
    }

    /** Calls `listener` with the new value whenever the setting `name` is set. */
    on(name, listener) {
        this.addEventListener(name, () => listener(this[name]));
    }

    /** Adopts `changes` (an undefined value clears a setting), persists them and tells the subscribers. */
    set(changes) {
        for (const [name, value] of Object.entries(changes)) {
            if (!(name in this.parameters)) throw new Error(`There is no setting called "${name}"`);
            const { fit } = this.parameters[name];
            if (fit && value !== undefined) changes[name] = fit(value);
        }
        for (const [name, value] of Object.entries(changes)) {
            const parameter = this.parameters[name];
            if (name === "model") this[name] = findModel(value) ?? this.model;
            else this[name] = value === undefined ? parameter.default : value;
            if (!parameter.stored) continue;
            if (value === undefined) window.localStorage.removeItem(name);
            else window.localStorage[name] = value;
        }
        const slid = Object.keys(changes).some((name) => this.parameters[name].slid);
        this.urlState.set(changes, { settle: slid });
        for (const name of Object.keys(changes)) this.dispatchEvent(new Event(name));
        this.dispatchEvent(new CustomEvent("change", { detail: changes }));
    }
}
