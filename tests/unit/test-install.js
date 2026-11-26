// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "../../src/web/install.js";
import { teardownDom, toasts } from "./helpers.js";

const Reload = ".toast-action";
const PageBuild = "page-build";
const NewerBuild = "newer-build";

function fakeWorkerContainer(controlled) {
    const container = new EventTarget();
    container.controller = controlled ? {} : null;
    container.register = vi.fn(async () => container.registration);
    container.registration = Object.assign(new EventTarget(), {
        waiting: null,
        installing: null,
        update: vi.fn(async () => {}),
    });
    return container;
}

function fakeWorker(build) {
    return { postMessage: vi.fn((_, [port] = []) => port?.postMessage(build)) };
}

function fakePage({ protocol, serviceWorker }) {
    const navigator = serviceWorker ? { serviceWorker } : {};
    return { navigator, location: { protocol, reload: vi.fn() }, document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("the service worker", () => {
    beforeEach(() => {
        vi.stubEnv("PROD", true);
        vi.stubEnv("JSBEEB_COMMIT", PageBuild);
    });
    afterEach(teardownDom);

    describe("registration", () => {
        const registers = async ({ protocol, benchmark, prod, supported }) => {
            vi.stubEnv("PROD", prod);
            const serviceWorker = fakeWorkerContainer(false);
            registerServiceWorker(fakePage({ protocol, serviceWorker: supported ? serviceWorker : null }), {
                benchmark,
            });
            await settle();
            return serviceWorker.register.mock.calls;
        };
        const page = { protocol: "https:", benchmark: false, prod: true, supported: true };

        it.each([
            ["https", page],
            ["http (localhost)", { ...page, protocol: "http:" }],
        ])("happens on %s", async (_, options) => {
            expect(await registers(options)).toEqual([["service-worker.js"]]);
        });

        it.each([
            ["Electron's file: page", { ...page, protocol: "file:" }],
            ["a ?benchmark page", { ...page, benchmark: true }],
            ["a browser without service workers", { ...page, supported: false }],
            ["the dev server", { ...page, prod: false }],
        ])("is skipped for %s", async (_, options) => {
            expect(await registers(options)).toEqual([]);
        });

        it("logs a failed registration without throwing", async () => {
            const serviceWorker = fakeWorkerContainer(false);
            serviceWorker.register.mockRejectedValue(new Error("no"));
            const error = vi.spyOn(console, "error").mockImplementation(() => {});
            registerServiceWorker(fakePage({ protocol: "https:", serviceWorker }), { benchmark: false });
            await settle();
            expect(error).toHaveBeenCalledWith("Service worker registration failed:", expect.any(Error));
        });
    });

    describe("an update", () => {
        const start = (controlled, build = NewerBuild) => {
            const serviceWorker = fakeWorkerContainer(controlled);
            const page = fakePage({ protocol: "https:", serviceWorker });
            const { registration } = serviceWorker;
            const waiting = fakeWorker(build);
            return {
                serviceWorker,
                registration,
                waiting,
                page,
                begin: () => registerServiceWorker(page, { benchmark: false }),
            };
        };

        const installUpdate = async (registration, waiting) => {
            const installing = new EventTarget();
            registration.installing = installing;
            registration.dispatchEvent(new Event("updatefound"));
            registration.waiting = waiting;
            installing.dispatchEvent(new Event("statechange"));
            await settle();
        };

        describe.each([
            ["a newer build than the page", NewerBuild, true],
            ["the build the page already is", PageBuild, false],
        ])("waiting with %s", (_, build, offered) => {
            const verdict = offered ? "is offered" : "is not offered";
            it(`${verdict} when it installs while the page is open`, async () => {
                const { registration, waiting, begin } = start(true, build);
                begin();
                await settle();
                await installUpdate(registration, waiting);
                expect(toasts()).toHaveLength(offered ? 1 : 0);
            });

            it(`${verdict} when the page opens`, async () => {
                const { registration, waiting, begin } = start(true, build);
                registration.waiting = waiting;
                begin();
                await settle();
                expect(toasts()).toHaveLength(offered ? 1 : 0);
            });
        });

        it("is offered once, and switches and reloads only when the user clicks", async () => {
            const { serviceWorker, registration, waiting, page, begin } = start(true);
            begin();
            await settle();
            expect(toasts()).toEqual([]);

            await installUpdate(registration, waiting);
            await installUpdate(registration, waiting);
            expect(toasts()).toEqual(["Update A new version of jsbeeb is ready. Reload Stop telling me this"]);
            expect(waiting.postMessage).not.toHaveBeenCalledWith({ type: "SKIP_WAITING" });

            document.querySelector(Reload).click();
            expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
            expect(page.location.reload).not.toHaveBeenCalled();
            serviceWorker.dispatchEvent(new Event("controllerchange"));
            expect(page.location.reload).toHaveBeenCalledOnce();
        });

        it("just reloads when another tab has already switched over", async () => {
            const { registration, waiting, page, begin } = start(true);
            registration.waiting = waiting;
            begin();
            await settle();
            registration.waiting = null;
            document.querySelector(Reload).click();
            expect(page.location.reload).toHaveBeenCalledOnce();
        });

        it("is not offered for the first install, which has nothing to replace", async () => {
            const { registration, waiting, begin } = start(false);
            begin();
            await settle();
            await installUpdate(registration, waiting);
            expect(toasts()).toEqual([]);
        });

        it("is looked for when an installed window comes back into view", async () => {
            const { registration, begin } = start(true);
            begin();
            await settle();
            document.dispatchEvent(new Event("visibilitychange"));
            expect(registration.update).toHaveBeenCalledOnce();
        });
    });
});
