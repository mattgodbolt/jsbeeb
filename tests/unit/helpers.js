import { vi } from "vitest";

import { UrlState } from "../../src/web/url-state.js";

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

export const modalMarkup = (id, body) =>
    `<div id="${id}" class="modal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">${body}</div></div></div></div>`;

export const toasts = () =>
    [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());

/** A catalogued single-density image, the smallest thing discFor accepts. */
export function ssdImage(sectors = 800) {
    const data = new Uint8Array(80 * 10 * 256);
    data[0x106] = (sectors >>> 8) & 3;
    data[0x107] = sectors & 0xff;
    return data;
}

/**
 * For afterEach. Fake timers left running would outlive the file's jsdom
 * window and fail the run from outside any test when they fire, so they are
 * flushed before the clock goes back to real.
 */
export function teardownDom() {
    if (vi.isFakeTimers()) {
        vi.runAllTimers();
        vi.useRealTimers();
    }
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.localStorage.clear();
    window.sessionStorage.clear();
}
