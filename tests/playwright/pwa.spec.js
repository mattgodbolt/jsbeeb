// The installable app: the manifest Chrome reads, the worker it installs, and the page coming back with no network.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { preview } from "vite";

import { expect, test } from "./fixtures.js";

const RomsDir = fileURLToPath(new URL("../../public/roms/", import.meta.url));
const BuiltWorker = new URL("../../dist/service-worker.js", import.meta.url);
const WaitingPollMs = 50;

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
        .map((entry) => `roms/${relative(RomsDir, join(entry.parentPath, entry.name))}`);
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

// The browser fetches a worker script itself, out of reach of a route, so a deploy is a server serving a different
// one. Headless Chrome never runs an update() called from the jsbeeb page, so a second, empty tab asks for it.
test("offers an update only when the worker is a newer build than the page", async ({ beeb, page, context }) => {
    let deployed = (worker) => worker;
    const server = await preview({
        preview: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "deployed-worker",
                configurePreviewServer(server) {
                    server.middlewares.use("/service-worker.js", (_, response) => {
                        response.setHeader("Content-Type", "text/javascript");
                        response.end(deployed(readFileSync(BuiltWorker, "utf8")));
                    });
                    server.middlewares.use("/deployer", (_, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end("<!doctype html>");
                    });
                },
            },
        ],
    });
    try {
        const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
        // Counts the page's build checks once each has finished, so a missing notice is not just a late one. Only
        // a worker's answer is a string.
        await page.addInitScript(() => {
            window.buildChecks = 0;
            const { get, set } = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
            Object.defineProperty(MessagePort.prototype, "onmessage", {
                get,
                set(handler) {
                    set.call(this, (event) => {
                        handler(event);
                        if (typeof event.data === "string") setTimeout(() => window.buildChecks++);
                    });
                },
            });
        });
        const buildChecksDone = () =>
            expect.poll(() => page.evaluate(() => window.buildChecks), { message: "the page's build check" });
        await beeb.routed;
        await page.goto(origin);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload();
        const deployer = await context.newPage();
        await deployer.goto(`${origin}deployer`);

        const askBuild = (which) =>
            deployer.evaluate(async (which) => {
                const worker = (await navigator.serviceWorker.ready)[which];
                const channel = new MessageChannel();
                const build = new Promise((resolve) => (channel.port1.onmessage = ({ data }) => resolve(data)));
                worker.postMessage({ type: "WHICH_BUILD" }, [channel.port2]);
                return build;
            }, which);
        const deploy = async (rewrite) => {
            deployed = rewrite;
            await deployer.evaluate(async (pollMs) => {
                const registration = await navigator.serviceWorker.ready;
                await registration.update();
                while (!registration.waiting) await new Promise((resolve) => setTimeout(resolve, pollMs));
            }, WaitingPollMs);
        };
        const update = page.locator(".toast", { hasText: "A new version of jsbeeb is ready." });

        const pageBuild = await askBuild("active");
        expect(pageBuild).toMatch(/^[0-9a-f]{7,}/);
        await deploy((worker) => `${worker}\n;`);
        expect(await askBuild("waiting")).toBe(pageBuild);
        await buildChecksDone().toBeGreaterThan(0);
        await expect(update).toHaveCount(0);
        await page.reload();
        await buildChecksDone().toBeGreaterThan(0);
        await expect(update).toHaveCount(0);

        await deploy((worker) => worker.replaceAll(pageBuild, `${pageBuild}-newer`));
        await expect(update).toBeVisible();
    } finally {
        await server.close();
    }
});
