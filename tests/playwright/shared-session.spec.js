import { expect, test, Beeb } from "./fixtures.js";

const JoinTimeoutMs = 45000;
const SessionTestTimeoutMs = 120000;

async function typeLine(beeb, text) {
    for (const key of [...text, "Enter"]) await beeb.pressKey(key);
}

test("a guest joins a hosted session, and what either types reaches both machines", async ({ browser, beeb }) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-${Date.now()}`;
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

test("a guest takes control, both type, and the host takes it back", async ({ browser, beeb }) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-control-${Date.now()}`;
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
    const room = `e2e-handover-${Date.now()}`;
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
