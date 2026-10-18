import { runningInNode } from "../loader.js";
import { Schemas, splitImage } from "../media-resolver.js";
import { Sources } from "./media-catalogue.js";
import { Parameters } from "./parameters.js";

/*global gtag*/
const MeasurementId = "G-Z9ZN3S7XRE";
const Redacted = "redacted";

/**
 * How analytics may name a media reference: whole when anyone could name it (a catalogue entry, a
 * built-in disc, a public URL), and only by its source when it is the user's own.
 */
export function mediaLabel(ref) {
    if (!ref) return ref;
    const { schema } = splitImage(ref);
    const known = Schemas[schema] ?? Schemas[""];
    const personal = known.source ? Sources[known.source]?.personal : known.personal;
    return personal ? (known.source ?? schema) : ref;
}

function analyticsParams(params) {
    return params
        .split("&")
        .map((part) => {
            const [rawKey, ...rest] = part.split("=");
            const key = decodeURIComponent(rawKey);
            const parameter = Object.hasOwn(Parameters, key) ? Parameters[key] : undefined;
            if (!rest.length || !parameter) return part;
            if (parameter.personal) return `${rawKey}=${Redacted}`;
            if (!parameter.mediaRef) return part;
            const ref = decodeURIComponent(rest.join("="));
            const label = mediaLabel(ref);
            return label === ref ? part : `${rawKey}=${encodeURIComponent(label)}`;
        })
        .join("&");
}

/**
 * `href` with its parameters as the `Parameters` table lets analytics see them, in the query and after the hash; with
 * none at all when they cannot be decoded.
 */
export function analyticsLocation(href) {
    if (!href) return href;
    const url = new URL(href);
    try {
        if (url.search) url.search = analyticsParams(url.search.substring(1));
        if (url.hash) url.hash = analyticsParams(url.hash.substring(1));
        return url.href;
    } catch {
        return url.origin + url.pathname;
    }
}

const analyticsReady = () => !runningInNode && typeof gtag === "function";

const pageLocations = () => ({
    page_location: analyticsLocation(window.location.href),
    page_referrer: analyticsLocation(document.referrer),
});

/** Sends the page_view, telling Google Analytics where the page is as analyticsLocation does. */
export function configureAnalytics() {
    if (analyticsReady()) gtag("config", MeasurementId, pageLocations());
}

/** Moves the location later events report to the URL the page has just pushed, without a page_view. */
export function noteLocation() {
    if (analyticsReady()) gtag("config", MeasurementId, { ...pageLocations(), send_page_view: false });
}

export function noteEvent(category, type, label) {
    if (
        !runningInNode &&
        (window.location.host.endsWith(".godbolt.org") || window.location.host.endsWith(".xania.org"))
    ) {
        // Only note events on the public site
        gtag("event", category, { type, label });
    }
    console.log("event noted:", category, type, label);
}
