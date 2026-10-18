import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { browserFloorPlugin, browserFloors, floorText } from "../../tools/vite-plugin-browser-floor.js";

const IndexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const PageUrl = "https://bbc.xania.org/index.html?disc1=sth:Mine.ssd#here";
const OurBundle = "https://bbc.xania.org/assets/index-abc.js";
const CurrentChrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36";
const OldChrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36";

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

/** The built page in a browser that sends `userAgent`, with gtag only with `ga`. */
async function open({ userAgent = CurrentChrome, ga = true } = {}) {
    const { window } = new JSDOM(pages[ga ? "withGa" : "withoutGa"], {
        url: PageUrl,
        referrer: "https://example.com/list?mine=1",
        runScripts: "dangerously",
        beforeParse(window) {
            Object.defineProperty(window.navigator, "userAgent", { value: userAgent });
            if (ga) {
                window.dataLayer = [];
                window.gtag = (...args) => window.dataLayer.push(args);
            }
        },
    });
    if (window.document.readyState === "loading") {
        await new Promise((resolve) => window.document.addEventListener("DOMContentLoaded", resolve));
    }
    return window;
}

const messageOf = (window) => window.document.getElementById("browser-floor");
const textOf = (window) => window.document.getElementById("browser-floor-text").textContent;
const errorFrom = (window, filename) => window.dispatchEvent(new window.ErrorEvent("error", { filename }));
const events = (window) => window.dataLayer.filter(([command]) => command === "event");

describe("the browser floor check", () => {
    beforeAll(async () => {
        pages.withGa = await builtPage("G-UNITTEST");
        pages.withoutGa = await builtPage(undefined);
    });

    afterAll(() => {
        delete pages.withGa;
        delete pages.withoutGa;
    });

    it("leaves a current browser alone", async () => {
        const window = await open();
        expect(messageOf(window).hidden).toBe(true);
        expect(window.dataLayer).toEqual([]);
    });

    describe("a browser below the floor", () => {
        it("is told its version and the one it needs", async () => {
            const window = await open({ userAgent: OldChrome });
            expect(messageOf(window).hidden).toBe(false);
            expect(textOf(window)).toBe(
                `You're using Chrome 100. jsbeeb needs Chrome ${browserFloors().Chrome} or newer.`,
            );
            expect(events(window)).toEqual([["event", "unsupported_browser", { reason: "below_floor" }]]);
        });

        it("is reported as below the floor even when startup then fails", async () => {
            const window = await open({ userAgent: OldChrome });
            errorFrom(window, OurBundle);
            expect(events(window)).toEqual([["event", "unsupported_browser", { reason: "below_floor" }]]);
        });

        it("sends its own config, without queries, when main.js never sent one", async () => {
            const window = await open({ userAgent: OldChrome });
            expect(window.dataLayer[0]).toEqual([
                "config",
                "G-UNITTEST",
                { page_location: "https://bbc.xania.org/index.html", page_referrer: "https://example.com/list" },
            ]);
        });

        it("sends nothing when the build had no measurement id", async () => {
            const window = await open({ userAgent: OldChrome, ga: false });
            expect(messageOf(window).hidden).toBe(false);
            expect(window.dataLayer).toBeUndefined();
        });

        it("is closed by its button", async () => {
            const window = await open({ userAgent: OldChrome });
            messageOf(window).querySelector("button").click();
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
    ])("names %s from its agent string", async (name, userAgent) => {
        const window = await open({ userAgent });
        expect(textOf(window)).toMatch(new RegExp(`^You're using ${name}\\. jsbeeb needs ${name.split(" ")[0]} `));
    });

    describe("an uncaught error before startup finishes", () => {
        it("names the browser and every supported version when it comes from the page's own scripts", async () => {
            const window = await open();
            errorFrom(window, OurBundle);
            expect(messageOf(window).hidden).toBe(false);
            expect(textOf(window)).toBe(`jsbeeb didn't start in Chrome 999. It supports ${floorText()} and newer.`);
            expect(events(window)).toEqual([["event", "unsupported_browser", { reason: "startup_failed" }]]);
        });

        it("leaves the config to main.js when it sent one", async () => {
            const window = await open();
            window.gtag("config", "G-UNITTEST", {});
            errorFrom(window, OurBundle);
            expect(window.dataLayer.filter(([command]) => command === "config")).toHaveLength(1);
        });

        it("is the only message an unrecognised browser gets", async () => {
            const window = await open({ userAgent: "SomethingElse/1.0" });
            expect(messageOf(window).hidden).toBe(true);
            errorFrom(window, OurBundle);
            expect(textOf(window)).toBe(`jsbeeb didn't start. It supports ${floorText()} and newer.`);
        });

        it.each(["https://www.googletagmanager.com/gtag/js", ""])("is ignored from %j", async (filename) => {
            const window = await open();
            errorFrom(window, filename);
            expect(messageOf(window).hidden).toBe(true);
            expect(window.dataLayer).toEqual([]);
        });

        it("is ignored once main.js says startup finished", async () => {
            const window = await open();
            window.jsbeebStartupFinished();
            errorFrom(window, OurBundle);
            expect(messageOf(window).hidden).toBe(true);
        });
    });
});
