import { buildUrlFromParams, parseLocationParams } from "../url-params.js";
import { debounce } from "../debounce.js";
import { urlParamType } from "./parameters.js";
import { noteLocation } from "./analytics.js";

// A slider fires for every pixel of a drag, and each URL update is a history entry.
const UrlSettleMs = 300;

/**
 * The page's settings as carried in its URL. `params` is the one parsed
 * object: whoever changes a setting hands the change to set(), which edits
 * it in place and writes the URL in one step.
 */
export class UrlState {
    constructor(location, history, typeOf = urlParamType) {
        this.history = history;
        this.typeOf = typeOf;
        this.baseUrl = location.origin + location.pathname;
        this.params = parseLocationParams(location, typeOf);
        this.updateUrlOnceSettled = debounce(() => this.updateUrl(), UrlSettleMs);
    }

    /** The page's URL with the parameters as they are now. */
    url() {
        return buildUrlFromParams(this.baseUrl, this.params, this.typeOf);
    }

    /** The page's URL with some parameters changed, leaving `params` as it is. */
    urlWith(overrides) {
        return buildUrlFromParams(this.baseUrl, { ...this.params, ...overrides }, this.typeOf);
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
