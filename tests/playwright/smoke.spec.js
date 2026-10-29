// What only the built page in a real browser can show: main.js constructing
// everything against the built bundle, Bootstrap layout at real widths, a
// real keystroke, WebGL and WebAudio. Each test gets a page of its own.
//
//   npm run test:e2e                        build, then run every check in the system Chrome
//   npx playwright test --project chrome    the same without the build
//   npx playwright test --project chromium  the browser Playwright ships (npx playwright install chromium)
//   npx playwright test -g settings         checks whose name matches
//   npx playwright show-trace test-results/**/trace.zip
//
// BASE_URL=http://localhost:5173/ points a run at a server that is already up.

import { readFileSync } from "node:fs";

import { expect, test } from "./fixtures.js";

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
const BasicOswrchCall = 0x8e33;
const Unnamed = 0x3000;
const OsScreenMode = 0x355;
// A field's rows are cleared at the flyback after the next field's, so the MODE 7 field the mode changed in is gone
// only after the frame count has gone up three times.
const FramesToClearModeSeven = 3;
const RgbBits = 0xffffff;
// [register, value, what the panel then says] for the system VIA: PCR with independent edges then outputs, ACR
// shifting out by T2 then counting pulses, and IC32's keyboard enable cleared, so port A selects a key.
const SysViaModeWrites = [
    [0xc, 0x66, "CB2 light pen: rising edge, independent"],
    [0xc, 0xee, "CB2 light pen: high output"],
    [0xb, 0x10, "SR out free-running by T2"],
    [0xb, 0x60, "T2 counts PB6 pulses"],
    [0x0, 0x03, "keys: port A"],
];
const DesktopPreload = readFileSync(new URL("../../src/app/preload.js", import.meta.url), "utf8");
// The desktop app's own preload, given a stand-in for the electron module so the page sees what it would there.
const DesktopPreloadScript = `((require) => { ${DesktopPreload} })(() => ({
    contextBridge: { exposeInMainWorld: (key, api) => (window[key] = api) },
    ipcRenderer: { on: () => {}, send: () => {} },
}));`;

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

test("the desktop app's page starts the machine with the page furniture its preload removes gone", async ({
    beeb,
    page,
}) => {
    await page.addInitScript(DesktopPreloadScript);
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#header-bar")).toHaveCount(0);
});

test("every label and lamp in the lights bar sits on one of its shared lines, and on a Mac its tooltips say ⌥ for Alt", async ({
    beeb,
    page,
}) => {
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
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    await beeb.open("?disc=elite.ssd&tape=Welcome.uef");
    await beeb.expectDrive0("elite.ssd");
    await expect(page.locator('#leds [title*="⌥T"]')).toHaveCount(2);
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

test("the debugger keeps its width whatever the line crediting the names says", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.evaluate((address) => window.processor.debugInstruction.add((pc) => pc === address), Oswrch);
    await beeb.pressKey("a");
    const credit = page.locator("#disassembly-panel .debug-symbols");
    const goTo = async (address) => {
        const box = page.locator("#goto-dis-addr-form .goto-addr");
        await box.fill(`$${address.toString(16)}`);
        await box.press("Enter");
    };
    // Both sets in, so neither arriving later can redraw the line under the checks.
    await goTo(BasicOswrchCall);
    await expect(credit).toContainText("MOS 1.20");
    await expect(credit).toContainText("BASIC II");
    const panelWidth = () =>
        page.locator("#disassembly-panel").evaluate((panel) => panel.getBoundingClientRect().width);
    const creditedWidth = await panelWidth();
    await credit.evaluate((line) => line.append(" · a set with a long title".repeat(20)));
    expect(await panelWidth()).toBe(creditedWidth);
    await goTo(Unnamed);
    await expect(credit).toHaveCSS("visibility", "hidden");
    expect(await panelWidth()).toBe(creditedWidth);
});

test("the no-audio-worklet warning fits a phone and a desktop, closes without taking the keyboard, and is back on reload", async ({
    beeb,
    page,
}) => {
    await page.addInitScript(() => delete BaseAudioContext.prototype.audioWorklet);
    const warning = page.locator("#audio-warning");
    const close = warning.locator(".btn-close");
    await beeb.open();
    await expect(warning).toContainText("No audio worklet API");
    for (const viewport of [
        { width: 390, height: 844 },
        { width: 1400, height: 900 },
    ]) {
        await page.setViewportSize(viewport);
        const layout = await page.evaluate(() => {
            const box = document.querySelector("#audio-warning .btn-close").getBoundingClientRect();
            return {
                closeOnScreen: box.left >= 0 && box.right <= innerWidth && box.top >= 0,
                scrollsSideways: document.documentElement.scrollWidth > innerWidth,
            };
        });
        expect(layout, `at ${viewport.width}x${viewport.height}`).toEqual({
            closeOnScreen: true,
            scrollsSideways: false,
        });
    }
    await page.evaluate(() => {
        window.focusedInWarning = false;
        document.addEventListener("focusin", (event) => {
            if (event.target.closest("#audio-warning")) window.focusedInWarning = true;
        });
    });
    await close.click();
    await expect(warning).toBeHidden();
    expect(await page.evaluate(() => window.focusedInWarning)).toBe(false);
    await page.reload();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("No audio worklet API");
});

const DebugPanels = ["#toolbar-panel", "#disassembly-panel", "#registers-panel", "#memory-panel", "#peripherals-panel"];
const boxesOf = (page, selectors) => Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("a fresh profile opens no floating panel on load", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    expect(await page.locator(".floating-panel:visible").count()).toBe(0);
});

test("Alt-S opens the debugger's panels beside the screen, g leaves them open and following the machine, and Alt-S closes them", async ({
    beeb,
    page,
}) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.keyboard.press("Alt+S");
    for (const panel of DebugPanels) await expect(page.locator(panel)).toBeVisible();
    await beeb.expectHeld();
    const screen = await page.locator("#screen").boundingBox();
    const boxes = await boxesOf(page, DebugPanels);
    // The right-hand gutter is narrower than a disassembly line, so only the left-hand column clears the screen.
    expect(
        (await boxesOf(page, ["#memory-panel", "#peripherals-panel"])).filter((box) => overlap(box, screen)),
    ).toEqual([]);
    expect(boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => overlap(a, b)))).toEqual([]);
    const current = page.locator("#disassembly .current");
    expect(await current.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
    const peripherals = page.locator("#peripherals-panel .panel-body");
    await peripherals.evaluate((body) => body.scrollTo(0, body.scrollHeight));
    await expect(page.locator("#crtc .crtc_regs tr:not(.template)").last()).toBeInViewport();

    const cycles = page.locator("#cpu6502_cycles");
    const stoppedAt = await cycles.textContent();
    await page.keyboard.press("g");
    await expect.poll(() => cycles.textContent()).not.toBe(stoppedAt);
    for (const panel of DebugPanels) await expect(page.locator(panel)).toBeVisible();
    await beeb.pressKey("j");
    await beeb.expectScreenText(">J");

    await page.keyboard.press("Alt+S");
    const held = await beeb.expectHeld();
    await page.keyboard.press("Alt+S");
    for (const panel of DebugPanels) await expect(page.locator(panel)).toBeHidden();
    await beeb.expectRunningPast(held);
});

test("on a window wide enough, the debugger's panels default to the gutters each side of the screen", async ({
    beeb,
    page,
}) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.keyboard.press("Alt+S");
    for (const panel of DebugPanels) await expect(page.locator(panel)).toBeVisible();
    const screen = await page.locator("#screen").boundingBox();
    expect((await boxesOf(page, DebugPanels)).filter((box) => overlap(box, screen))).toEqual([]);
});

test("Alt-D shows and hides the debugger's panels with the machine left running, and the Debug menu does too", async ({
    beeb,
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await beeb.open();
    await beeb.expectScreenText(">");
    const narrowSet = DebugPanels.slice(0, 4);
    await page.keyboard.press("Alt+D");
    for (const panel of narrowSet) await expect(page.locator(panel)).toBeVisible();
    await expect(page.locator("#peripherals-panel")).toBeHidden();
    const boxes = await boxesOf(page, narrowSet);
    expect(boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => overlap(a, b)))).toEqual([]);
    await beeb.expectRunningPast(await beeb.cycles());
    await page.keyboard.press("Alt+D");
    for (const panel of narrowSet) await expect(page.locator(panel)).toBeHidden();

    await beeb.togglePanel("memory");
    await expect(page.locator("#memory-panel")).toBeVisible();
    await expect(page.locator('#debug-menu [data-panel="memory"]')).toBeHidden();
    await beeb.pressKey("k");
    await beeb.expectScreenText(">K");
});

test("a panel's keys act only while the machine is stopped, and every other key still reaches the machine", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.disableAutoRepeat();
    await page.keyboard.press("Alt+D");
    const memoryAt = page.locator("#memory .highlight .dis_addr");
    await expect(memoryAt).toHaveText("0000");
    await beeb.pressKey("u");
    await beeb.expectScreenText(">U");
    await expect(memoryAt).toHaveText("0000");

    await page.keyboard.press("Alt+S");
    await beeb.expectHeld();
    await page.keyboard.press("u");
    await expect(memoryAt).toHaveText("0008");
    const disassemblyAt = page.locator("#disassembly .highlight .dis_addr");
    const before = await disassemblyAt.textContent();
    await page.keyboard.press("j");
    await expect(disassemblyAt).not.toHaveText(before);
    await beeb.expectHeld();
    await page.keyboard.press("g");
    await beeb.pressKey("x");
    await beeb.expectScreenText(">UX");
});

test("the system VIA panel opens from the Debug menu, keeps up with the running machine, leaves it the keyboard, and reopens on reload", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("sysvia");
    const panel = page.locator("#sysvia-panel");
    await expect(panel).toBeVisible();
    const register = (name) => panel.locator(`.decoded-registers tr:has(th:text-is("${name}"))`);
    const timer1 = register("T1C").locator(".decoded-hex");
    const shown = await timer1.textContent();
    await expect.poll(() => timer1.textContent()).not.toBe(shown);
    await expect(register("IC32").locator(".decoded-meaning")).toContainText("keys: autoscan");
    const keyA = panel.locator('.key-matrix td[title="a: column 1, row 4"]');
    await page.keyboard.down("a");
    await expect(keyA).toHaveClass(/held/);
    await page.keyboard.up("a");
    await expect(keyA).not.toHaveClass(/held/);
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(timer1).not.toBeEmpty();
});

test("the system VIA panel's content fits the size it opened at, and keeps its size as the machine runs, keys come and go, and its modes change", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("sysvia");
    await page.evaluate(() => {
        const body = document.querySelector("#sysvia-panel .panel-body");
        window.e2eSizes = new Set();
        window.e2eSampling = true;
        const sample = () => {
            const fits = body.scrollWidth <= body.clientWidth && body.scrollHeight <= body.clientHeight;
            window.e2eSizes.add(`${body.scrollWidth}x${body.scrollHeight}, fits: ${fits}`);
            if (window.e2eSampling) requestAnimationFrame(sample);
        };
        sample();
    });
    await beeb.pressKey("a");
    await beeb.pressKey("Enter");
    await page.click("#debug-pause");
    const shown = await page.evaluate(async (writes) => {
        const panel = document.getElementById("sysvia-panel");
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const seen = [];
        for (const [register, value, text] of writes) {
            window.processor.sysvia.write(register, value);
            // The panel redraws once the machine has moved on, which a cycle or two may not, past an instruction.
            window.processor.execute(16);
            await frame();
            await frame();
            if (panel.textContent.includes(text)) seen.push(text);
        }
        window.e2eSampling = false;
        return seen;
    }, SysViaModeWrites);
    expect(shown).toEqual(SysViaModeWrites.map(([, , text]) => text));
    expect(await page.evaluate(() => [...window.e2eSizes])).toEqual([expect.stringMatching(/fits: true$/)]);
});

test("the user VIA panel opens from the peripherals panel, names the printer and user port lines, and fits its content", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("peripherals");
    await page.click('#peripherals-panel [data-opens="uservia"]');
    const panel = page.locator("#uservia-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("CA2 printer strobe");
    await expect(panel).toContainText("CB1 user port");
    const fits = await panel
        .locator(".panel-body")
        .evaluate((body) => body.scrollWidth <= body.clientWidth && body.scrollHeight <= body.clientHeight);
    expect(fits).toBe(true);
    await page.click('#peripherals-panel [data-opens="uservia"]');
    await expect(panel).toBeHidden();
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
    await page.evaluate((address) => window.processor.debugInstruction.add((at) => at === address), Oswrch);
    await beeb.pressKey("a");
    await expect(stoppedAtOswrch).toHaveText(/^ffee /);
    const savedAt = await where();
    const download = page.waitForEvent("download");
    await page.locator("#save-state").dispatchEvent("click");
    const saved = await (await download).path();
    await page.click("#debug-play");
    await beeb.expectRunningPast(savedAt.cycles);

    // Each load starts with the machine running. The play button comes on as soon as the load holds the machine,
    // before the state is in, and the debugger's panels stay open from before; the machine arriving where it was
    // saved is what says it is in.
    const loadAndContinue = async () => {
        await page.setInputFiles("#load-state", saved);
        // A load from another model goes by way of a reload, which nothing can be asked across.
        const whereIfThere = async () => {
            try {
                return await where();
            } catch {
                return null;
            }
        };
        await expect.poll(whereIfThere).toEqual(savedAt);
        await expect(page.locator("#debug-play")).toBeEnabled();
        await expect(stoppedAtOswrch).toHaveText(/^ffee /);
        const loaded = await beeb.expectHeld();
        await page.click("#debug-play");
        await beeb.expectRunningPast(loaded);
        await expect.poll(pc).not.toBe(Oswrch);
    };

    await loadAndContinue();

    await beeb.open("?model=Master");
    await beeb.expectScreenText(">");
    await loadAndContinue();
});

test("Alt+M opens the media window with the search box focused, and while the window has the keyboard the machine gets none of it", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await page.keyboard.press("Alt+M");
    await expect(page.locator("#media-panel")).toBeVisible();
    await expect(page.locator("#media-search")).toBeFocused();
    await page.keyboard.type("welcome");
    await expect(page.locator("#media-search")).toHaveValue("welcome");
    await page.focus("#media-close");
    await beeb.expectKeyKept("a");
    await page.keyboard.press("Escape");
    await expect(page.locator("#media-panel")).toBeHidden();
    await beeb.pressKey("b");
    await beeb.expectScreenText(">B");
    expect(await beeb.screenText()).not.toMatch(/WELCOME|>AB/);
});

test("the media window fills a phone's screen without scrolling sideways, and its bays show one thing at a time", async ({
    beeb,
    page,
}) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await beeb.open("?disc=elite.ssd");
    await beeb.expectDrive0("elite.ssd");
    // The top bar is folded into its hamburger at this width; the touch keyboard's media button still opens it.
    await page.click("#touch-keyboard .tk-media");
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
            onTopAtTheBottom: panel.contains(document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 5)),
        };
    });
    expect(fit.rightEdge).toBeLessThanOrEqual(fit.innerWidth);
    expect(fit.width).toBe(fit.innerWidth);
    expect(fit.pageScrollsSideways).toBe(false);
    expect(fit.panelScrollsSideways).toBe(false);
    expect(fit.onTopAtTheBottom).toBe(true);

    // The archives' listing arriving redraws the bays from the drives, undoing a state forced on one before it.
    await expect(page.locator("#media-count")).not.toBeEmpty();
    const bay = (drive) => page.locator(`.bay[data-drive="${drive}"]`);
    const shown = async (drive) => ({
        note: await bay(drive).locator(".empty-note").isVisible(),
        jacket: await bay(drive).locator(".jacket").isVisible(),
    });
    await expect(bay(0)).toHaveAttribute("data-state", "loaded");
    expect(await shown(0)).toEqual({ note: false, jacket: true });
    await expect(bay(1)).toHaveAttribute("data-state", "empty");
    expect(await shown(1)).toEqual({ note: true, jacket: false });
    await bay(1).evaluate((element) => (element.dataset.state = "busy"));
    expect(await shown(1)).toEqual({ note: false, jacket: true });
});

test.describe("on a phone", () => {
    test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

    test("SHIFT+BREAK on the on-screen keyboard boots the disc with both thumbs lifted together", async ({
        beeb,
        page,
    }) => {
        await beeb.open("?disc=Welcome.ssd");
        await beeb.expectScreenText(">");
        const cdp = await page.context().newCDPSession(page);
        const touchPoint = async (label, id) => {
            const key = page.locator("#touch-keyboard .tk-key:visible", { hasText: new RegExp(`^${label}$`) });
            const box = await key.first().boundingBox();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2, id };
        };
        const shift = await touchPoint("SHIFT", 1);
        const breakKey = await touchPoint("BREAK", 2);
        const touch = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
        await touch("touchStart", [shift]);
        await touch("touchStart", [shift, breakKey]);
        await beeb.runFor(50);
        await touch("touchEnd", [breakKey]);
        await touch("touchEnd", []);
        await beeb.expectScreenText("automatically loaded");
    });

    test("the on-screen keyboard steps aside in landscape for the lights bar, and comes back as it was left, even after a reload", async ({
        beeb,
        page,
    }) => {
        const keyboard = page.locator("#touch-keyboard");
        const toggle = page.locator("#touch-keyboard-toggle");
        const lights = page.locator("#leds");
        const turn = (width, height) => page.setViewportSize({ width, height });
        await beeb.open();
        await expect(keyboard).toBeVisible();
        await expect(lights).toBeHidden();
        const monitor = await page.locator("#cub-monitor").boundingBox();
        expect(monitor.y + monitor.height).toBeLessThanOrEqual((await keyboard.boundingBox()).y);

        await turn(915, 412);
        await expect(keyboard).toBeHidden();
        await expect(toggle).toBeHidden();
        await expect(lights).toBeVisible();
        await turn(412, 915);
        await expect(keyboard).toBeVisible();

        await page.locator("#touch-keyboard .tk-hide").tap();
        await expect(lights).toBeVisible();
        await turn(915, 412);
        await expect(toggle).toBeHidden();
        await turn(412, 915);
        await expect(keyboard).toBeHidden();
        await expect(toggle).toBeVisible();
        await page.reload();
        await expect(toggle).toBeVisible();
        await expect(keyboard).toBeHidden();
    });

    test("a touch in the gap between keys presses the nearer one", async ({ beeb, page }) => {
        await beeb.open();
        await beeb.expectScreenText(">");
        const q = await page.locator("#touch-keyboard .tk-key:visible", { hasText: /^Q$/ }).boundingBox();
        await page.touchscreen.tap(q.x + q.width + 1, q.y + q.height / 2);
        await beeb.expectScreenText(">Q");
    });

    test("the on-screen keyboard presses nothing while the machine is stopped", async ({ beeb, page }) => {
        await beeb.open();
        await beeb.expectScreenText(">");
        await page.evaluate(() => document.getElementById("debug-pause").click());
        await beeb.expectHeld();
        await page.locator("#touch-keyboard .tk-key:visible", { hasText: /^A$/ }).tap();
        expect(await page.evaluate(() => window.processor.sysvia.hasAnyKeyDown())).toBe(false);
        await page.locator("#touch-keyboard .tk-key", { hasText: /^more$/ }).tap();
        await expect(page.locator('#touch-keyboard .tk-layer[data-name="more"]')).toBeVisible();
    });

    test("an embedded page has no on-screen keyboard", async ({ beeb, page }) => {
        await beeb.open("?embed");
        await beeb.expectScreenText(">");
        await expect(page.locator("#touch-keyboard, #touch-keyboard-toggle")).toHaveCount(0);
    });
});

test("help fits a desktop browser window whole, and on a phone or tablet scrolls under its own header", async ({
    beeb,
    page,
}) => {
    const helpLayout = async ({ width, height }) => {
        await page.setViewportSize({ width, height });
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
    const desktop = { width: 1920, height: 940 };
    await page.setViewportSize(desktop);
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.armModalShown("help");
    await page.evaluate(() => document.querySelector('a[data-bs-target="#help"]').click());
    await beeb.expectModalShown();
    expect(await helpLayout(desktop)).toEqual({
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

test("settings hold the emulator while open, a restart is asked about from inside their close, and a setting survives a reload", async ({
    beeb,
    page,
}) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#audio-output .active")).not.toHaveAttribute("data-output", "board");
    await beeb.armModalShown("configuration");
    await page.click('a[data-bs-target="#configuration"]');
    await expect(page.locator("#debug-pause")).toBeDisabled();
    await beeb.expectModalShown();
    await beeb.expectHeld();
    await page.click("#audioOutputDropdown");
    await page.click('#configuration .audio-output-option[data-output="board"]');
    await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", "board");
    await page.click("#bbc-model-dropdown");
    await page.click('#configuration .model-menu a[data-target="Master"]');
    await beeb.armModalShown("are-you-sure");
    await page.click("#configuration .btn-close");
    await beeb.expectModalShown();
    const held = await beeb.expectHeld();
    await page.click("#are-you-sure .ays-no");
    await expect(page.locator("#are-you-sure")).toBeHidden();
    await expect(page.locator("#configuration")).toBeHidden();
    await beeb.expectRunningPast(held);
    // Back to a bare URL: only browser storage can carry the setting across.
    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#audio-output .active")).toHaveAttribute("data-output", "board");
});

test("a panel dragged to the right edge stays on it as the window grows, returns unchanged after a shrink, and reopens there, and a resize keeps a panel's scroll", async ({
    beeb,
    page,
}) => {
    const box = async () => {
        const { x, y, width, height } = await page.locator("#watch-panel").boundingBox();
        return { x, y, width, height };
    };
    await page.setViewportSize({ width: 1280, height: 720 });
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("watches");
    const header = page.locator("#watch-panel .panel-title");
    const grab = await header.boundingBox();
    await page.mouse.move(grab.x + 5, grab.y + 5);
    await page.mouse.down();
    await page.mouse.move(1270, 360, { steps: 10 });
    await page.mouse.up();
    const onEdge = await box();
    expect(onEdge.x + onEdge.width).toBe(1280);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(async () => (await box()).x + onEdge.width).toBe(1920);
    await page.setViewportSize({ width: 700, height: 500 });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(box).toEqual(onEdge);

    await beeb.open();
    await beeb.expectScreenText(">");
    await expect(page.locator("#watch-panel")).toBeVisible();
    expect(await box()).toEqual(onEdge);

    for (const address of ["&70", "&71", "&72", "&73", "&74", "&75", "&76", "&77"]) {
        await page.fill("#watch-add", address);
        await page.press("#watch-add", "Enter");
    }
    const handle = await page.locator("#watch-panel .panel-resize-bottom").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 150, { steps: 10 });
    await page.mouse.up();
    const watchBody = page.locator("#watch-panel .panel-body");
    const scrolled = await watchBody.evaluate((body) => (body.scrollTop = body.scrollHeight - body.clientHeight));
    expect(scrolled).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1279, height: 720 });
    await expect.poll(() => watchBody.evaluate((body) => body.scrollTop)).toBe(scrolled);
});

test("a panel can be dragged into the bottom corner, over the lights, and up to the navbar", async ({ beeb, page }) => {
    const panel = page.locator("#watch-panel");
    const dragHeaderTo = async (x, y) => {
        const grab = await page.locator("#watch-panel .panel-title").boundingBox();
        await page.mouse.move(grab.x + 5, grab.y + 5);
        await page.mouse.down();
        await page.mouse.move(x, y, { steps: 10 });
        await page.mouse.up();
        return panel.boundingBox();
    };
    await page.setViewportSize({ width: 1280, height: 720 });
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("watches");
    const corner = await dragHeaderTo(1279, 719);
    expect(corner.x + corner.width).toBe(1280);
    expect(corner.y + corner.height).toBe(720);
    const lights = await page.locator("#leds").boundingBox();
    const overLights = await dragHeaderTo(20, 719);
    expect(overLights.x).toBe(0);
    expect(overLights.y + overLights.height).toBeGreaterThan(lights.y);
    const navbar = await page.locator("#header-bar").boundingBox();
    const top = await dragHeaderTo(640, 0);
    expect(top.y).toBe(navbar.y + navbar.height);
});

test("the disc surface fits its panel without scrolling, at the size it opens at and after a resize", async ({
    beeb,
    page,
}) => {
    const fit = () =>
        page.evaluate(() => {
            const body = document.querySelector("#disc-panel .panel-body");
            return {
                overflow: body.scrollHeight - body.clientHeight,
                disc: document.getElementById("disc-surface").getBoundingClientRect().width,
                statusLines: [...body.querySelectorAll(".disc-status")].map((line) => line.offsetHeight),
            };
        });
    // Shorter than the panel's natural height, so the disc has to give up height to fit.
    await page.setViewportSize({ width: 1280, height: 600 });
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("disc");
    const opened = await fit();
    expect(opened.overflow).toBeLessThanOrEqual(0);
    const handle = await page.locator("#disc-panel .panel-resize-bottom").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 120, { steps: 10 });
    await page.mouse.up();
    const shorter = await fit();
    expect(shorter.overflow).toBeLessThanOrEqual(0);
    expect(shorter.disc).toBeLessThan(opened.disc);
    expect(shorter.statusLines).toEqual(opened.statusLines);
});

test("the disc surface panel keeps its size as the hover readout comes and goes", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    await beeb.togglePanel("disc");
    const panel = page.locator("#disc-panel");
    const hoverText = page.locator("#disc-hover-what");
    const before = await panel.boundingBox();
    const surface = await page.locator("#disc-overlay").boundingBox();
    await page.mouse.move(surface.x + surface.width / 2, surface.y + 30);
    await expect(hoverText).not.toBeEmpty();
    expect(await panel.boundingBox()).toEqual(before);
    await page.mouse.move(100, 300);
    await expect(hoverText).toBeEmpty();
    expect(await panel.boundingBox()).toEqual(before);
});

test("every display mode on the bar can be picked", async ({ beeb, page }) => {
    await beeb.open();
    await beeb.expectScreenText(">");
    const modes = await page
        .locator("#display-mode [data-mode]")
        .evaluateAll((els) => els.map((el) => el.dataset.mode));
    expect(modes).not.toEqual([]);
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
    await beeb.expectScreenText(">");
});

test("a link that boots a disc from Bitshifters without naming a model comes up on the machine it needs", async ({
    beeb,
    page,
}) => {
    const served = "https://bitshifters.github.io/content/bs-paradroid.ssd";
    await page.route(served, (route) =>
        route.fulfill({ path: "public/discs/elite.ssd", contentType: "application/octet-stream" }),
    );
    await beeb.open("?disc=bitshifters:bs-paradroid.ssd&autoboot");
    await expect(page.locator(".toast")).toContainText("Switched to a BBC Master 128 for Paradroid");
    await expect(page).toHaveURL(/model=Master/);
    await expect(page).toHaveURL(/autoboot/);
    expect(await page.evaluate(() => window.processor.model.isMaster)).toBe(true);
    await beeb.expectDrive0("bs-paradroid.ssd");
    // The stand-in is Elite, whose loader refuses a Master: only a boot gets it to say so.
    await beeb.expectScreenText("This program is only suitable for a BBC Micro");
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
});

const drawnSoFar = (rgbBits) => {
    const { video } = window.processor;
    video.renderPending();
    return video.fb32.some((pixel) => (pixel & rgbBits) !== 0);
};

for (const [wasm, drain] of [
    ["on", "wasm"],
    ["switched off", "js"],
]) {
    test(`with WebAssembly ${wasm}, the bitmap modes are drawn by the ${drain} drain`, async ({ beeb, page }) => {
        if (drain === "js") await page.addInitScript(() => delete globalThis.WebAssembly);
        const logged = [];
        page.on("console", (message) => logged.push(message.text()));
        await beeb.open(`?autotype=${encodeURIComponent("MODE 1\n")}`);
        await expect.poll(() => page.evaluate((at) => window.processor?.readmem(at), OsScreenMode)).toBe(1);
        const modeSetFrame = await page.evaluate(() => window.processor.video.frameCount);
        await expect
            .poll(() => page.evaluate(() => window.processor.video.frameCount))
            .toBeGreaterThanOrEqual(modeSetFrame + FramesToClearModeSeven);
        expect(await page.evaluate(() => window.processor.video.drain.kind)).toBe(drain);
        await expect.poll(() => page.evaluate(drawnSoFar, RgbBits)).toBe(true);
        expect(logged.some((text) => text.includes("video drain falls back to JavaScript"))).toBe(drain === "js");
    });

    test(`with WebAssembly ${wasm}, the MODE 7 boot screen is painted by the ${drain} drain`, async ({
        beeb,
        page,
    }) => {
        if (drain === "js") await page.addInitScript(() => delete globalThis.WebAssembly);
        await beeb.open();
        await beeb.expectScreenText("BASIC");
        expect(await page.evaluate(() => window.processor.video.drain.kind)).toBe(drain);
        await expect.poll(() => page.evaluate(drawnSoFar, RgbBits)).toBe(true);
    });
}
