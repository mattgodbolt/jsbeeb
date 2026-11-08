// The installable app: the manifest Chrome reads, the worker it installs, and the page coming back with no network.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "./fixtures.js";

const RomsDir = fileURLToPath(new URL("../../public/roms/", import.meta.url));

test.use({ withServiceWorker: true });

test("installs a worker that holds every ROM, and reloads with no network", async ({ beeb, page, context }) => {
    await beeb.open();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    const cached = await page.evaluate(async () => {
        const urls = [];
        for (const name of await caches.keys())
            for (const request of await (await caches.open(name)).keys())
                urls.push(new URL(request.url).pathname.replace(/^\//, ""));
        return urls;
    });
    const roms = readdirSync(RomsDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map(
            (entry) =>
                `roms/${entry.parentPath.slice(RomsDir.length)}${entry.parentPath === RomsDir ? "" : "/"}${entry.name}`,
        );
    expect(roms.length).toBeGreaterThan(0);
    expect(cached).toEqual(expect.arrayContaining(roms));

    const session = await context.newCDPSession(page);
    const { installabilityErrors } = await session.send("Page.getInstallabilityErrors");
    // A test's context is always incognito, which Chrome will not install from.
    expect(installabilityErrors.filter(({ errorId }) => errorId !== "in-incognito")).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await beeb.expectScreenText("BBC Computer");
});
