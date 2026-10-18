// The message a browser below package.json's browserslist sees, and what it tells Google Analytics, against the
// e2e build's dummy measurement id.

import { Beeb, expect, test } from "./fixtures.js";
import { floorText } from "../../tools/vite-plugin-browser-floor.js";

const ModuleScriptSrc = /<script type="module"[^>]* src="([^"]+)"/;

const analyticsCalls = (page, command) =>
    page.evaluate(
        (wanted) => (window.dataLayer ?? []).map((call) => Array.from(call)).filter((call) => call[0] === wanted),
        command,
    );

const unsupportedBrowserEvents = async (page) =>
    (await analyticsCalls(page, "event")).filter((call) => call[1] === "unsupported_browser");

test("a supported browser sees no message and reports nothing", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#browser-floor")).toBeHidden();
    expect(await unsupportedBrowserEvents(page)).toEqual([]);
});

test("a browser missing a floor feature is told what is needed, and the emulator still starts", async ({
    beeb,
    page,
}) => {
    await page.addInitScript(() => delete window.CompressionStream);
    await beeb.open();
    const message = page.locator("#browser-floor");
    await expect(message).toBeVisible();
    await expect(message).toContainText(`It needs ${floorText()} or newer.`);
    await expect(message).toContainText(/This looks like Chrome \d+\./);
    await expect(message.getByRole("link", { name: "matt@godbolt.org" })).toHaveAttribute(
        "href",
        "mailto:matt@godbolt.org",
    );
    expect(await unsupportedBrowserEvents(page)).toEqual([
        ["event", "unsupported_browser", { reason: "CompressionStream" }],
    ]);
    await beeb.expectScreenText(">");
    await message.getByRole("button", { name: "Close" }).click();
    await expect(message).toBeHidden();
});

const breakBundle = async (page) => {
    const html = await (await page.request.get("./")).text();
    const bundle = html.match(ModuleScriptSrc)[1].replace(/^\.\//, "/");
    await page.route(
        (url) => url.pathname.endsWith(bundle),
        (route) => route.fulfill({ contentType: "text/javascript", body: "const unparseable = ;" }),
    );
};

// These use a Beeb of their own rather than the fixture's, which fails a test whose page throws.

test("a bundle that fails to parse leaves the message, and its own page_view, instead of a blank page", async ({
    page,
}) => {
    const beeb = new Beeb(page);
    await breakBundle(page);
    await beeb.open("./?disc1=elite");
    await expect(page.locator("#browser-floor")).toBeVisible();
    expect(await unsupportedBrowserEvents(page)).toEqual([
        ["event", "unsupported_browser", { reason: "startup_failed" }],
    ]);
    const [config] = await analyticsCalls(page, "config");
    expect(config[1]).toBe("G-E2ETEST");
    expect(config[2].page_location).not.toContain("?");
});

test("a browser below the floor that cannot parse the bundle either is reported by the missing feature", async ({
    page,
}) => {
    const beeb = new Beeb(page);
    await page.addInitScript(() => delete window.CompressionStream);
    await breakBundle(page);
    await beeb.open();
    await expect(page.locator("#browser-floor")).toBeVisible();
    expect(await unsupportedBrowserEvents(page)).toEqual([
        ["event", "unsupported_browser", { reason: "CompressionStream" }],
    ]);
});

test("an error from another site's script shows no message", async ({ page }) => {
    const beeb = new Beeb(page);
    await page.route(/^https:\/\/www\.googletagmanager\.com\//, (route) =>
        route.fulfill({ contentType: "text/javascript", body: 'throw new Error("from Google");' }),
    );
    await beeb.open();
    await beeb.expectScreenText(">");
    expect(beeb.problems).not.toEqual([]);
    await expect(page.locator("#browser-floor")).toBeHidden();
    expect(await unsupportedBrowserEvents(page)).toEqual([]);
});
