// The message a browser below package.json's browserslist sees, and what it tells Google Analytics, against the
// e2e build's dummy measurement id.

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

const analyticsCalls = (page, command) =>
    page.evaluate(
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
    expect(await analyticsCalls(page, "config"), "main.js's config").toHaveLength(1);
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

test("a browser below the floor is told so, and the emulator still starts", async ({ beeb, page }) => {
    await pretendToBe(page, Chrome105);
    await beeb.open();
    await expect(page.locator("#browser-floor")).toBeVisible();
    expect(await unsupportedBrowserEvents(page)).toEqual([["event", "unsupported_browser", { reason: "below_floor" }]]);
    expect(await analyticsCalls(page, "config"), "main.js's config and no other").toHaveLength(1);
    await beeb.expectScreenText(">");
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
    const beeb = new Beeb(page);
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
