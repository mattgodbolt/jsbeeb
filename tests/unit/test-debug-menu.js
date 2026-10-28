// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DebugMenu } from "../../src/web/debug-menu.js";
import { FloatingPanel, PanelArrangement } from "../../src/web/floating-panel.js";
import { StartEdge } from "../../src/web/panel-layout.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("DebugMenu", () => {
    let arrangement;
    let dbgr;
    let inDebugger;

    const panel = (id, title) => {
        document.body.insertAdjacentHTML(
            "beforeend",
            `<div id="${id}" hidden><div class="header"><button class="close"></button></div></div>`,
        );
        const element = document.getElementById(id);
        return new FloatingPanel({
            panel: element,
            header: element.querySelector(".header"),
            closeButton: element.querySelector(".close"),
            id,
            title,
            place: () => ({ x: StartEdge, y: StartEdge }),
            minSize: { w: 100, h: 50 },
            reopens: false,
            arrangement,
        });
    };
    const show = () => document.getElementById("navbarDebug").dispatchEvent(new Event("show.bs.dropdown"));
    const items = () =>
        [...document.querySelectorAll("#debug-menu .panel-item")].map((item) => [
            item.textContent,
            item.getAttribute("aria-checked"),
        ]);
    const label = (id) => document.querySelector(`#${id} .menu-label`).textContent;

    beforeEach(() => {
        domFromIndexHtml("navbarDebug", "debug-menu");
        arrangement = new PanelArrangement(() => window.localStorage);
        inDebugger = false;
        dbgr = { panelsShown: () => false, toggleDebugger: vi.fn(), togglePanels: vi.fn() };
        new DebugMenu({ arrangement, dbgr, inDebugger: () => inDebugger });
    });

    afterEach(teardownDom);

    it("lists every panel that has a title, in the registry's order, ticking the open ones", () => {
        panel("memory", "Memory");
        const watches = panel("watches", "Watches");
        panel("media", null);
        watches.open();
        show();
        expect(items()).toEqual([
            ["Watches", "true"],
            ["Memory", "false"],
        ]);
    });

    it("opens and closes a panel from its item, and is drawn afresh each time it opens", () => {
        const memory = panel("memory", "Memory");
        show();
        document.querySelector('[data-panel="memory"]').click();
        expect(memory.isOpen).toBe(true);
        show();
        expect(items()).toEqual([["Memory", "true"]]);
    });

    it("says whether its first items enter or leave the debugger and show or hide its panels", () => {
        show();
        expect([label("debugger-toggle"), label("debug-views-toggle")]).toEqual([
            "Enter the debugger",
            "Show the debug panels",
        ]);
        inDebugger = true;
        dbgr.panelsShown = () => true;
        show();
        expect([label("debugger-toggle"), label("debug-views-toggle")]).toEqual([
            "Leave the debugger",
            "Hide the debug panels",
        ]);
        document.getElementById("debugger-toggle").click();
        document.getElementById("debug-views-toggle").click();
        expect(dbgr.toggleDebugger).toHaveBeenCalledTimes(1);
        expect(dbgr.togglePanels).toHaveBeenCalledTimes(1);
    });
});
