import { afterEach, describe, expect, it, vi } from "vitest";

import { UrlState } from "../../src/web/url-state.js";
import { FloatingPanel } from "../../src/web/floating-panel.js";
import { StartEdge } from "../../src/web/panel-layout.js";
import { stitchHtml } from "../../tools/html-includes.js";
import { RomBankBytes } from "../../src/6502.js";
import { findModel } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";

let indexHtmlDoc = null;

/**
 * Builds the test DOM from the named elements of the real index.html, so a
 * rename or restructure there fails the unit tests instead of only the page.
 */
export function domFromIndexHtml(...ids) {
    if (!indexHtmlDoc) {
        indexHtmlDoc = new DOMParser().parseFromString(stitchHtml("index.html"), "text/html");
    }
    for (const id of ids) {
        const el = indexHtmlDoc.getElementById(id);
        if (!el) throw new Error(`index.html has no #${id}`);
        document.body.appendChild(document.importNode(el, true));
    }
}

/**
 * jsdom has no ResizeObserver, and lays nothing out for one to report.
 * @returns {(element: Element, height: number) => void} reports `element` resized to `height`
 */
export function stubResizeObserver() {
    const observers = new Map();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback) {
                this.callback = callback;
            }
            observe(element) {
                observers.set(element, [...(observers.get(element) ?? []), this.callback]);
            }
        },
    );
    return (element, height) => {
        for (const callback of observers.get(element)) callback([{ contentRect: { height } }]);
    };
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

/** Catches the files the page saves through `downloadBlob`, returning a list of them so far, each its name and blob. */
export function captureDownloads() {
    const blobs = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => `blob:${blobs.push(blob)}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return () => clicks.mock.contexts.map((anchor, i) => ({ name: anchor.download, blob: blobs[i] }));
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

/** Whether a mouse press on `target` is kept from moving the keyboard focus. */
export function pressKeepsFocus(target) {
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    target.dispatchEvent(press);
    return press.defaultPrevented;
}

/** A FloatingPanel on a bare element of its own, offered in menus as `title` under `menuGroup` (or not, for null). */
export function bareFloatingPanel(arrangement, id, title, menuGroup) {
    document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="${id}" hidden><div class="panel-header"><button class="panel-close"></button></div></div>`,
    );
    const element = document.getElementById(id);
    return new FloatingPanel({
        panel: element,
        id,
        title,
        menuGroup,
        group: null,
        place: () => ({ x: StartEdge, y: StartEdge }),
        minSize: { w: 100, h: 50 },
        reopens: false,
        arrangement,
    });
}

/**
 * Holds requestAnimationFrame callbacks until the test runs them. `run(time)` runs the frames queued so
 * far, not the ones they queue in turn.
 */
export function fakeAnimationFrames() {
    const queued = new Map();
    let lastHandle = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        queued.set(++lastHandle, callback);
        return lastHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => queued.delete(handle));
    return {
        get pending() {
            return queued.size;
        },
        run(time) {
            const due = [...queued.values()];
            queued.clear();
            for (const callback of due) callback(time);
        },
    };
}

/** The row of the decoded panel `panelId` that shows the register `name`. */
export const decodedRow = (panelId, name) =>
    [...document.querySelectorAll(`#${panelId} .decoded-registers tr`)].find(
        (row) => row.querySelector("th")?.textContent === name,
    );

/** What a decoded panel shows a register to mean: a lit bit as +name, an unlit one as -name, a value as itself. */
export const decodedMeanings = (panelId, name) =>
    [...decodedRow(panelId, name).querySelectorAll(".decoded-meaning span")].map((span) => {
        if (span.classList.contains("decoded-value")) return span.textContent;
        return `${span.classList.contains("lit") ? "+" : "-"}${span.textContent}`;
    });

/** The amplitude of the component of `samples` at `freq`, by the Goertzel algorithm. */
export function goertzelAmplitude(samples, freq, sampleRate) {
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
    let s1 = 0;
    let s2 = 0;
    for (const sample of samples) {
        const s0 = sample + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / samples.length;
}

export const ViaRegister = {
    ORB: 0x0,
    ORA: 0x1,
    DDRB: 0x2,
    DDRA: 0x3,
    T1CL: 0x4,
    T1CH: 0x5,
    T2CL: 0x8,
    T2CH: 0x9,
    SR: 0xa,
    ACR: 0xb,
    PCR: 0xc,
    IFR: 0xd,
    IER: 0xe,
    ORAnh: 0xf,
};

/** Where `address` in sideways `bank` is in `cpu.ramRomOs`. */
export const bankOffset = (cpu, bank, address) => cpu.romOffset + bank * RomBankBytes + address - 0x8000;

/** Puts a sideways ROM header in `bank`: a title, a version string if given, and the copyright string. */
export function fitRomHeader(cpu, bank, title, version) {
    const strings = version === undefined ? title : `${title}\0${version}`;
    const header = [0, 0, 0, 0, 0, 0, 0x82, 9 + strings.length, 1];
    const bytes = [...header, ...[...`${strings}\0(C)Acorn\0`].map((c) => c.charCodeAt(0))];
    cpu.ramRomOs.set(bytes, bankOffset(cpu, bank, 0x8000));
}

/** The model `name` finds, without its ROMs, which jsdom cannot fetch. */
export function romless(name) {
    const model = findModel(name);
    return Object.assign(Object.create(Object.getPrototypeOf(model)), model, { os: [] });
}

const FramebufferPixels = 1024 * 768;

/** A fake6502 machine with a real Video and SoundChip, so their state goes into its snapshots. */
export function machineWithRealChips(model, options) {
    return fake6502(model, {
        ...options,
        video: new Video(false, FramebufferPixels, () => {}),
        soundChip: new SoundChip(() => {}),
    });
}
