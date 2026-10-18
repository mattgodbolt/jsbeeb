import { buildUrlFromParams, parseLocationParams } from "../url-params.js";
import { Parameters, UrlParamTypes } from "./parameters.js";

/*global gtag*/
const MeasurementId = import.meta.env.GA_MEASUREMENT_ID;

const analyticsFilter = (key) => (Object.hasOwn(Parameters, key) ? Parameters[key].analyticsFilter : undefined);

/**
 * `href` with each parameter put through its `analyticsFilter`, read and written as the page reads and writes its own
 * URL; with no parameters at all when they cannot be decoded.
 */
export function analyticsLocation(href) {
    if (!href) return href;
    const url = new URL(href);
    const page = url.origin + url.pathname;
    try {
        const params = parseLocationParams(url, UrlParamTypes);
        for (const [key, value] of Object.entries(params)) {
            const filter = analyticsFilter(key);
            if (filter && value !== null) params[key] = Array.isArray(value) ? value.map(filter) : filter(value);
        }
        return buildUrlFromParams(page, params, UrlParamTypes);
    } catch {
        return page;
    }
}

const injectedGtag = () => (MeasurementId && typeof gtag === "function" ? gtag : undefined);

const pageLocations = () => ({
    page_location: analyticsLocation(window.location.href),
    page_referrer: analyticsLocation(document.referrer),
});

/** Sends the page_view, telling Google Analytics where the page is as analyticsLocation does. */
export function configureAnalytics() {
    injectedGtag()?.("config", MeasurementId, pageLocations());
}

/** Moves the location later events report to the URL the page has just pushed, without a page_view. */
export function noteLocation() {
    injectedGtag()?.("config", MeasurementId, { ...pageLocations(), send_page_view: false });
}

export function noteEvent(category, type, label) {
    injectedGtag()?.("event", category, { type, label });
    console.log("event noted:", category, type, label);
}
