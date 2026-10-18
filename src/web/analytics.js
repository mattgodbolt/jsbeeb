import { buildUrlFromParams, ParamTypes, parseLocationParams } from "../url-params.js";
import { parameterFor, Parameters, urlParamType } from "./parameters.js";
import { errorLabel } from "./analytics-filters.js";

const MaxErrorsNoted = 10;
const StackFrame = /(?:^\s*at |@).*?([^\s(@]+):(\d+):(\d+)\)?\s*$/;

const measurementId = () => import.meta.env.GA_MEASUREMENT_ID;

/**
 * `href` with each parameter put through its `analyticsFilter`, read and written as the page reads and writes its own
 * URL; with no parameters at all when they cannot be decoded.
 */
export function analyticsLocation(href) {
    if (!href) return href;
    const url = new URL(href);
    const page = url.origin + url.pathname;
    try {
        const params = parseLocationParams(url, urlParamType);
        for (const [key, value] of Object.entries(params)) {
            const filter = parameterFor(key)?.parameter.analyticsFilter;
            if (filter && value !== null) params[key] = Array.isArray(value) ? value.map(filter) : filter(value);
        }
        return buildUrlFromParams(page, params, urlParamType);
    } catch {
        return page;
    }
}

/*global gtag*/
const injectedGtag = () => (measurementId() && typeof gtag === "function" ? gtag : undefined);

const pageLocations = () => ({
    page_location: analyticsLocation(window.location.href),
    page_referrer: analyticsLocation(document.referrer),
});

/**
 * Sends the page_view, telling Google Analytics where the page is as analyticsLocation does, and notes the errors
 * `page` reports.
 */
export function configureAnalytics(page = window) {
    injectedGtag()?.("config", measurementId(), pageLocations());
    page.addEventListener("error", (event) =>
        noteError("window", event.error ?? event.message, {
            file: event.filename,
            line: event.lineno,
            column: event.colno,
        }),
    );
    page.addEventListener("unhandledrejection", (event) => noteError("promise", event.reason));
}

/** Moves the location later events report to the URL the page has just pushed, without a page_view. */
export function noteLocation() {
    injectedGtag()?.("config", measurementId(), { ...pageLocations(), send_page_view: false });
}

/** Sends `event`, leaving out the parameters that are undefined. */
export function note(event, params) {
    const sent = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
    injectedGtag()?.("event", event, sent);
    console.log("event noted:", event, sent);
}

/**
 * Notes `action` on a feature: the `data-feature` that `feature`, an element, is or is inside, or nothing without
 * one; or `feature` itself, for a feature with no element to declare it on.
 */
export function noteFeature(feature, action) {
    const name = typeof feature === "string" ? feature : feature?.closest("[data-feature]")?.dataset.feature;
    if (name) note("feature_used", { feature: name, action });
}

const fileName = (url) => url.split(/[?#]/)[0].split("/").pop();

function stackPlace(stack) {
    for (const line of String(stack ?? "").split("\n")) {
        const frame = line.match(StackFrame);
        if (frame) return `${fileName(frame[1])}:${frame[2]}:${frame[3]}`;
    }
    return undefined;
}

const errorsNoted = new WeakSet();
let errorCount = 0;

/** Notes an error once however many places see it (the loop rethrows what it notes), and only the first few. */
export function noteError(where, error, { file, line, column } = {}) {
    if (Object(error) === error) {
        if (errorsNoted.has(error)) return;
        errorsNoted.add(error);
    }
    if (errorCount >= MaxErrorsNoted) return;
    ++errorCount;
    note("js_error", {
        where,
        message: errorLabel(error?.message ?? error),
        file_line: file ? `${fileName(file)}:${line}:${column}` : stackPlace(error?.stack),
    });
}

/**
 * Notes how the machine started: every parameter declared `reportedAtStart` as it is now, and what the page `found`,
 * once `audio` resolves to how the sound came up.
 */
export async function noteMachineStart(settings, params, found, audio) {
    const reported = Object.entries(Parameters)
        .filter(([, parameter]) => parameter.reportedAtStart)
        .map(([name, { type }]) => {
            const value = settings.value(name) ?? params[name];
            return [name, type === ParamTypes.BOOL ? !!value : value];
        });
    note("machine_start", { ...Object.fromEntries(reported), ...found, audio: await audio });
}
