import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, vi } from "vitest";

import { UrlState } from "../../src/web/url-state.js";

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

/** The dependency bag the archive pickers take, every callback a mock. */
export function makeWebDeps() {
    return {
        media: {
            addSource: vi.fn(),
            setDisc1Image: vi.fn(),
            setTapeImage: vi.fn(),
            loadDiscImage: vi.fn(),
            loadTapeImage: vi.fn(),
            setProcessorTape: vi.fn(),
        },
        drives: { layoutForDrive: () => "auto", putDiscIn: vi.fn() },
        modals: { popupLoading: vi.fn(), loadingFinished: vi.fn() },
        urlState: { params: {}, updateUrl: vi.fn() },
        processor: { reset: vi.fn() },
        autoboot: vi.fn(),
    };
}

/** A real UrlState on a fake origin, with history that goes nowhere. */
export const fakeUrlState = (search = "") =>
    new UrlState({ origin: "https://bbc.example", pathname: "/", search, hash: "" }, { pushState: vi.fn() });

export const toasts = () =>
    [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());

/** A catalogued single-density image, the smallest thing discFor accepts. */
export function ssdImage(sectors = 800) {
    const data = new Uint8Array(80 * 10 * 256);
    data[0x106] = (sectors >>> 8) & 3;
    data[0x107] = sectors & 0xff;
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
    await disposeToasts();
    document.body.innerHTML = "";
    window.localStorage.clear();
    window.sessionStorage.clear();
}
