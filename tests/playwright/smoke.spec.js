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
// The short one is under the 1200x700 that hides the bar's headers, which leaves two lines.
const LightsBarViewports = [
    { width: 1400, height: 900, lines: 3 },
    { width: 390, height: 900, lines: 3 },
    { width: 1100, height: 650, lines: 2 },
];
const Oswrch = 0xffee;
// osnewl's JSR oswrch, a few instructions above oswrch itself.
const OsnewlCall = 0xffe9;
const BasicOswrchCall = 0x8e33;
const Unnamed = 0x3000;

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
            const paste = document.getElementById("paste-text").getBoundingClientRect();
            return {
                height: document.getElementById("header-bar").offsetHeight,
                pasteFits: paste.width > 0 && paste.right <= innerWidth,
            };
        });
    };
    await beeb.open();
    await beeb.expectScreenText(">");
    const oneRow = await headerBar(OneRowWidth);
    for (const width of LaptopWidths) {
        expect(await headerBar(width), `the bar at ${width}px`).toEqual({ height: oneRow.height, pasteFits: true });
    }
});

test("every label and lamp in the lights bar sits on one of its shared lines", async ({ beeb, page }) => {
    const lightsBarItems = () =>
        page.evaluate(() =>
            [...document.querySelectorAll("#leds .slot-readout, #leds .cell")]
                .filter((item) => item.getClientRects().length)
                .map((item) => {
                    const box = item.getBoundingClientRect();
                    const group = item.parentElement.getBoundingClientRect();
                    const rects = [...item.querySelectorAll(".led, [data-icon] > svg")].map((lamp) =>
                        lamp.getBoundingClientRect(),
                    );
                    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        if (!walker.currentNode.textContent.trim()) continue;
                        const range = document.createRange();
                        range.selectNodeContents(walker.currentNode);
                        rects.push(...range.getClientRects());
                    }
                    const centres = rects
                        .filter((rect) => rect.height)
                        .map((rect) => Math.round((rect.top + rect.bottom) / 2 - box.top));
                    return {
                        label: item.textContent.trim().replace(/\s+/g, " "),
                        fillsItsGroup: box.top === group.top && box.bottom === group.bottom,
                        centres: [...new Set(centres)],
                    };
                }),
        );
    await beeb.open("?disc=elite.ssd&tape=Welcome.uef");
    await beeb.expectDrive0("elite.ssd");
    const counter = page.locator('#leds [data-slot="tape"] .counter');
    await expect(counter).not.toBeEmpty();
    await expect(counter, "the deck's counter styling reaching the bar").toHaveCSS("box-shadow", "none");
    await expect(page.locator("#leds .virtualMHz")).not.toBeEmpty();
    for (const { width, height, lines } of LightsBarViewports) {
        await page.setViewportSize({ width, height });
        const items = await lightsBarItems();
        const where = `at ${width}x${height}: ${JSON.stringify(items)}`;
        expect(
            items.every(({ fillsItsGroup }) => fillsItsGroup),
            `items not filling their group ${where}`,
        ).toBe(true);
        expect(new Set(items.flatMap(({ centres }) => centres)).size, `lines ${where}`).toBe(lines);
    }
});

test("typing at the keyboard reaches the machine", async ({ beeb }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.pressKey("a");
    await beeb.expectScreenText(">A");
});

test("a breakpoint in the MOS names its addresses, and says where the names came from", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.evaluate((address) => window.processor.debugInstruction.add((pc) => pc === address), Oswrch);
    await beeb.pressKey("a");
    const stopped = page.locator("#disassembly .highlight");
    await expect(stopped.locator(".dis_addr")).toHaveText(/^ffee (oswrch|OSWRCH)$/);
    await expect(stopped.locator(".disassembly")).toHaveText(/^JMP \((wrchv|vectorWRCHV)\) ; \$[0-9a-f]{4}$/);
    await expect(page.locator(`#disassembly [data-addr="${OsnewlCall}"] .disassembly`)).toHaveText(
        /^JSR (oswrch|OSWRCH)$/,
    );
    await expect(page.locator("#debug-symbols")).toHaveText(
        /^names from BBC Micro MOS 1\.20 \((?:tobylobster\.github\.io, )?source\)$/,
    );
    const panelWidth = () => page.locator("#debug").evaluate((panel) => panel.getBoundingClientRect().width);
    const goTo = async (address) => {
        const box = page.locator("#goto-dis-addr-form .goto-addr");
        await box.fill(`$${address.toString(16)}`);
        await box.press("Enter");
    };
    await goTo(Unnamed);
    await expect(page.locator("#debug-symbols")).toHaveCSS("visibility", "hidden");
    const uncreditedWidth = await panelWidth();
    await goTo(BasicOswrchCall);
    await expect(page.locator(`#disassembly [data-addr="${BasicOswrchCall}"] .disassembly`)).toHaveText(
        /^JSR (oswrch|OSWRCH)$/,
    );
    await expect(page.locator("#debug-symbols")).toHaveText(
        /^names from BBC Micro MOS 1\.20 \((?:tobylobster\.github\.io, )?source\) · BBC BASIC II \(acornaeology\.uk, source\)$/,
    );
    await expect(page.locator("#debug-symbols a", { hasText: "acornaeology.uk" })).toHaveAttribute(
        "href",
        "https://acornaeology.uk/bbc-basic/2.html",
    );
    expect(await panelWidth()).toBe(uncreditedWidth);
    await page.locator("#debug-symbols").evaluate((line) => line.append(" · a set with a long title".repeat(20)));
    expect(await panelWidth()).toBe(uncreditedWidth);
});

test("a state saved at a breakpoint loads paused there in the debugger, on this machine or another, and one continue runs past it", async ({
    beeb,
    page,
}) => {
    const pc = () => page.evaluate(() => window.processor.pc);
    const where = async () => ({ pc: await pc(), cycles: await beeb.cycles() });
    const stoppedAtOswrch = page.locator("#disassembly .highlight .dis_addr");
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.evaluate((address) => {
        window.e2eBreakpoint = window.processor.debugInstruction.add((at) => at === address);
    }, Oswrch);
    await beeb.pressKey("a");
    await expect(stoppedAtOswrch).toHaveText(/^ffee /);
    const savedAt = await where();
    const download = page.waitForEvent("download");
    await page.locator("#save-state").dispatchEvent("click");
    const saved = await (await download).path();
    await page.click("#debug-play");
    await beeb.expectRunningPast(savedAt.cycles);

    // Each load starts with the machine running and the debugger shut. The play button comes on as soon as the load
    // holds the machine, long before the state is in; the debugger opening is what says it is.
    const loadAndContinue = async (file) => {
        await page.setInputFiles("#load-state", file);
        await expect(page.locator("#debug")).toBeVisible();
        expect(await where()).toEqual(savedAt);
        await expect(page.locator("#debug-play")).toBeEnabled();
        await expect(stoppedAtOswrch).toHaveText(/^ffee /);
        const loaded = await beeb.expectHeld();
        await page.click("#debug-play");
        await beeb.expectRunningPast(loaded);
        await expect.poll(pc).not.toBe(Oswrch);
    };

    await loadAndContinue(saved);

    await page.evaluate(() => window.e2eBreakpoint.remove());
    await expect(page.locator("#debug-pause")).toBeEnabled();

    await loadAndContinue(saved);

    await beeb.open("?model=Master");
    await beeb.expectScreenText(">");

    await loadAndContinue(saved);
});

test("a disc named in the URL is loaded and autobooted", async ({ beeb }) => {
    await beeb.open("?disc=elite.ssd&autoboot");
    await beeb.expectDrive0("elite.ssd");
    // Elite's loader leaves mode 7, so the prompt text goes away.
    await beeb.expectNotOnScreen("BASIC");
});

test("analytics is told the page's location with the user's own disc and session name taken out", async ({
    beeb,
    page,
}) => {
    await beeb.open("?disc=elite.ssd&disc2=local:Mine&name=Someone&model=B");
    await expect(page.locator('script[src^="https://www.googletagmanager.com/gtag/js?id="]')).toHaveCount(1);
    const configs = await page.evaluate(() =>
        window.dataLayer.filter((entry) => entry[0] === "config").map((entry) => entry[2].page_location),
    );
    expect(configs).toEqual([expect.stringMatching(/\?disc=elite\.ssd&disc2=browser&name=redacted&model=B$/)]);
    const sent = (name) =>
        page.evaluate(
            (name) =>
                window.dataLayer.filter((entry) => entry[0] === "event" && entry[1] === name).map((entry) => entry[2]),
            name,
        );
    await expect
        .poll(() => sent("machine_start"))
        .toEqual([
            {
                model: "B-DFS0.9",
                keyLayout: "physical",
                embed: false,
                boot_mode: "none",
                renderer: expect.stringMatching(/^(webgl|canvas2d)$/),
                audio: expect.stringMatching(/^(ok|unavailable)$/),
            },
        ]);
    const loads = await sent("media_load");
    expect(loads).toContainEqual({
        source: "builtin",
        kind: "disc",
        slot: "drive0",
        entry: "url",
        ref: "elite.ssd",
        result: "loaded",
    });
    expect(loads).toContainEqual(expect.objectContaining({ slot: "drive1", source: "browser", ref: "browser" }));
    expect(JSON.stringify(loads)).not.toContain("Mine");
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
    await page.keyboard.press("Escape");
    await expect(page.locator("#media-panel")).toBeHidden();
    await beeb.pressKey("b");
    await beeb.expectScreenText(">B");
    expect(await beeb.screenText()).not.toContain(">AB");
});

test("Alt+M opens the window aimed at drive 0 with the search box focused, and typing there stays on the page", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.keyboard.press("Alt+M");
    await expect(page.locator("#media-panel")).toBeVisible();
    await expect(page.locator('.bay[data-drive="0"]')).toHaveClass(/target/);
    await expect(page.locator("#media-search")).toBeFocused();
    await page.keyboard.type("welcome");
    await expect(page.locator("#media-search")).toHaveValue("welcome");
    await expect(page.locator("#media-list .media-row-main").first()).toHaveAttribute("title", /Boot Welcome/);
    await page.keyboard.press("Escape");
    await expect(page.locator("#media-panel")).toBeHidden();
    await beeb.pressKey("b");
    await beeb.expectScreenText(">B");
    expect(await beeb.screenText()).not.toContain("WELCOME");
});

test("Enter in the media window boots the best match from drive 0, and the URL says so", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.click("#navbarMedia");
    await expect(page.locator("#media-panel .autoboot")).toBeChecked();
    await expect(page.locator("#media-hint")).toContainText("Enter boots from drive 0");
    await page.fill("#media-search", "elite");
    await expect(page.locator("#media-list .media-row-main").first()).toHaveAttribute("title", /^Boot Elite/);
    await page.keyboard.press("Enter");
    await beeb.expectDrive0("elite.ssd");
    await beeb.expectNotOnScreen("BASIC");
    await expect(page).toHaveURL(/[?&]autoboot(&|$)/);
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

test("help fits a desktop browser window whole, and on a phone or tablet scrolls under its own header", async ({
    beeb,
    page,
}) => {
    const helpLayout = async ({ width, height }) => {
        await page.setViewportSize({ width, height });
        await beeb.open();
        await beeb.expectScreenText(">");
        await beeb.armModalShown("help");
        await page.evaluate(() => document.querySelector('a[data-bs-target="#help"]').click());
        await beeb.expectModalShown();
        return page.evaluate(() => {
            const modal = document.getElementById("help");
            const body = modal.querySelector(".modal-body");
            const close = modal.querySelector(".btn-close").getBoundingClientRect();
            return {
                closeOnScreen: close.top >= 0 && close.bottom <= innerHeight,
                modalScrolls: modal.scrollHeight > modal.clientHeight,
                bodyScrolls: body.scrollHeight > body.clientHeight,
                scrollsSideways: body.scrollWidth > body.clientWidth || modal.scrollWidth > modal.clientWidth,
            };
        });
    };
    expect(await helpLayout({ width: 1920, height: 940 })).toEqual({
        closeOnScreen: true,
        modalScrolls: false,
        bodyScrolls: false,
        scrollsSideways: false,
    });
    for (const narrow of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
    ]) {
        expect(await helpLayout(narrow), `at ${narrow.width}x${narrow.height}`).toEqual({
            closeOnScreen: true,
            modalScrolls: false,
            bodyScrolls: true,
            scrollsSideways: false,
        });
    }
});

test("the help names the shortcuts by Alt, and on a Mac by the Option symbol", async ({ beeb, page }) => {
    const helpKeys = async () => {
        await beeb.open();
        await beeb.expectScreenText(">");
        return page.locator("#help .key").allTextContents();
    };
    const keys = await helpKeys();
    expect(keys).toEqual(expect.arrayContaining(["Alt-S", "Alt-Shift-M", "Alt-1 to Alt-8", "Alt"]));
    expect(keys.filter((key) => key.includes("⌥"))).toEqual([]);

    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    const macKeys = await helpKeys();
    expect(macKeys).toEqual(expect.arrayContaining(["⌥S", "⌥⇧M", "⌥1 to ⌥8", "⌥"]));
    expect(macKeys.filter((key) => key.includes("Alt"))).toEqual([]);
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

test("a drive bay shows one thing at a time: the note when empty, the jacket when loaded, neither twice while busy", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.click("#navbarMedia");
    await expect(page.locator("#media-panel")).toBeVisible();
    // The archives' listing arriving redraws the bays from the drives, undoing a state forced on one before it.
    await expect(page.locator("#media-count")).not.toBeEmpty();
    const visible = (selector) => page.locator(`.bay[data-drive="0"] ${selector}`).isVisible();
    const shown = async () => ({ note: await visible(".empty-note"), jacket: await visible(".jacket") });
    // The page boots with a disc in drive 0; ejecting it is the empty state.
    await page.click('.bay[data-drive="0"] .bay-eject');
    await expect(page.locator('.bay[data-drive="0"]')).toHaveAttribute("data-state", "empty");
    expect(await shown()).toEqual({ note: true, jacket: false });
    await page.evaluate(() => (document.querySelector('.bay[data-drive="0"]').dataset.state = "busy"));
    expect(await shown()).toEqual({ note: false, jacket: true });
    await page.evaluate(() => (document.querySelector('.bay[data-drive="0"]').dataset.state = "loaded"));
    expect(await shown()).toEqual({ note: false, jacket: true });
});

// A Bitshifters catalogue of one disc, served in place of the site so the test needs no network.
const BitshiftersContent = "https://bitshifters.github.io/content/";
const catalogueOfOne = (page) =>
    Promise.all([
        page.route(`${BitshiftersContent}manifest.json`, (route) =>
            route.fulfill({
                json: {
                    schemaVersion: 1,
                    files: [{ path: "bs-paradroid.ssd", title: "Paradroid", type: "Game", machine: "Master" }],
                },
            }),
        ),
        page.route(`${BitshiftersContent}bs-paradroid.ssd`, (route) =>
            route.fulfill({ path: "public/discs/elite.ssd", contentType: "application/octet-stream" }),
        ),
    ]);

test("a link that boots a Bitshifters disc without naming a model comes up on the machine it needs", async ({
    beeb,
    page,
}) => {
    await catalogueOfOne(page);
    await beeb.open("?disc=bitshifters:bs-paradroid.ssd&autoboot");
    await expect(page).toHaveURL(/model=Master/);
    await expect(page).toHaveURL(/autoboot/);
    await expect(page.locator(".toast")).toContainText("Switched to a BBC Master 128 for Paradroid");
    expect(await page.evaluate(() => window.processor.model.isMaster)).toBe(true);
    await beeb.expectDrive0("bs-paradroid.ssd");
    await beeb.expectNotOnScreen("BASIC");
    await page.goBack();
    await expect(page).not.toHaveURL(/bitshifters/);
});

test("a link that boots a disc on the GitHub list comes up on the machine the list gives", async ({ beeb, page }) => {
    await page.route("https://raw.githubusercontent.com/mattgodbolt/nm/HEAD/ninja_music.ssd", (route) =>
        route.fulfill({ path: "public/discs/elite.ssd", contentType: "application/octet-stream" }),
    );
    await beeb.open("?disc=github:mattgodbolt/nm/ninja_music.ssd&autoboot");
    await expect(page).toHaveURL(/model=Master/);
    await expect(page.locator(".toast")).toContainText("Switched to a BBC Master 128 for Ninja Massacre music");
    expect(await page.evaluate(() => window.processor.model.isMaster)).toBe(true);
    await beeb.expectDrive0("ninja_music.ssd");
    await page.click("#navbarMedia");
    await page.click('#media-chips .media-chip[title^="Games and demos from their authors"]');
    await expect(page.locator("#media-list .media-row .media-source").first()).toHaveText("GitHub");
});

test("a program that writes to a VideoNuLA the machine lacks is told so, and Fit one restarts with one", async ({
    beeb,
    page,
}) => {
    const noted = [];
    page.on("console", (message) => noted.push(message.text()));
    await beeb.open(`?autotype=${encodeURIComponent("?&FE23=&0F:?&FE23=&00\n")}`);
    const notice = page.locator(".toast", { hasText: "VideoNuLA" });
    await expect(notice).toContainText("This program tried to use a VideoNuLA, which isn't fitted.");
    await notice.locator(".toast-action").click();
    await expect(page).toHaveURL(/hasVideoNula/);
    await beeb.expectScreenText("BASIC");
    expect(await page.evaluate(() => window.processor.video.ula.hasVideoNula)).toBe(true);
    await expect
        .poll(() => noted.filter((text) => text.startsWith("event noted: feature_used")))
        .toEqual([expect.stringContaining("action=missing"), expect.stringContaining("action=fitted")]);
    expect(beeb.problems).toEqual([]);
});
