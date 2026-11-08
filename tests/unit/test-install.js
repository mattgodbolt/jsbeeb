// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "../../src/web/install.js";
import { teardownDom, toasts } from "./helpers.js";

const Reload = ".toast-action";

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

function fakePage({ protocol, serviceWorker }) {
    const navigator = serviceWorker ? { serviceWorker } : {};
    return { navigator, location: { protocol, reload: vi.fn() }, document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("the service worker", () => {
    beforeEach(() => {
        vi.stubEnv("PROD", true);
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
        const start = (controlled) => {
            const serviceWorker = fakeWorkerContainer(controlled);
            const page = fakePage({ protocol: "https:", serviceWorker });
            const { registration } = serviceWorker;
            const waiting = { postMessage: vi.fn() };
            return {
                serviceWorker,
                registration,
                waiting,
                page,
                begin: () => registerServiceWorker(page, { benchmark: false }),
            };
        };

        const installUpdate = (registration, waiting) => {
            const installing = new EventTarget();
            registration.installing = installing;
            registration.dispatchEvent(new Event("updatefound"));
            registration.waiting = waiting;
            installing.dispatchEvent(new Event("statechange"));
        };

        it("is offered once, and switches and reloads only when the user clicks", async () => {
            const { serviceWorker, registration, waiting, page, begin } = start(true);
            begin();
            await settle();
            expect(toasts()).toEqual([]);

            installUpdate(registration, waiting);
            installUpdate(registration, waiting);
            expect(toasts()).toEqual(["Update A new version of jsbeeb is ready. Reload Stop telling me this"]);
            expect(waiting.postMessage).not.toHaveBeenCalled();

            document.querySelector(Reload).click();
            expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
            expect(page.location.reload).not.toHaveBeenCalled();
            serviceWorker.dispatchEvent(new Event("controllerchange"));
            expect(page.location.reload).toHaveBeenCalledOnce();
        });

        it("just reloads when another tab has already switched over", () => {
            const { registration, waiting, page, begin } = start(true);
            registration.waiting = waiting;
            begin();
            return settle().then(() => {
                registration.waiting = null;
                document.querySelector(Reload).click();
                expect(page.location.reload).toHaveBeenCalledOnce();
            });
        });

        it("is offered at once when the page opens with one already waiting", async () => {
            const { registration, waiting, begin } = start(true);
            registration.waiting = waiting;
            begin();
            await settle();
            expect(toasts()).toHaveLength(1);
        });

        it("is not offered for the first install, which has nothing to replace", async () => {
            const { registration, waiting, begin } = start(false);
            begin();
            await settle();
            installUpdate(registration, waiting);
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
