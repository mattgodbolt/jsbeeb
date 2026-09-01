// The checks of tests/browser/smoke.js, on Playwright: what only the built
// page in a real browser can show. Each test gets a page of its own.
//
//   npm run e2e                       build, then run every check in the system Chrome
//   npx playwright test --project chromium   in the browser Playwright ships
//   npx playwright test -g modal             checks whose name matches
//   npx playwright show-trace test-results/**/trace.zip

import path from "node:path";

import { expect, test } from "./fixtures.js";

const ConsoleSurface = [
    "processor",
    "video",
    "soundChip",
    "go",
    "stop",
    "hd",
    "m7dump",
    "benchmarkCpu",
    "profileCpu",
    "benchmarkVideo",
    "profileVideo",
];

const OneRowWidth = 4000;
const LaptopWidths = [1024, 1280, 1400, 1440, 1512, 1536, 1600];

test("boots to the BASIC prompt with a working console surface", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText("BASIC");
    await beeb.expectScreenText(">");
    const missing = await page.evaluate(
        (names) => names.filter((name) => typeof window[name] === "undefined"),
        ConsoleSurface,
    );
    expect(missing, "names missing from window").toEqual([]);
    expect(typeof (await page.evaluate(() => window.processor.readmem(0)))).toBe("number");
});

test("the top bar is one row at laptop widths", async ({ beeb, page }) => {
    test.fixme(true, "main's bar wraps below 1400px; the fix is on claude/toolbar-tiers, whose smoke check this ports");
    const headerBar = async (width) => {
        await page.setViewportSize({ width, height: 900 });
        return page.evaluate(() => {
            const bar = document.getElementById("header-bar");
            const paste = document.getElementById("paste-text").getBoundingClientRect();
            const promo = bar.querySelector(".navbar-text");
            const promoState = () => {
                if (getComputedStyle(promo).display === "none") return "hidden";
                if (promo.getBoundingClientRect().right > promo.nextElementSibling.getBoundingClientRect().left)
                    return "overflowing";
                return promo.scrollWidth > promo.clientWidth ? "truncated" : "fits";
            };
            return {
                height: bar.offsetHeight,
                pasteFits: paste.width > 0 && paste.right <= innerWidth,
                promo: promoState(),
            };
        });
    };
    await beeb.open();
    await beeb.expectScreenText(">");
    const oneRow = await headerBar(OneRowWidth);
    expect(oneRow.promo, `the Owlet promo at ${OneRowWidth}px`).toBe("fits");
    for (const width of LaptopWidths) {
        const bar = await headerBar(width);
        expect(bar, `the bar at ${width}px`).toEqual({
            height: oneRow.height,
            pasteFits: true,
            promo: expect.not.stringMatching(/overflowing/),
        });
    }
});

test("typing at the keyboard reaches the machine", async ({ beeb }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.pressKey("a");
    await beeb.expectScreenText(">A");
});

test("a disc named in the URL is loaded and autobooted", async ({ beeb }) => {
    await beeb.open("?disc=elite.ssd&autoboot");
    await beeb.expectDrive0("elite.ssd");
    // Elite's loader leaves mode 7, so the prompt text goes away.
    await beeb.expectNotOnScreen("BASIC");
});

test("a modal pauses the emulator and closing it resumes", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    const shown = beeb.modalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await expect(page.locator("#debug-pause")).toBeDisabled();
    await shown;
    const during = await beeb.expectHeld();
    await page.click("#configuration .btn-close");
    await expect(page.locator("#debug-pause")).toBeEnabled();
    await beeb.expectRunningPast(during);
});

test("every display mode and sound output on the bar can be picked", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    const modes = await page
        .locator("#display-mode [data-mode]")
        .evaluateAll((els) => els.map((el) => el.dataset.mode));
    const outputs = await page
        .locator("#audio-output [data-output]")
        .evaluateAll((els) => els.map((el) => el.dataset.output));
    expect(modes).not.toEqual([]);
    expect(outputs).not.toEqual([]);
    for (const mode of modes) {
        await page.click(`#display-mode [data-mode="${mode}"]`);
        await expect(page.locator("#display-mode .active")).toHaveAttribute("data-mode", mode);
    }
    for (const output of outputs) {
        await page.click(`#audio-output [data-output="${output}"]`);
        await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", output);
    }
    await beeb.expectScreenText(">");
});

test("the pause and play buttons stop and start the emulator", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.click("#debug-pause");
    await expect(page.locator("#debug-play")).toBeEnabled();
    const stopped = await beeb.expectHeld();
    await page.click("#debug-play");
    await beeb.expectRunningPast(stopped);
});

test("Ctrl-Home stops into the debugger", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.keyboard.down("Control");
    await beeb.pressKey("Home");
    await page.keyboard.up("Control");
    await expect(page.locator("#debug-pause")).toBeDisabled();
    const stopped = await beeb.expectHeld(200);
    await page.click("#debug-play");
    await beeb.expectRunningPast(stopped);
});

test("a disc from the built-in list goes into drive 0", async ({ beeb, page }) => {
    await beeb.open("?disc=");
    await beeb.expectScreenText(">");
    const shown = beeb.modalShown("discs");
    await page.click("#navbarDiscs");
    await page.click('a[data-bs-target="#discs"]');
    await shown;
    const first = page.locator("#disc-list li:not(.template)").first();
    await expect(first.locator(".name")).toHaveText("Elite");
    await first.click();
    await beeb.expectDrive0("elite.ssd");
    await expect(page).toHaveURL(/disc1=elite\.ssd/);
});

test("the STH disc picker opens, shows its list and closes again", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    const shown = beeb.modalShown("sth");
    await page.click("#navbarDiscs");
    await page.click('a.sth[data-id="discs"]');
    await shown;
    await expect(page.locator("#sth-list .template")).toHaveCount(1);
    // The catalogue is fetched from the archive mirror, so a run cut off from
    // it still has to open the modal and report the failure inside it.
    const outcome = () =>
        page.evaluate(() => {
            if (document.querySelector("#sth-list li:not(.template)")) return "catalogue";
            const loading = document.querySelector("#sth .loading");
            if (loading.style.display !== "none" && loading.textContent.includes("error")) return "failure";
            return null;
        });
    await expect
        .poll(outcome, { message: "the catalogue, or word that it could not be fetched", timeout: 30000 })
        .not.toBeNull();
    if ((await outcome()) === "failure") beeb.forgiveProblems(/catalog|manifest|Failed to load resource/);
    await page.click("#sth .btn-close");
    await expect(page.locator("#sth")).not.toHaveClass(/show/);
    await expect(page.locator("#debug-pause")).toBeEnabled();
});

test("a local disc file goes into drive 0 and out of the URL", async ({ beeb, page }) => {
    await beeb.open("?disc=elite.ssd");
    await beeb.expectScreenText(">");
    await page.setInputFiles("#disc_load", path.resolve("dist/discs/Welcome.ssd"));
    await beeb.expectDrive0("Welcome.ssd");
    await expect(page, "a local disc cannot be named in the URL, yet").not.toHaveURL(/disc/);
});

test("a local tape file reaches the cassette interface", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.setInputFiles("#tape_load", path.resolve("dist/tapes/Welcome.uef"));
    await expect.poll(() => page.evaluate(() => !!window.processor.acia.tape), { message: "the tape" }).toBe(true);
});

test("a disc dropped on the paste box goes into drive 0", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    const dataTransfer = await page.evaluateHandle(async () => {
        const bytes = await (await fetch("discs/Welcome.ssd")).arrayBuffer();
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "dropped.ssd"));
        return transfer;
    });
    await page.dispatchEvent("#paste-text", "drop", { dataTransfer });
    await beeb.expectDrive0("dropped.ssd");
});

test("a saved state can be loaded back", async ({ beeb, page }) => {
    // A URL-named disc, so restoring goes back through the media loader.
    await beeb.open("?disc=elite.ssd");
    await beeb.expectScreenText(">");
    await beeb.pressKey("a");
    await beeb.expectScreenText(">A");
    const download = page.waitForEvent("download");
    await page.click("#navbarState");
    await page.click("#save-state");
    const saved = await (await download).path();
    await beeb.pressKey("b");
    await beeb.expectScreenText(">AB");
    await page.setInputFiles("#load-state", saved);
    await expect.poll(() => beeb.screenText(), { message: "the saved screen to come back" }).toMatch(/>A(?!B)/);
});
