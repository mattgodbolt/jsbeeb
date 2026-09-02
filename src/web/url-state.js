import { buildUrlFromParams, ParamTypes, parseQueryString } from "../url-params.js";
import { debounce } from "../utils.js";

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;

/** How each parameter the page understands is parsed and written back. */
export const UrlParamTypes = {
    // Array parameters
    rom: ParamTypes.ARRAY,

    // Boolean parameters
    embed: ParamTypes.BOOL,
    fasttape: ParamTypes.BOOL,
    noseek: ParamTypes.BOOL,
    autoboot: ParamTypes.BOOL,
    autochain: ParamTypes.BOOL,
    autorun: ParamTypes.BOOL,
    hasMusic5000: ParamTypes.BOOL,
    hasTeletextAdaptor: ParamTypes.BOOL,
    hasEconet: ParamTypes.BOOL,
    glEnabled: ParamTypes.BOOL,
    lowLatency: ParamTypes.BOOL,
    fakeVideo: ParamTypes.BOOL,
    logFdcCommands: ParamTypes.BOOL,
    logFdcStateChanges: ParamTypes.BOOL,
    coProcessor: ParamTypes.BOOL,
    mouseJoystickEnabled: ParamTypes.BOOL,
    speechOutput: ParamTypes.BOOL,
    audioDebug: ParamTypes.BOOL,

    // Numeric parameters
    stationId: ParamTypes.INT,
    frameSkip: ParamTypes.INT,
    videoCyclesBatch: ParamTypes.INT,
    audiofilterfreq: ParamTypes.FLOAT,
    audiofilterq: ParamTypes.FLOAT,
    speakerAmount: ParamTypes.FLOAT,
    audioLatencyMs: ParamTypes.FLOAT,
    cpuMultiplier: ParamTypes.FLOAT,
    tubeCpuMultiplier: ParamTypes.FLOAT,
    microphoneChannel: ParamTypes.INT,

    // String parameters (these are the default but listed for clarity)
    model: ParamTypes.STRING,
    disc: ParamTypes.STRING,
    disc1: ParamTypes.STRING,
    disc2: ParamTypes.STRING,
    tape: ParamTypes.STRING,
    mmc: ParamTypes.STRING,
    keyLayout: ParamTypes.STRING,
    autotype: ParamTypes.STRING,
    displayMode: ParamTypes.STRING,
    audioOutput: ParamTypes.STRING,
    drive0Tracks: ParamTypes.STRING,
    drive1Tracks: ParamTypes.STRING,
    loadBasic: ParamTypes.STRING,
    embedBasic: ParamTypes.STRING,
    patch: ParamTypes.STRING,
    sbLeft: ParamTypes.STRING,
    sbRight: ParamTypes.STRING,
    sbBottom: ParamTypes.STRING,
};

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
        for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) delete this.params[key];
            else this.params[key] = value;
        }
        if (settle) this.updateUrlOnceSettled();
        else this.updateUrl();
    }

    updateUrl() {
        this.history.pushState(null, null, this.url());
    }
}
