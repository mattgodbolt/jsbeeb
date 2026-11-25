// What jsbeeb tells Google Analytics, at top level, in another site's frame, in a browser whose WebGL fails and in a
// browser below package.json's browserslist (which also sees a message), against the e2e build's dummy measurement id.

import { createServer } from "node:http";

import { Beeb, expect, test } from "./fixtures.js";
import { floorText } from "../../tools/vite-plugin-browser-floor.js";

const ModuleScriptSrc = /<script type="module"[^>]* src="([^"]+)"/;
const Chrome105 =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36";

const pretendToBe = (page, userAgent) =>
    page.addInitScript(
        (agent) => Object.defineProperty(Navigator.prototype, "userAgent", { get: () => agent }),
        userAgent,
    );

const analyticsCalls = (pageOrFrame, command) =>
    pageOrFrame.evaluate(
        (wanted) => (window.dataLayer ?? []).map((call) => Array.from(call)).filter((call) => call[0] === wanted),
        command,
    );

const unsupportedBrowserEvents = async (page) =>
    (await analyticsCalls(page, "event")).filter((call) => call[1] === "unsupported_browser");

test("a supported browser starts the machine with its console names, loads gtag.js once, reports the start, and sees no message, even for an error once main.js has started", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    expect(await page.evaluate(() => [window.video, window.soundChip].map((part) => typeof part))).toEqual([
        "object",
        "object",
    ]);
    await expect(page.locator('script[src^="https://www.googletagmanager.com/gtag/js?id="]')).toHaveCount(1);
    const configs = await analyticsCalls(page, "config");
    expect(configs, "main.js's config").toHaveLength(1);
    expect(configs[0][2]).not.toHaveProperty("cookie_flags");
    await expect
        .poll(async () => (await analyticsCalls(page, "event")).filter((call) => call[1] === "machine_start"))
        .toEqual([
            [
                "event",
                "machine_start",
                expect.objectContaining({
                    renderer: expect.stringMatching(/^(webgl|canvas2d)$/),
                    audio: expect.stringMatching(/^(ok|unavailable)$/),
                }),
            ],
        ]);
    await page.evaluate(() => {
        const bundle = document.querySelector('script[type="module"]').src;
        window.dispatchEvent(new ErrorEvent("error", { filename: bundle }));
    });
    await expect(page.locator("#browser-floor")).toBeHidden();
    expect(await unsupportedBrowserEvents(page)).toEqual([]);
});

test("jsbeeb framed by another site asks Google Analytics for a cookie partitioned by that site", async ({
    beeb,
    page,
    baseURL,
}) => {
    const embedder = createServer((request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(`<iframe src="${new URL("?embed", baseURL)}" width="1000" height="800"></iframe>`);
    });
    await new Promise((resolve) => embedder.listen(0, "127.0.0.1", resolve));
    // A loopback name other than the frame's, so a different site; Chrome blocks a public page framing a local one.
    const hostName = new URL(baseURL).hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
    await beeb.routed;
    try {
        await page.goto(`http://${hostName}:${embedder.address().port}/`);
        const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
        await expect
            .poll(() => analyticsCalls(frame, "config"))
            .toEqual([
                ["config", "G-E2ETEST", expect.objectContaining({ cookie_flags: "SameSite=None;Secure;Partitioned" })],
            ]);
    } finally {
        embedder.close();
    }
});

test("a browser below the floor is told so, and the emulator still starts", async ({ beeb, page }) => {
    await pretendToBe(page, Chrome105);
    await beeb.open();
    await expect(page.locator("#browser-floor")).toBeVisible();
    expect(await unsupportedBrowserEvents(page)).toEqual([["event", "unsupported_browser", { reason: "below_floor" }]]);
    expect(await analyticsCalls(page, "config"), "main.js's config and no other").toHaveLength(1);
    await beeb.expectScreenText(">");
});

test("a browser whose WebGL fails to set up starts the machine on a 2D canvas in the screen's place, and reports that renderer", async ({
    beeb,
    page,
}) => {
    // As Safari has been seen to: a context, then no shader from it.
    await page.addInitScript(() => (WebGLRenderingContext.prototype.createShader = () => null));
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect
        .poll(
            async () => (await analyticsCalls(page, "event")).find((call) => call[1] === "machine_start")?.[2].renderer,
        )
        .toBe("canvas2d");
    expect(await unsupportedBrowserEvents(page)).toEqual([]);
    const screenHasPicture = () =>
        page.evaluate(() => {
            const screen = document.getElementById("screen");
            const { data } = screen.getContext("2d").getImageData(0, 0, screen.width, screen.height);
            return data.some((value, i) => i % 4 !== 3 && value !== 0);
        });
    await expect.poll(screenHasPicture, { message: "the prompt drawn on the screen in the page" }).toBe(true);
    const { laidOutWidth, shownWidth } = await page.evaluate(() => {
        const screen = document.getElementById("screen");
        return { laidOutWidth: parseFloat(screen.style.width), shownWidth: screen.getBoundingClientRect().width };
    });
    expect(shownWidth, "the screen in the page").toBeGreaterThan(0);
    expect(laidOutWidth, "the layout's width for the screen in the page").toBeCloseTo(shownWidth, 1);
});

const breakBundle = async (page) => {
    const html = await (await page.request.get("./")).text();
    const bundle = html.match(ModuleScriptSrc)[1].replace(/^\.\//, "/");
    await page.route(
        (url) => url.pathname.endsWith(bundle),
        (route) => route.fulfill({ contentType: "text/javascript", body: "const unparseable = ;" }),
    );
};

// A Beeb of its own rather than the fixture's, which fails a test whose page throws, so it checks the one throw itself.
test("a bundle that fails to parse leaves the message, and its own page_view, instead of a blank page", async ({
    page,
}) => {
    const beeb = new Beeb(page, { withServiceWorker: false });
    await breakBundle(page);
    await beeb.open("./?disc1=elite");
    await expect(page.locator("#browser-floor")).toBeVisible();
    await expect(page.locator("#browser-floor")).toContainText(
        new RegExp(`jsbeeb didn't start in Chrome \\d+\\. It supports ${floorText()} and newer\\.`),
    );
    expect(await unsupportedBrowserEvents(page)).toEqual([
        ["event", "unsupported_browser", { reason: "startup_failed" }],
    ]);
    const [config] = await analyticsCalls(page, "config");
    expect(config[1]).toBe("G-E2ETEST");
    expect(config[2].page_location).not.toContain("?");
    expect(beeb.problems).toEqual([expect.stringMatching(/^exception: Unexpected token/)]);
});
