import { buildUrlFromParams, ParamTypes, parseQueryString } from "../url-params.js";
import { debounce } from "../debounce.js";

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;

/**
 * Every parameter the page understands: how it is parsed and written back, and
 * what else it is. A `startupAction` has the page do something once it is up,
 * rather than describe it; a `stored` one is kept in browser storage for next
 * time as well as in the URL; a `slid` one is set by a slider, so a burst of
 * changes makes one history entry.
 */
export const UrlParams = {
    // Startup actions
    autoboot: { type: ParamTypes.BOOL, startupAction: true },
    autochain: { type: ParamTypes.BOOL, startupAction: true },
    autorun: { type: ParamTypes.BOOL, startupAction: true },
    autotype: { type: ParamTypes.STRING, startupAction: true },
    loadBasic: { type: ParamTypes.STRING, startupAction: true },
    embedBasic: { type: ParamTypes.STRING, startupAction: true },
    patch: { type: ParamTypes.STRING, startupAction: true },

    // Array parameters
    rom: { type: ParamTypes.ARRAY },

    // Boolean parameters
    embed: { type: ParamTypes.BOOL },
    fasttape: { type: ParamTypes.BOOL },
    noseek: { type: ParamTypes.BOOL },
    hasMusic5000: { type: ParamTypes.BOOL },
    hasTeletextAdaptor: { type: ParamTypes.BOOL },
    hasEconet: { type: ParamTypes.BOOL },
    glEnabled: { type: ParamTypes.BOOL },
    lowLatency: { type: ParamTypes.BOOL },
    fakeVideo: { type: ParamTypes.BOOL },
    logFdcCommands: { type: ParamTypes.BOOL },
    logFdcStateChanges: { type: ParamTypes.BOOL },
    coProcessor: { type: ParamTypes.BOOL },
    mouseJoystickEnabled: { type: ParamTypes.BOOL },
    speechOutput: { type: ParamTypes.BOOL },
    audioDebug: { type: ParamTypes.BOOL },

    // Numeric parameters
    stationId: { type: ParamTypes.INT },
    frameSkip: { type: ParamTypes.INT },
    videoCyclesBatch: { type: ParamTypes.INT },
    audiofilterfreq: { type: ParamTypes.FLOAT },
    audiofilterq: { type: ParamTypes.FLOAT },
    speakerAmount: { type: ParamTypes.FLOAT, stored: true, slid: true },
    palPersistenceMs: { type: ParamTypes.FLOAT, stored: true, slid: true },
    rgbPersistenceMs: { type: ParamTypes.FLOAT, stored: true, slid: true },
    audioLatencyMs: { type: ParamTypes.FLOAT },
    cpuMultiplier: { type: ParamTypes.FLOAT },
    tubeCpuMultiplier: { type: ParamTypes.FLOAT },
    microphoneChannel: { type: ParamTypes.INT },

    // String parameters (these are the default but listed for clarity)
    model: { type: ParamTypes.STRING },
    disc: { type: ParamTypes.STRING },
    disc1: { type: ParamTypes.STRING },
    disc2: { type: ParamTypes.STRING },
    tape: { type: ParamTypes.STRING },
    mmc: { type: ParamTypes.STRING },
    keyLayout: { type: ParamTypes.STRING, stored: true },
    displayMode: { type: ParamTypes.STRING, stored: true },
    audioOutput: { type: ParamTypes.STRING, stored: true },
    drive0Tracks: { type: ParamTypes.STRING },
    drive1Tracks: { type: ParamTypes.STRING },
    sbLeft: { type: ParamTypes.STRING },
    sbRight: { type: ParamTypes.STRING },
    sbBottom: { type: ParamTypes.STRING },
};

export const UrlParamTypes = Object.fromEntries(Object.entries(UrlParams).map(([name, { type }]) => [name, type]));

const paramsThatAre = (property) => Object.keys(UrlParams).filter((name) => UrlParams[name][property]);

export const StartupActionParams = paramsThatAre("startupAction");
export const StoredParams = paramsThatAre("stored");
export const SlidParams = paramsThatAre("slid");

/**
 * The page's settings as carried in its URL. `params` is the one parsed
 * object: whoever changes a setting hands the change to set(), which edits
 * it in place and writes the URL in one step.
 */
export class UrlState {
    constructor(location, history, paramTypes = UrlParamTypes) {
        this.history = history;
        this.paramTypes = paramTypes;
        this.baseUrl = location.origin + location.pathname;
        // Parameters may be given after the hash as well as in the query.
        const queryString = location.search.substring(1) + "&" + location.hash.substring(1);
        this.params = parseQueryString(queryString, paramTypes);
        this.updateUrlOnceSettled = debounce(() => this.updateUrl(), UrlSettleMs);
    }

    /** The page's URL with the parameters as they are now. */
    url() {
        return buildUrlFromParams(this.baseUrl, this.params, this.paramTypes);
    }

    /** The page's URL with some parameters changed, leaving `params` as it is. */
    urlWith(overrides) {
        return buildUrlFromParams(this.baseUrl, { ...this.params, ...overrides }, this.paramTypes);
    }

    /**
     * Apply `changes` to the parameters (undefined deletes a key) and push the
     * new URL; `settle: true` lets a burst of changes finish before pushing one
     * history entry for the lot.
     */
    set(changes, { settle = false } = {}) {
        let changed = false;
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) {
                if (key in this.params) changed = true;
                delete this.params[key];
            } else {
                if (this.params[key] !== value) changed = true;
                this.params[key] = value;
            }
        }
        if (!changed) return;
        if (settle) this.updateUrlOnceSettled();
        else this.updateUrl();
    }

    updateUrl() {
        this.history.pushState(null, null, this.url());
    }
}
