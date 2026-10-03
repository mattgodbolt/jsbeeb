// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaggingMs, peerState, SessionPanel, SilentMs } from "../../src/web/session-panel.js";

describe("peerState", () => {
    const keepingUp = { lagMs: 60, commits: 60 };

    it.each([
        ["left", { left: true, connected: true }],
        ["connecting", { connected: false }],
        ["ok", { connected: true }],
        ["ok", { connected: true, stats: keepingUp, statsAgeMs: 0 }],
        ["silent", { connected: true, stats: keepingUp, statsAgeMs: SilentMs + 1 }],
        ["silent", { connected: true, stats: { ...keepingUp, commits: 0 }, statsAgeMs: 0 }],
        ["lagging", { connected: true, stats: { ...keepingUp, lagMs: LaggingMs + 1 }, statsAgeMs: 0 }],
        ["lagging", { connected: true, stats: { ...keepingUp, catchingUp: 1 }, statsAgeMs: 0 }],
        ["lagging", { connected: true, stats: { ...keepingUp, starved: 10 }, statsAgeMs: 0 }],
        ["ok", { connected: true, stats: { ...keepingUp, starved: 1 }, statsAgeMs: 0 }],
    ])("is %s for %o", (state, peer) => {
        expect(peerState(peer)).toBe(state);
    });
});

describe("SessionPanel", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    function panelPage() {
        document.body.innerHTML = `<div id="session-panel" hidden>
            <span class="session-heading"></span><span class="session-summary"></span><span class="session-peers"></span>
            <ul class="session-menu"><li><hr></li><li><a href="#" class="session-report"></a></li></ul></div>`;
        return document.getElementById("session-panel");
    }

    it("shows a light and a line for each peer, replacing the last ones", () => {
        const root = panelPage();
        const panel = new SessionPanel(() => {});
        panel.show("hosting", "1 guest", [{ label: "Guest 1", state: "connecting", detail: "connecting" }]);
        panel.show("hosting", "2 guests", [
            { label: "Guest 1", state: "ok", detail: "keeping up" },
            { label: "Guest 2", state: "lagging", detail: "lagging" },
        ]);
        expect(root.hidden).toBe(false);
        expect(root.querySelector(".session-summary").textContent).toBe("2 guests");
        const lights = [...root.querySelectorAll(".led")];
        expect(lights.map((light) => light.dataset.state)).toEqual(["ok", "lagging"]);
        expect(lights.every((light) => light.classList.contains("on"))).toBe(true);
        expect([...root.querySelectorAll(".session-peer")].map((line) => line.textContent)).toEqual([
            "Guest 1: keeping up",
            "Guest 2: lagging",
        ]);
    });

    it("saves the report from its menu", () => {
        const root = panelPage();
        const save = vi.fn();
        new SessionPanel(save);
        root.querySelector(".session-report").click();
        expect(save).toHaveBeenCalledOnce();
    });

    it("does nothing on a page without the lights", () => {
        expect(() => new SessionPanel(() => {}).show("guest", "joining", [])).not.toThrow();
    });
});
