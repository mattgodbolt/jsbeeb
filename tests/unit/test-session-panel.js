// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaggingMs, peerState, SessionPanel, SilentMs } from "../../src/web/session-panel.js";
import { domFromIndexHtml } from "./helpers.js";

describe("peerState", () => {
    const keepingUp = { lagMs: 60, commits: 60 };

    it.each([
        ["left", { left: true, connected: true }],
        ["connecting", { connected: false }],
        ["connecting", { connected: true }],
        ["ok", { connected: true, stats: keepingUp, statsAgeMs: 0 }],
        ["silent", { connected: true, stats: keepingUp, statsAgeMs: SilentMs }],
        ["silent", { connected: true, stats: { ...keepingUp, commits: 0 }, statsAgeMs: 0 }],
        ["lagging", { connected: true, stats: { ...keepingUp, lagMs: LaggingMs + 1 }, statsAgeMs: 0 }],
        ["ok", { connected: true, stats: { ...keepingUp, catchingUp: 1 }, statsAgeMs: 0 }],
        ["lagging", { connected: true, stats: { ...keepingUp, starved: 10 }, statsAgeMs: 0 }],
        ["ok", { connected: true, stats: { ...keepingUp, starved: 1 }, statsAgeMs: 0 }],
    ])("is %s for %o", (state, peer) => {
        expect(peerState(peer)).toBe(state);
    });
});

describe("SessionPanel", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        vi.restoreAllMocks();
    });

    const session = (overrides = {}) => ({
        name: "neat-dolls-occur",
        link: "https://bbc.xania.org/?client=scorch",
        saveReport: () => {},
        copyLink: () => {},
        ...overrides,
    });

    function page() {
        domFromIndexHtml("leds", "session-pane");
        return { readout: document.getElementById("session-panel"), pane: document.getElementById("session-pane") };
    }

    const rows = (pane) =>
        [...pane.querySelectorAll(".session-people tbody tr")].map((row) =>
            [...row.cells].slice(1).map((each) => each.textContent),
        );

    it("shows a light in the readout and a row in the pane for each peer, replacing the last ones", () => {
        const { readout, pane } = page();
        const panel = new SessionPanel(session());
        panel.show("hosting", "1 guest", [{ label: "Guest 1", state: "connecting" }]);
        panel.show("hosting", "2 guests", [
            { label: "Guest 1", state: "ok", rttMs: 84.6, lagMs: 40 },
            { label: "Guest 2", state: "left", leftReason: "it said goodbye" },
        ]);
        expect(readout.hidden).toBe(false);
        expect(readout.querySelector(".session-summary").textContent).toBe("2 guests");
        const lights = [...readout.querySelectorAll(".led")];
        expect(lights.map((light) => light.dataset.state)).toEqual(["ok", "left"]);
        expect(lights.every((light) => light.classList.contains("on"))).toBe(true);
        expect(rows(pane)).toEqual([
            ["Guest 1", "keeping up", "85 ms", "40 ms"],
            ["Guest 2", "left: it said goodbye", "", ""],
        ]);
    });

    it("opens the pane from the readout, with who you are and the link to join", () => {
        const { readout, pane } = page();
        new SessionPanel(session());
        const button = readout.querySelector(".slot-readout");
        expect(pane.hidden).toBe(true);
        button.click();
        expect(pane.hidden).toBe(false);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(pane.querySelector(".session-you").textContent).toBe("You are neat-dolls-occur");
        expect(pane.querySelector(".session-link").textContent).toBe("https://bbc.xania.org/?client=scorch");
        button.click();
        expect(pane.hidden).toBe(true);
        expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens just above the lights, follows them as the window resizes, and stays wherever it was dragged", () => {
        const { pane } = page();
        const lightsTop = 700;
        const lights = vi.spyOn(document.getElementById("leds"), "getBoundingClientRect");
        lights.mockReturnValue({ top: lightsTop });
        const panel = new SessionPanel(session());
        panel.open();
        expect(pane.style.bottom).toBe(`${window.innerHeight - lightsTop + 6}px`);
        expect(pane.style.maxHeight).toBe(`${lightsTop - 12}px`);
        lights.mockReturnValue({ top: lightsTop - 40 });
        window.dispatchEvent(new Event("resize"));
        expect(pane.style.bottom).toBe(`${window.innerHeight - lightsTop + 40 + 6}px`);
        panel.floating.close();
        pane.style.top = "10px";
        pane.style.bottom = "auto";
        panel.open();
        expect(pane.style.bottom).toBe("auto");
    });

    it("copies the link and saves the report from the pane", () => {
        const { pane } = page();
        const saveReport = vi.fn();
        const copyLink = vi.fn();
        new SessionPanel(session({ saveReport, copyLink })).open();
        pane.querySelector(".session-report").click();
        pane.querySelector(".session-copy-link").click();
        expect(saveReport).toHaveBeenCalledOnce();
        expect(copyLink).toHaveBeenCalledOnce();
    });

    it("does nothing on a page without the lights", () => {
        const panel = new SessionPanel(session());
        expect(() => {
            panel.open();
            panel.show("guest", "joining", []);
        }).not.toThrow();
    });
});
