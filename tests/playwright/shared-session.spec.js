import { expect, test, Beeb } from "./fixtures.js";

const JoinTimeoutMs = 45000;
const SessionTestTimeoutMs = 120000;

async function openSessionFromMore(beeb) {
    await beeb.page.click("#navbarMore");
    await beeb.page.click("#session-open");
}

// Start hosting answers only once the dialog has finished appearing.
async function openSessionDialog(beeb) {
    await beeb.armModalShown("session-dialog");
    await openSessionFromMore(beeb);
    await beeb.expectModalShown();
}

async function typeLine(beeb, text) {
    for (const key of [...text, "Enter"]) await beeb.pressKey(key);
}

// The one test over real WebRTC and the real rendezvous; what the session does once connected is
// tests/integration/shared-session.js's.
test("a paused machine hosts from the More menu, and a guest joins by the pasted link as the host's machine, keeping its own settings, and what either types reaches both", async ({
    browser,
    beeb,
}) => {
    test.setTimeout(SessionTestTimeoutMs);
    await beeb.open("?hasVideoNula");
    await beeb.expectScreenText("BASIC");
    // Before the guest joins, so its copy of the machine has it too.
    await beeb.disableAutoRepeat();
    await typeLine(beeb, "A%=4321");
    const hostUrl = beeb.page.url();
    await beeb.page.click("#debug-pause");
    const pausedAt = await beeb.expectHeld();
    await openSessionDialog(beeb);
    await beeb.page.fill("#session-name", "matt");
    await beeb.page.click(".session-host");
    const link = beeb.page.locator("#session-pane .session-link");
    await expect(link).toHaveText(/\?client=[a-z]+-[a-z]+-[a-z]+$/);
    expect(beeb.page.url()).toBe(hostUrl);
    await beeb.expectRunningPast(pausedAt);
    const room = new URL(await link.textContent()).searchParams.get("client");

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    try {
        await guest.open("?audioLatencyMs=80&fasttape");
        await guest.expectScreenText("BASIC");
        await openSessionDialog(guest);
        await guest.page.fill("#session-name", "tom");
        await guest.page.fill(".session-room", await link.textContent());
        await guest.page.click(".session-join");
        await expect
            .poll(() => new URL(guest.page.url()).searchParams.has("hasVideoNula"), { timeout: JoinTimeoutMs })
            .toBe(true);
        const params = Object.fromEntries(new URL(guest.page.url()).searchParams);
        expect(params).toEqual({
            client: room,
            name: "tom",
            audioLatencyMs: "80",
            model: "BBC B with 8271 (DFS 1.2)",
            tubeCpuMultiplier: "1",
            hasVideoNula: "",
        });
        await expect(guest.page.locator("#session-pane .session-you")).toHaveText("You are tom", {
            timeout: JoinTimeoutMs,
        });
        await guest.expectScreenText("BASIC", JoinTimeoutMs);
        await openSessionFromMore(guest);
        await expect(guest.page.locator("#session-pane")).toBeVisible({ timeout: JoinTimeoutMs });
        await expect(guest.page.locator("#session-pane .session-control")).toHaveText("In control: matt", {
            timeout: JoinTimeoutMs,
        });

        await typeLine(beeb, "PRINT A%");
        await guest.expectScreenText("4321");
        await typeLine(guest, "PRINT 99-9");
        await beeb.expectScreenText("90");
        await guest.expectScreenText("90");
        await expect.poll(() => guest.screenText()).toBe(await beeb.screenText());
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});
