import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test as base } from "@playwright/test";

const ScreenBase = 0x7c00;
const ScreenBytes = 1000;
const BootTimeoutMs = 30000;
// The OS scans the keyboard every 10 ms and can miss a press or a release shorter than two scans.
const KeyScansEmulatedMs = 40;
const HeldFrames = 10;
// OSBYTE &C4's variable, which *FX11 sets; zero turns auto-repeat off.
const AutoRepeatDelayAddress = 0x254;
// currentCycles wraps every emulated second; the seconds term keeps this monotonic.
const EmulatedCycles =
    "(window.processor.cycleSeconds * window.processor.model.cyclesPerSecond + window.processor.currentCycles)";
const MachineStopped = 'document.getElementById("debug-pause").disabled';
const AnyKeyDown = "window.processor.sysvia.hasAnyKeyDown()";
const LoopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
// test:e2e builds with a dummy measurement id; an empty gtag.js leaves the stub's dataLayer for the tests to read.
// Without the fonts stylesheet the page is laid out in the fallback font, the same on every run.
const EmptyResponses = [
    { host: /^www\.googletagmanager\.com$/, contentType: "text/javascript" },
    { host: /^fonts\.googleapis\.com$/, contentType: "text/css" },
];
// Stand-ins for the other sites the page fetches from, as <host>/<path>.
const OfflineDir = fileURLToPath(new URL("offline/", import.meta.url));

/** The page with jsbeeb on it, reached through the console surface main.js exposes. */
export class Beeb {
    constructor(page) {
        this.page = page;
        this.problems = [];
        this.routed = Promise.all([
            page.route(
                (url) => !LoopbackHosts.includes(url.hostname),
                (route) => this._serveOffline(route),
            ),
            // Keeps the STUN request off the network; peers in one browser connect by their host addresses.
            page.addInitScript(() => {
                const Native = window.RTCPeerConnection;
                window.RTCPeerConnection = class extends Native {
                    constructor(config) {
                        super({ ...config, iceServers: [] });
                    }
                };
            }),
        ]);
        page.on("pageerror", (error) => this.problems.push(`exception: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") this.problems.push(`console error: ${message.text()}`);
        });
    }

    _serveOffline(route) {
        const url = new URL(route.request().url());
        const empty = EmptyResponses.find(({ host }) => host.test(url.hostname));
        if (empty) return route.fulfill({ contentType: empty.contentType, body: "" });
        const standIn = `${OfflineDir}${url.hostname}${url.pathname}`;
        if (existsSync(standIn)) return route.fulfill({ path: standIn });
        this.problems.push(`unrouted request: ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
    }

    async open(query = "") {
        await this.routed;
        return this.page.goto(query || "./");
    }

    /** Mode 7 screen memory as text, which is what the machine shows at the prompt. */
    screenText() {
        return this.page.evaluate(
            ([base, bytes]) => {
                const cpu = window.processor;
                if (!cpu) return "";
                return Array.from({ length: bytes }, (_, i) => String.fromCharCode(cpu.readmem(base + i) & 0x7f)).join(
                    "",
                );
            },
            [ScreenBase, ScreenBytes],
        );
    }

    async expectScreenText(text, timeout = BootTimeoutMs) {
        await expect.poll(() => this.screenText(), { message: `"${text}" on the screen`, timeout }).toContain(text);
    }

    cycles() {
        return this.page.evaluate(EmulatedCycles);
    }

    /** Until the machine has run for `ms` of its own time, or stopped. */
    async runFor(ms) {
        const until = await this.page.evaluate(
            `${EmulatedCycles} + window.processor.model.cyclesPerSecond * ${ms / 1000}`,
        );
        await this.page.waitForFunction(`${EmulatedCycles} >= ${until} || ${MachineStopped}`);
    }

    /** Checks the emulator stays where it is over frames it would have run in, and returns where that is. */
    async expectHeld() {
        const before = await this.cycles();
        await this.page.evaluate(async (frames) => {
            for (let i = 0; i < frames; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
        }, HeldFrames);
        expect(await this.cycles(), "cycles run while the emulator should be stopped").toBe(before);
        return before;
    }

    async expectRunningPast(cycles, timeout = undefined) {
        await expect
            .poll(() => this.cycles(), { message: "the emulator to run again", timeout })
            .toBeGreaterThan(cycles);
    }

    /**
     * Held, then let go, long enough for the OS's scans of the matrix to see both. Timed from when this page's own
     * matrix changes: in a shared session a key reaches every machine at the cycle the one running the session
     * applied it, so that is the clock the hold is measured on. The hold has no ceiling, since the machine runs on
     * until the release arrives, so auto-repeat is turned off first or a slow browser types the key twice.
     */
    async pressKey(key) {
        await this.page.evaluate((address) => window.processor.writemem(address, 0), AutoRepeatDelayAddress);
        await this.page.keyboard.down(key);
        await this._keyScans(true);
        await this.page.keyboard.up(key);
        await this._keyScans(false);
    }

    async _keyScans(down) {
        await this.page.waitForFunction(`${AnyKeyDown} === ${down} || ${MachineStopped}`);
        await this.runFor(KeyScansEmulatedMs);
    }

    /** Pressed, and checked not to reach the machine. */
    async expectKeyKept(key) {
        await this.page.keyboard.down(key);
        await this.runFor(KeyScansEmulatedMs);
        expect(await this.page.evaluate(AnyKeyDown), `${key} reaching the machine`).toBe(false);
        await this.page.keyboard.up(key);
    }

    /** Opens or closes a panel from the Debug menu, by its id in the panel layout. */
    async togglePanel(id) {
        await this.page.click("#navbarDebug");
        await this.page.click(`#debug-menu [data-panel="${id}"]`);
    }

    drive0() {
        return this.page.evaluate(() => window.processor.fdc.drives[0].disc?.name ?? null);
    }

    async expectDrive0(name, timeout = BootTimeoutMs) {
        await expect.poll(() => this.drive0(), { message: `${name} to be in drive 0`, timeout }).toBe(name);
    }

    /**
     * Bootstrap ignores a hide while its show transition is still running, and
     * says when that is over. Arm before the click that opens the modal, then
     * expect after it; a flag and a poll, so a failure mid-test leaves no
     * dangling evaluate to muddy the report. Bootstrap's shown event can come
     * from a fallback timer while the dialog is still sliding in, so the poll
     * also waits for the modal's transitions to end.
     */
    armModalShown(id) {
        return this.page.evaluate((modalId) => {
            window.e2eModal = document.getElementById(modalId);
            window.e2eModalShown = false;
            window.e2eModal.addEventListener(
                "shown.bs.modal",
                () => {
                    window.e2eModalShown = true;
                },
                { once: true },
            );
        }, id);
    }

    async expectModalShown() {
        await expect
            .poll(
                () =>
                    this.page.evaluate(
                        () => window.e2eModalShown && window.e2eModal.getAnimations({ subtree: true }).length === 0,
                    ),
                { message: "the modal to finish appearing" },
            )
            .toBe(true);
    }
}

export const test = base.extend({
    beeb: async ({ page }, use) => {
        const beeb = new Beeb(page);
        await use(beeb);
        expect(beeb.problems, "errors the page logged").toEqual([]);
    },
});

export { expect };
