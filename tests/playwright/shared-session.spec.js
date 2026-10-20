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

test("a guest joins a hosted session, and what either types reaches both machines", async ({ browser, beeb }) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-${crypto.randomUUID()}`;
    await beeb.open(`?server=${room}`);
    await beeb.expectScreenText("BASIC");
    // Before the guest joins, so its copy of the machine has it too.
    await beeb.disableAutoRepeat();

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    try {
        await guest.open(`?client=${room}`);
        await guest.expectScreenText("BASIC", JoinTimeoutMs);

        await typeLine(beeb, "PRINT 67-25");
        await guest.expectScreenText("42");
        await typeLine(guest, "PRINT 99-9");
        await beeb.expectScreenText("90");
        await guest.expectScreenText("90");
        await expect.poll(() => guest.screenText()).toBe(await beeb.screenText());
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});

test("a guest without the host's VideoNuLA reloads with one, joins and runs the same machine", async ({
    browser,
    beeb,
}) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-${crypto.randomUUID()}`;
    await beeb.open(`?server=${room}&hasVideoNula`);
    await beeb.expectScreenText("BASIC");
    await beeb.disableAutoRepeat();

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    try {
        await guest.open(`?client=${room}`);
        await expect
            .poll(() => new URL(guest.page.url()).searchParams.has("hasVideoNula"), { timeout: JoinTimeoutMs })
            .toBe(true);
        await guest.expectScreenText("BASIC", JoinTimeoutMs);

        await typeLine(beeb, "PRINT 50-8");
        await guest.expectScreenText("42");
        await expect.poll(() => guest.screenText()).toBe(await beeb.screenText());
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});

test("Shared session in the More menu hosts this machine, paused or not, and a guest joins by pasting the link, keeping its own audio latency", async ({
    browser,
    beeb,
}) => {
    test.setTimeout(SessionTestTimeoutMs);
    await beeb.open();
    await beeb.expectScreenText("BASIC");
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

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    try {
        await guest.open("?audioLatencyMs=80&fasttape");
        await guest.expectScreenText("BASIC");
        await openSessionDialog(guest);
        await guest.page.fill("#session-name", "tom");
        await guest.page.fill(".session-room", await link.textContent());
        await guest.page.click(".session-join");
        await expect(guest.page.locator("#session-pane .session-you")).toHaveText("You are tom", {
            timeout: JoinTimeoutMs,
        });
        const room = new URL(await link.textContent()).searchParams.get("client");
        expect(new URL(guest.page.url()).search).toBe(`?client=${room}&name=tom&audioLatencyMs=80`);
        await openSessionFromMore(guest);
        await expect(guest.page.locator("#session-pane")).toBeVisible({ timeout: JoinTimeoutMs });
        await expect(guest.page.locator("#session-pane .session-control")).toHaveText("In control: matt", {
            timeout: JoinTimeoutMs,
        });

        await typeLine(beeb, "PRINT A%");
        await guest.expectScreenText("4321");
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});

test("a paused machine that could not host stays paused, and Shared session offers the dialog again", async ({
    beeb,
}) => {
    await beeb.page.route("**/api/rendezvous/room/*", (route) =>
        route.request().method() === "POST"
            ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' })
            : route.continue(),
    );
    await beeb.open();
    await beeb.expectScreenText("BASIC");
    await beeb.page.click("#debug-pause");
    await beeb.expectHeld();
    await openSessionDialog(beeb);
    await beeb.page.click(".session-host");
    await expect(beeb.page.locator(".toast")).toContainText("The session couldn't start");
    await beeb.expectHeld();
    await expect(beeb.page.locator("#session-panel")).toBeHidden();
    await openSessionDialog(beeb);
    await expect(beeb.page.locator(".session-host")).toBeEnabled();
    const expected = (problem) => /status of 500|Rendezvous create room failed/.test(problem);
    expect(beeb.problems.filter(expected)).not.toEqual([]);
    beeb.problems = beeb.problems.filter((problem) => !expected(problem));
});

test("a guest takes control, both type, and the host takes it back", async ({ browser, beeb }) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-control-${crypto.randomUUID()}`;
    await beeb.open(`?server=${room}`);
    await beeb.expectScreenText("BASIC");
    await beeb.disableAutoRepeat();

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    const control = (page) => page.page.locator("#session-pane .session-control");
    try {
        await guest.open(`?client=${room}`);
        await guest.expectScreenText("BASIC", JoinTimeoutMs);

        await guest.page.locator("#session-pane .session-take").click();
        await expect(control(guest)).toHaveText("In control: you");
        await typeLine(guest, "PRINT 50-29");
        await beeb.expectScreenText("21");
        await typeLine(beeb, "PRINT 80-3");
        await guest.expectScreenText("77");
        await beeb.expectScreenText("77");

        await beeb.page.locator("#session-pane .session-take").click();
        await expect(control(beeb)).toHaveText("In control: you");
        await typeLine(guest, "PRINT 9-4");
        await beeb.expectScreenText(" 5");
        await guest.expectScreenText(" 5");
        await expect.poll(() => guest.screenText()).toBe(await beeb.screenText());
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
        expect(beeb.problems, "errors the host's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});

test("control passes between guests, and comes back to the host when the guest in control leaves", async ({
    browser,
    beeb,
}) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-handover-${crypto.randomUUID()}`;
    await beeb.open(`?server=${room}`);
    await beeb.expectScreenText("BASIC");
    await beeb.disableAutoRepeat();

    const contexts = [await browser.newContext(), await browser.newContext()];
    const [first, second] = await Promise.all(contexts.map(async (context) => new Beeb(await context.newPage())));
    const control = (page) => page.page.locator("#session-pane .session-control");
    try {
        await first.open(`?client=${room}`);
        await first.expectScreenText("BASIC", JoinTimeoutMs);
        await second.open(`?client=${room}`);
        await second.expectScreenText("BASIC", JoinTimeoutMs);

        await first.page.locator("#session-pane .session-take").click();
        await expect(control(first)).toHaveText("In control: you");
        await second.page.locator("#session-pane .session-take").click();
        await expect(control(second)).toHaveText("In control: you");
        await typeLine(first, "PRINT 60-18");
        await second.expectScreenText("42");
        await beeb.expectScreenText("42");

        await contexts[1].close();
        await expect(control(beeb)).toHaveText("In control: you", { timeout: JoinTimeoutMs });
        await typeLine(beeb, "PRINT 70-7");
        await first.expectScreenText("63");
        await expect.poll(() => first.screenText()).toBe(await beeb.screenText());
        expect(first.problems, "errors the first guest's page logged").toEqual([]);
        expect(beeb.problems, "errors the host's page logged").toEqual([]);
    } finally {
        await contexts[0].close();
    }
});
