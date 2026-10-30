// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionPage } from "../../src/web/session-page.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { captureDownloads, domFromIndexHtml, teardownDom, toasts } from "./helpers.js";

describe("sessionPage", () => {
    const link = () => `${window.location.origin}/?client=room`;
    const pageWithPanels = () => sessionPage(undefined, new PanelArrangement(() => window.localStorage));
    const session = {
        name: "matt",
        room: "room",
        report: () => ({ role: "host", room: "room", savedAt: "2026-10-20T12:00:00.000Z" }),
        requestControl: vi.fn(),
    };

    beforeEach(() => {
        domFromIndexHtml("leds", "session-pane");
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
        delete navigator.clipboard;
        await teardownDom();
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve));
    const click = (selector) => document.querySelector(`#session-pane ${selector}`).click();

    it("shows the link to join in the pane and copies it, whatever the page's own URL holds", async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        window.history.replaceState(null, "", "/?server=room&model=Master#frag");
        pageWithPanels().panel(session).open();
        expect(document.querySelector("#session-pane .session-link").textContent).toBe(link());
        expect(document.querySelector("#session-pane .session-you").textContent).toBe("You are matt");
        click(".session-copy-link");
        await settle();
        expect(writeText).toHaveBeenCalledWith(link());
        expect(toasts().at(-1)).toContain("The link to join is on the clipboard.");
    });

    it("gives the link in full where there is no clipboard to copy it to", async () => {
        pageWithPanels().panel(session);
        click(".session-copy-link");
        await settle();
        expect(toasts().at(-1)).toContain(`Copying needs https. Guests join at ${link()}`);
    });

    it("gives the link in full when the clipboard refuses it", async () => {
        const writeText = vi.fn(async () => {
            throw new Error("not allowed");
        });
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        pageWithPanels().panel(session);
        click(".session-copy-link");
        await settle();
        expect(toasts().at(-1)).toContain(`Couldn't copy the link (not allowed). Guests join at ${link()}`);
    });

    it("saves the session's report, and asks for control for this page", async () => {
        const downloads = captureDownloads();
        pageWithPanels().panel(session);
        click(".session-report");
        const report = JSON.parse(await downloads()[0].blob.text());
        expect(report).toMatchObject({ role: "host", room: "room" });
        click(".session-take");
        expect(session.requestControl).toHaveBeenCalledWith(null);
    });

    it("reloads in place as another machine, by the page's own URL builder", () => {
        const urlWith = vi.fn(() => `${window.location.href}#reloaded`);
        const entries = window.history.length;
        sessionPage({ urlWith }).reloadAs({ model: "BBC Master 128 (DFS)" });
        expect(urlWith).toHaveBeenCalledWith(expect.objectContaining({ model: "BBC Master 128 (DFS)" }));
        expect(window.history.length).toBe(entries);
    });

    it("hears the page going until told to stop", () => {
        const listener = vi.fn();
        const listening = new AbortController();
        pageWithPanels().onPageHide(listener, listening.signal);
        window.dispatchEvent(new Event("pagehide"));
        listening.abort();
        window.dispatchEvent(new Event("pagehide"));
        expect(listener).toHaveBeenCalledOnce();
    });
});
