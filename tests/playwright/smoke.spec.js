// What only the built page in a real browser can show: main.js constructing
// everything against the built bundle, Bootstrap layout at real widths, a
// real keystroke, WebGL and WebAudio. Each test gets a page of its own.
//
//   npm run test:e2e                        build, then run every check in the system Chrome
//   npx playwright test --project chrome    the same without the build
//   npx playwright test --project chromium  the browser Playwright ships (npx playwright install chromium)
//   npx playwright test -g modal            checks whose name matches
//   npx playwright show-trace test-results/**/trace.zip
//
// BASE_URL=http://localhost:5173/ points a run at a server that is already up.

import { expect, test } from "./fixtures.js";

// Mirrored by tests/unit/test-console-surface.js.
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
const ShaderCompileBudgetMs = 30000;
// The bar expands at Bootstrap's lg breakpoint, 992px.
const LaptopWidths = [993, 1024, 1280, 1400, 1440, 1512, 1536, 1600];

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
        // A wider fallback font may truncate or hide the promo, which is
        // allowed; spilling over the controls is not.
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

test("the media window shows the drives, keeps the keyboard while focused, and gives it back", async ({
    beeb,
    page,
}) => {
    await beeb.open("?disc=elite.ssd");
    await beeb.expectDrive0("elite.ssd");
    await beeb.expectScreenText(">");
    await expect(page.locator('#leds .slot-readout[data-slot="0"] .name')).toHaveText("elite");
    await page.click('#leds .slot-readout[data-slot="0"]');
    await expect(page.locator("#media-panel")).toBeVisible();
    await expect(page.locator("#media-summary")).toHaveText("0: elite.ssd · 1: empty · tape: empty");
    await expect(page.locator('.bay[data-drive="0"] .bay-dfs')).toHaveText("Elite (05)");
    await page.focus("#media-close");
    await beeb.pressKey("a");
    await page.waitForTimeout(300);
    expect(await beeb.screenText()).not.toContain(">A");
    await page.keyboard.press("Escape");
    await expect(page.locator("#media-panel")).toBeHidden();
    await beeb.pressKey("a");
    await beeb.expectScreenText(">A");
});

test("the media window's list puts a built-in disc into drive 1", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.click("#navbarMedia");
    await expect(page.locator("#media-panel")).toBeVisible();
    await page.click('#media-into [data-target="1"]');
    await expect(page.locator('.bay[data-drive="1"]')).toHaveClass(/target/);
    await page.fill("#media-search", "welcome");
    const row = page.locator("#media-list .media-row-main").first();
    await expect(row).toHaveAttribute("title", /Load Welcome.*into drive 1/);
    await row.click();
    await expect(page.locator('.bay[data-drive="1"]')).toHaveAttribute("data-state", "loaded");
    await expect(page.locator('.bay[data-drive="1"] .bay-title')).toHaveText("Welcome");
    expect(await page.evaluate(() => window.processor.fdc.drives[1].disc?.name)).toBe("Welcome.ssd");
    await expect(page).toHaveURL(/disc2=Welcome\.ssd/);
});

test("the media window fills a phone's screen without scrolling sideways", async ({ beeb, page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await beeb.open("?disc=elite.ssd");
    await beeb.expectDrive0("elite.ssd");
    // The top bar is folded into its hamburger at this width; the LED panel's line still opens it.
    await page.click('#leds .slot-readout[data-slot="0"]');
    await expect(page.locator("#media-panel")).toBeVisible();
    await page.click('#media-into [data-target="1"]');
    const fit = await page.evaluate(() => {
        const panel = document.getElementById("media-panel");
        const box = panel.getBoundingClientRect();
        return {
            rightEdge: box.right,
            width: box.width,
            innerWidth: window.innerWidth,
            pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
            panelScrollsSideways: panel.scrollWidth > panel.clientWidth,
        };
    });
    expect(fit.rightEdge).toBeLessThanOrEqual(fit.innerWidth);
    expect(fit.width).toBe(fit.innerWidth);
    expect(fit.pageScrollsSideways).toBe(false);
    expect(fit.panelScrollsSideways).toBe(false);
});

test("a modal pauses the emulator and closing it resumes", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.armModalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await expect(page.locator("#debug-pause")).toBeDisabled();
    await beeb.expectModalShown();
    const during = await beeb.expectHeld();
    await page.click("#configuration .btn-close");
    await expect(page.locator("#debug-pause")).toBeEnabled();
    await beeb.expectRunningPast(during);
});

test("a setting changed in the dialog applies at once, reaches the URL and survives a reload", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#audio-output .active")).not.toHaveAttribute("data-output", "board");
    await beeb.armModalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await beeb.expectModalShown();
    await page.click("#audioOutputDropdown");
    await page.click('#configuration .audio-output-option[data-output="board"]');
    await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", "board");
    expect(new URL(page.url()).searchParams.get("audioOutput")).toBe("board");
    await page.click("#configuration .btn-close");
    // Back to a bare URL: only browser storage can carry the setting across.
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", "board");
});

test("a setting that needs a restart asks first, and Later keeps it for next time", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.armModalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await beeb.expectModalShown();
    await page.click("#bbc-model-dropdown");
    await page.click('#configuration .model-menu a[data-target="Master"]');
    await expect(page.locator("#restart-pending")).toBeVisible();
    // The prompt is raised from inside the settings dialog's own hide.
    await beeb.armModalShown("are-you-sure");
    await page.click("#configuration .btn-close");
    await beeb.expectModalShown();
    await expect(page.locator("#are-you-sure .context")).toContainText("Restart now?");
    const held = await beeb.expectHeld();
    await page.click("#are-you-sure .ays-no");
    await expect(page.locator("#are-you-sure")).toBeHidden();
    await expect(page.locator("#configuration")).toBeHidden();
    await beeb.expectRunningPast(held);
    expect(new URL(page.url()).searchParams.get("model")).toBe("Master");
    await beeb.armModalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await beeb.expectModalShown();
    await expect(page.locator("#restart-pending")).toBeVisible();
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
        // Picking a mode compiles its shaders under software GL, which blocks
        // the page well past the action default on a slow machine; the next
        // action would otherwise pay for it.
        const before = await beeb.cycles();
        await page.click(`#display-mode [data-mode="${mode}"]`, { timeout: ShaderCompileBudgetMs });
        await expect(page.locator("#display-mode .active")).toHaveAttribute("data-mode", mode, {
            timeout: ShaderCompileBudgetMs,
        });
        await beeb.expectRunningPast(before, ShaderCompileBudgetMs);
    }
    for (const output of outputs) {
        await page.click(`#audio-output [data-output="${output}"]`);
        await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", output);
    }
    await beeb.expectScreenText(">");
});
