import { buildUrlFromParams, parseQueryString } from "../url-params.js";
import { debounce } from "../debounce.js";
import { UrlParamTypes } from "./parameters.js";
import { noteLocation } from "./analytics.js";

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;

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
        noteLocation();
    }
}
