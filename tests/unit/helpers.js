import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UrlState } from "../../src/web/url-state.js";
import { FloatingPanel } from "../../src/web/floating-panel.js";
import { StartEdge } from "../../src/web/panel-layout.js";

let indexHtmlDoc = null;

/**
 * Builds the test DOM from the named elements of the real index.html, so a
 * rename or restructure there fails the unit tests instead of only the page.
 */
export function domFromIndexHtml(...ids) {
    if (!indexHtmlDoc) {
        const indexHtml = resolve(dirname(expect.getState().testPath), "../../index.html");
        indexHtmlDoc = new DOMParser().parseFromString(readFileSync(indexHtml, "utf8"), "text/html");
    }
    for (const id of ids) {
        const el = indexHtmlDoc.getElementById(id);
        if (!el) throw new Error(`index.html has no #${id}`);
        document.body.appendChild(document.importNode(el, true));
    }
}

/** Enough of an FDC for the page's side of putting a disc in and taking it out. */
export function fakeFdc() {
    const drives = [
        { tracksPerStep: 1, disc: undefined },
        { tracksPerStep: 1, disc: undefined },
    ];
    return {
        drives,
        motorOn: [false, false],
        loadDisc: vi.fn((driveIndex, disc, fixed) => {
            drives[driveIndex].disc = disc;
            drives[driveIndex].tracksPerStep = fixed ?? (disc?.is40Track ? 2 : 1);
        }),
    };
}

/** A real UrlState on a fake origin, with history that goes nowhere. */
export const fakeUrlState = (search = "") =>
    new UrlState({ origin: "https://bbc.example", pathname: "/", search, hash: "" }, { pushState: vi.fn() });

/**
 * Makes a UrlState's urlWith record the URL it builds as `navigatedTo` and hand back a hash change
 * instead, which is the one navigation jsdom can follow.
 */
export function stubNavigation(urlState) {
    const build = urlState.urlWith.bind(urlState);
    urlState.navigatedTo = null;
    vi.spyOn(urlState, "urlWith").mockImplementation((overrides) => {
        urlState.navigatedTo = build(overrides);
        return `${window.location.href}#navigated`;
    });
    return urlState;
}

/**
 * Has analytics send to a stand-in gtag, as it does on the deployed site.
 * @returns {function(string): object[]} the parameters of each event sent with the name given, in order
 */
export function sentEvents() {
    const gtag = vi.fn();
    vi.stubEnv("GA_MEASUREMENT_ID", "G-UNITTEST");
    vi.stubGlobal("gtag", gtag);
    vi.spyOn(console, "log").mockImplementation(() => {});
    return (name) =>
        gtag.mock.calls
            .filter(([command, event]) => command === "event" && event === name)
            .map(([, , params]) => params);
}

export const toasts = () =>
    [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());

/** A fetch response carrying an archive manifest of `files`. */
export const manifestResponse = (files) => ({
    ok: true,
    status: 200,
    json: async () => ({ schemaVersion: 1, files }),
});

/** The catalogue behaviour every manifest-backed archive shares; `make()` builds one that reads `manifestUrl`. */
export function describeManifestCatalogue(make, manifestUrl) {
    describe("catalogue", () => {
        afterEach(() => vi.restoreAllMocks());

        it("fetches the manifest once", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifestResponse([{ path: "a.ssd" }]));
            const archive = make();
            await archive.catalogue();
            await archive.catalogue();
            expect(fetchSpy.mock.calls).toEqual([[manifestUrl]]);
        });

        it.each([
            ["a manifest the server will not send", { ok: false, status: 503 }, "503"],
            [
                "a manifest with no files array",
                { ok: true, status: 200, json: async () => ({}) },
                "missing files array",
            ],
        ])("rejects %s", async (_, response, message) => {
            vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
            await expect(make().catalogue()).rejects.toThrow(message);
        });
    });
}

/** A fetch response carrying `body` as its bytes. */
export const bytesResponse = (body = new Uint8Array()) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

/**
 * A single-density image whose DFS catalogue claims `sectors` sectors and
 * holds a file starting at each of `starts`, the smallest thing discFor accepts.
 */
export function ssdImage(sectors = 800, { starts = [], length = 80 * 10 * 256 } = {}) {
    const data = new Uint8Array(length);
    data[0x105] = starts.length * 8;
    data[0x106] = (sectors >>> 8) & 3;
    data[0x107] = sectors & 0xff;
    starts.forEach((start, entry) => {
        const offset = 0x108 + entry * 8;
        data[offset + 6] = (start >>> 8) & 3;
        data[offset + 7] = start & 0xff;
    });
    return data;
}

// A toast left mid-show leaks timers past this file's jsdom window: bootstrap
// fakes transitionend with an uncancellable short timer, which in turn arms
// the five second autohide. Let the transition finish while this window is
// still current, then dispose to cancel the autohide; either timer firing
// later crashes the run from whichever test file is running at the time.
async function disposeToasts() {
    if (!document.querySelector(".toast")) return;
    await vi.waitFor(() => {
        for (const el of document.querySelectorAll(".toast")) expect(el.classList.contains("showing")).toBe(false);
    });
    // Imported lazily: bootstrap cannot load outside jsdom, and node-environment
    // tests share this module for its other helpers.
    const { Toast } = await import("bootstrap");
    for (const el of document.querySelectorAll(".toast")) Toast.getInstance(el)?.dispose();
}

/**
 * For afterEach. Fake timers left running would outlive the file's jsdom
 * window and fail the run from outside any test when they fire, so they are
 * flushed before the clock goes back to real.
 */
export async function teardownDom() {
    if (vi.isFakeTimers()) {
        vi.runAllTimers();
        vi.useRealTimers();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await disposeToasts();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", window.location.pathname);
    window.localStorage.clear();
    window.sessionStorage.clear();
}

/** A FloatingPanel on a bare element of its own, offered in menus as `title` (or not, for null). */
export function bareFloatingPanel(arrangement, id, title) {
    document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="${id}" hidden><div class="header"><button class="close"></button></div></div>`,
    );
    const element = document.getElementById(id);
    return new FloatingPanel({
        panel: element,
        header: element.querySelector(".header"),
        closeButton: element.querySelector(".close"),
        id,
        title,
        place: () => ({ x: StartEdge, y: StartEdge }),
        minSize: { w: 100, h: 50 },
        reopens: false,
        arrangement,
    });
}
