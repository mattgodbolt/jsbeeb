import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { browserFloorPlugin } from "../../tools/vite-plugin-browser-floor.js";

const IndexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const PageUrl = "https://bbc.xania.org/index.html?disc1=sth:Mine.ssd#here";
const CurrentChrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const pages = {};

const builtPage = async (measurementId) => {
    const server = await createServer({
        configFile: false,
        logLevel: "silent",
        plugins: [browserFloorPlugin(measurementId)],
        server: { middlewareMode: true, hmr: false, ws: false },
    });
    try {
        return await server.transformIndexHtml("/index.html", IndexHtml);
    } finally {
        await server.close();
    }
};

/** The built page in a browser with every floor feature but those in `missing`, and gtag only with `ga`. */
async function open({ missing = [], userAgent = CurrentChrome, ga = true } = {}) {
    const dom = new JSDOM(pages[ga ? "withGa" : "withoutGa"], {
        url: PageUrl,
        referrer: "https://example.com/list?mine=1",
        runScripts: "dangerously",
        beforeParse(window) {
            Object.defineProperty(window.navigator, "userAgent", { value: userAgent });
            window.CSS = { supports: () => !missing.includes("color-mix") };
            if (missing.includes("toSorted")) delete window.Array.prototype.toSorted;
            else window.Array.prototype.toSorted ??= () => [];
            window.CompressionStream = missing.includes("CompressionStream") ? undefined : function () {};
            if (ga) {
                window.dataLayer = [];
                window.gtag = (...args) => window.dataLayer.push(args);
            }
        },
    });
    const { window } = dom;
    if (window.document.readyState === "loading") {
        await new Promise((resolve) => window.document.addEventListener("DOMContentLoaded", resolve));
    }
    return window;
}

const messageOf = (window) => window.document.getElementById("browser-floor");
const errorFrom = (window, filename) => window.dispatchEvent(new window.ErrorEvent("error", { filename }));

describe("the browser floor check", () => {
    beforeAll(async () => {
        pages.withGa = await builtPage("G-UNITTEST");
        pages.withoutGa = await builtPage(undefined);
    });

    afterAll(() => {
        delete pages.withGa;
        delete pages.withoutGa;
    });

    it("leaves a browser with every feature alone", async () => {
        const window = await open();
        expect(messageOf(window).hidden).toBe(true);
        expect(window.dataLayer).toEqual([]);
    });

    it.each(["color-mix", "toSorted", "CompressionStream"])("shows the message without %s", async (feature) => {
        const window = await open({ missing: [feature] });
        expect(messageOf(window).hidden).toBe(false);
        expect(window.dataLayer.at(-1)).toEqual(["event", "unsupported_browser", { reason: feature }]);
    });

    it("reports the first missing feature, not a later failed start", async () => {
        const window = await open({ missing: ["toSorted"] });
        errorFrom(window, "https://bbc.xania.org/assets/index-abc.js");
        expect(window.dataLayer.filter(([command]) => command === "event")).toEqual([
            ["event", "unsupported_browser", { reason: "toSorted" }],
        ]);
    });

    it("sends its own config, without queries, when main.js never sent one", async () => {
        const window = await open({ missing: ["color-mix"] });
        expect(window.dataLayer[0]).toEqual([
            "config",
            "G-UNITTEST",
            { page_location: "https://bbc.xania.org/index.html", page_referrer: "https://example.com/list" },
        ]);
    });

    it("leaves the config to main.js when it sent one", async () => {
        const window = await open();
        window.gtag("config", "G-UNITTEST", {});
        errorFrom(window, "https://bbc.xania.org/assets/index-abc.js");
        expect(window.dataLayer.filter(([command]) => command === "config")).toHaveLength(1);
    });

    it("sends nothing when the build had no measurement id", async () => {
        const window = await open({ missing: ["color-mix"], ga: false });
        expect(messageOf(window).hidden).toBe(false);
        expect(window.dataLayer).toBeUndefined();
    });

    describe("an uncaught error before startup finishes", () => {
        it("shows the message when it comes from the page's own scripts", async () => {
            const window = await open();
            errorFrom(window, "https://bbc.xania.org/assets/index-abc.js");
            expect(messageOf(window).hidden).toBe(false);
            expect(window.dataLayer.at(-1)).toEqual(["event", "unsupported_browser", { reason: "startup_failed" }]);
        });

        it.each(["https://www.googletagmanager.com/gtag/js", ""])("ignores one from %j", async (filename) => {
            const window = await open();
            errorFrom(window, filename);
            expect(messageOf(window).hidden).toBe(true);
            expect(window.dataLayer).toEqual([]);
        });

        it("is ignored once main.js says startup finished", async () => {
            const window = await open();
            window.jsbeebStartupFinished();
            errorFrom(window, "https://bbc.xania.org/assets/index-abc.js");
            expect(messageOf(window).hidden).toBe(true);
        });
    });

    it.each([
        ["Firefox 102", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0"],
        [
            "Safari 15.6",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15",
        ],
        [
            "Edge 18",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.18363",
        ],
        [
            "Edge 109",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.78",
        ],
        [
            "Edge 108",
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36 EdgA/108.0.1462.48",
        ],
        [
            "Chrome 100",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
        ],
    ])("names %s from its agent string", async (name, userAgent) => {
        const window = await open({ missing: ["color-mix"], userAgent });
        expect(messageOf(window).textContent).toContain(`This looks like ${name}.`);
    });

    it("names no browser it does not recognise", async () => {
        const window = await open({ missing: ["color-mix"], userAgent: "SomethingElse/1.0" });
        expect(messageOf(window).textContent).not.toContain("This looks like");
    });

    it("hides the message on Close", async () => {
        const window = await open({ missing: ["color-mix"] });
        window.document.getElementById("browser-floor-close").click();
        expect(messageOf(window).hidden).toBe(true);
    });
});
