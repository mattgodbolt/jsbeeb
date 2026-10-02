import { expect, test, Beeb } from "./fixtures.js";

const JoinTimeoutMs = 45000;
const SessionTestTimeoutMs = 120000;

async function type(beeb, keys) {
    for (const key of keys) await beeb.pressKey(key);
}

test("a guest joins a hosted session, and what either types reaches both machines", async ({ browser, beeb }) => {
    test.setTimeout(SessionTestTimeoutMs);
    const room = `e2e-${Date.now()}`;
    await beeb.open(`?server=${room}`);
    await beeb.expectScreenText("BASIC");

    const guestContext = await browser.newContext();
    const guest = new Beeb(await guestContext.newPage());
    try {
        await guest.open(`?client=${room}`);
        await guest.expectScreenText("BASIC", JoinTimeoutMs);

        await type(beeb, ["P", "R", "I", "N", "T", " ", "6", "7", "-", "2", "5", "Enter"]);
        await guest.expectScreenText("42");
        await type(guest, ["P", "R", "I", "N", "T", " ", "9", "9", "-", "9", "Enter"]);
        await beeb.expectScreenText("90");
        await guest.expectScreenText("90");
        await expect.poll(() => guest.screenText()).toBe(await beeb.screenText());
        expect(guest.problems, "errors the guest's page logged").toEqual([]);
    } finally {
        await guestContext.close();
    }
});
