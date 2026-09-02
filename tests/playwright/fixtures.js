import { expect, test as base } from "@playwright/test";

const ScreenBase = 0x7c00;
const ScreenBytes = 1000;
const BootTimeoutMs = 30000;
const KeyHoldMs = 120;

/** The page with jsbeeb on it, reached through the console surface main.js exposes. */
class Beeb {
    constructor(page) {
        this.page = page;
        this.problems = [];
        page.on("pageerror", (error) => this.problems.push(`exception: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") this.problems.push(`console error: ${message.text()}`);
        });
    }

    open(query = "") {
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

    async expectNotOnScreen(text, timeout = BootTimeoutMs) {
        await expect
            .poll(() => this.screenText(), { message: `"${text}" to leave the screen`, timeout })
            .not.toContain(text);
    }

    // currentCycles wraps every emulated second; the seconds term keeps this monotonic.
    cycles() {
        return this.page.evaluate(
            () =>
                window.processor.cycleSeconds * window.processor.model.cyclesPerSecond + window.processor.currentCycles,
        );
    }

    /** Checks the emulator stays where it is for a while, and returns where that is. */
    async expectHeld(ms = 300) {
        const before = await this.cycles();
        await this.page.waitForTimeout(ms);
        expect(await this.cycles(), "cycles run while the emulator should be stopped").toBe(before);
        return before;
    }

    async expectRunningPast(cycles) {
        await expect.poll(() => this.cycles(), { message: "the emulator to run again" }).toBeGreaterThan(cycles);
    }

    /** Held long enough for the OS to scan the matrix and see it down. */
    async pressKey(key) {
        await this.page.keyboard.down(key);
        await this.page.waitForTimeout(KeyHoldMs);
        await this.page.keyboard.up(key);
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
     * dangling evaluate to muddy the report.
     */
    armModalShown(id) {
        return this.page.evaluate((modalId) => {
            window.e2eModalShown = false;
            document.getElementById(modalId).addEventListener(
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
            .poll(() => this.page.evaluate(() => window.e2eModalShown), { message: "the modal to finish appearing" })
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
