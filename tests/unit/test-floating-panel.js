// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingPanel, navbarHeightOf, PanelArrangement } from "../../src/web/floating-panel.js";
import { EndEdge, Gap, overlaps, StartEdge } from "../../src/web/panel-layout.js";
import { sentEvents, teardownDom } from "./helpers.js";

const NavbarHeight = 50;
const HeaderHeight = 30;
const Natural = { w: 200, h: 100 };

/** Gives `element` the box its inline style says, or `natural` where the style is silent, as a browser would. */
function boxFromStyle(element, natural) {
    const box = () => {
        const { style } = element;
        const x = parseFloat(style.left) || 0;
        const y = parseFloat(style.top) || 0;
        const w = parseFloat(style.width) || natural.w;
        const h = parseFloat(style.height) || natural.h;
        return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
    };
    element.getBoundingClientRect = box;
    Object.defineProperty(element, "offsetWidth", { get: () => box().width, configurable: true });
    Object.defineProperty(element, "offsetHeight", { get: () => box().height, configurable: true });
}

describe("FloatingPanel", () => {
    let storage;
    let arrangement;

    const resizeWindow = (width, height) => {
        vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
        vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
        window.dispatchEvent(new Event("resize"));
    };
    const saved = () => JSON.parse(storage.getItem("panelLayout"));

    function make(id, place, reopens) {
        document.body.insertAdjacentHTML(
            "beforeend",
            `<div id="${id}" data-feature="${id}" hidden>
                <div class="header" style="cursor: move"><button class="close">Close</button></div>
                <input class="inside" />
            </div>`,
        );
        const panel = document.getElementById(id);
        const header = panel.querySelector(".header");
        boxFromStyle(panel, Natural);
        header.getBoundingClientRect = () => {
            const top = panel.getBoundingClientRect().top;
            return { top, bottom: top + HeaderHeight };
        };
        const floating = new FloatingPanel({
            panel,
            header,
            closeButton: panel.querySelector(".close"),
            id,
            place,
            minSize: { w: 120, h: 60 },
            reopens,
            arrangement,
        });
        for (const target of [header, ...panel.querySelectorAll(".panel-resize")]) target.setPointerCapture = () => {};
        return floating;
    }
    const watches = () => make("watches", { x: StartEdge, y: StartEdge }, true);
    const disc = () => make("disc", { x: EndEdge, y: StartEdge }, true);
    const media = () => make("media", { x: EndEdge, y: EndEdge }, false);

    const rectOf = (floating) => {
        const { left, top, width, height } = floating.panel.getBoundingClientRect();
        return { x: left, y: top, w: width, h: height };
    };
    const pointer = (target, type, x, y, extra) =>
        target.dispatchEvent(
            new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true, ...extra }),
        );
    function drag(target, from, to, extra) {
        pointer(target, "pointerdown", from.x, from.y, {});
        pointer(target, "pointermove", to.x, to.y, extra);
        pointer(target, "pointerup", to.x, to.y, {});
    }
    const header = (floating) => floating.panel.querySelector(".header");
    const handle = (floating, edges) => floating.panel.querySelector(`.panel-resize-${edges}`);

    /** A fresh page, as after a reload. */
    function load() {
        arrangement = new PanelArrangement(() => storage);
        document.body.innerHTML = `<nav id="header-bar"></nav>`;
        Object.defineProperty(document.getElementById("header-bar"), "offsetHeight", { value: NavbarHeight });
    }

    beforeEach(() => {
        storage = window.localStorage;
        load();
    });

    afterEach(teardownDom);

    describe("opening and closing", () => {
        it("starts closed and opens, closes and toggles, saying so once per change", () => {
            const floating = watches();
            const seen = [];
            for (const type of ["open", "close"]) floating.addEventListener(type, () => seen.push(type));
            expect(floating.isOpen).toBe(false);
            floating.open();
            floating.open();
            expect(floating.panel.hidden).toBe(false);
            floating.toggle();
            expect(floating.panel.hidden).toBe(true);
            floating.close();
            expect(seen).toEqual(["open", "close"]);
        });

        it("notes each opening as its feature's", () => {
            const sent = sentEvents();
            const floating = watches();
            floating.open();
            floating.close();
            floating.open();
            expect(sent("feature_used")).toEqual([
                { feature: "watches", action: "open" },
                { feature: "watches", action: "open" },
            ]);
        });

        it("closes from its button and from Escape pressed inside it", () => {
            const floating = watches();
            floating.open();
            floating.panel.querySelector(".close").click();
            expect(floating.isOpen).toBe(false);
            floating.open();
            const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
            floating.panel.querySelector(".inside").dispatchEvent(escape);
            expect(floating.isOpen).toBe(false);
        });

        it("lets go of the keyboard focus when it closes", () => {
            const floating = watches();
            floating.open();
            const inside = floating.panel.querySelector(".inside");
            inside.focus();
            floating.close();
            expect(document.activeElement).toBe(document.body);
        });

        it("opens in its default place, flush with the window below the navbar", () => {
            const left = watches();
            const right = media();
            left.open();
            right.open();
            expect(rectOf(left)).toEqual({ x: 0, y: NavbarHeight, ...Natural });
            expect(rectOf(right)).toMatchObject({
                x: window.innerWidth - Natural.w,
                y: window.innerHeight - Natural.h,
            });
        });

        it("opens above the lights by default and grows no further down, but goes over them where the user puts it", () => {
            const LightsHeight = 60;
            document.body.insertAdjacentHTML("beforeend", `<div id="leds"></div>`);
            const lights = document.getElementById("leds");
            lights.getClientRects = () => [{}];
            lights.getBoundingClientRect = () => ({
                left: 0,
                top: window.innerHeight - LightsHeight,
                width: 400,
                height: LightsHeight,
            });
            const floating = make("session", { x: StartEdge, y: EndEdge }, false);
            floating.open();
            expect(rectOf(floating)).toMatchObject({ x: 0, y: window.innerHeight - LightsHeight - Gap - Natural.h });
            expect(floating.panel.style.maxHeight).toBe(`${Natural.h}px`);
            const start = rectOf(floating);
            drag(header(floating), { x: start.x, y: start.y }, { x: start.x, y: window.innerHeight });
            window.dispatchEvent(new Event("resize"));
            expect(rectOf(floating)).toMatchObject({ x: 0, y: window.innerHeight - Natural.h });
        });

        it("never moves a panel already open", () => {
            const first = disc();
            first.open();
            const start = rectOf(first);
            drag(header(first), { x: start.x, y: start.y }, { x: 0, y: 0 });
            const before = rectOf(first);
            const second = watches();
            second.open();
            expect(rectOf(first)).toEqual(before);
            expect(overlaps(rectOf(second), before)).toBe(false);
        });

        it("goes on top when opened or clicked", () => {
            const first = watches();
            const second = disc();
            first.open();
            second.open();
            expect(Number(second.panel.style.zIndex)).toBeGreaterThan(Number(first.panel.style.zIndex));
            pointer(first.panel.querySelector(".inside"), "pointerdown", 20, 100, {});
            expect(Number(first.panel.style.zIndex)).toBeGreaterThan(Number(second.panel.style.zIndex));
        });

        it("leaves its place to the stylesheet while its header is not a drag handle", () => {
            const floating = watches();
            header(floating).style.cursor = "default";
            floating.open();
            expect(floating.panel.style.left).toBe("");
            drag(header(floating), { x: 20, y: 70 }, { x: 200, y: 200 });
            expect(floating.panel.style.left).toBe("");
        });
    });

    describe("moving and resizing", () => {
        it("is dragged by its header, kept inside the work area", () => {
            const floating = watches();
            floating.open();
            const start = rectOf(floating);
            pointer(header(floating), "pointerdown", start.x + 10, start.y + 10, {});
            pointer(header(floating), "pointermove", start.x + 210, start.y + 110, {});
            expect(rectOf(floating)).toMatchObject({ x: start.x + 200, y: start.y + 100 });
            pointer(header(floating), "pointermove", -500, -500, {});
            expect(rectOf(floating)).toMatchObject({ x: 0, y: NavbarHeight });
            pointer(header(floating), "pointermove", 5000, 5000, {});
            expect(rectOf(floating)).toMatchObject({
                x: window.innerWidth - Natural.w,
                y: window.innerHeight - Natural.h,
            });
        });

        it("snaps to an edge within reach, unless Shift is held", () => {
            const floating = watches();
            floating.open();
            drag(header(floating), { x: 20, y: 70 }, { x: 20 + 300, y: 70 + 200 });
            const nearEdge = window.innerWidth - Natural.w - 10;
            const start = rectOf(floating);
            drag(header(floating), { x: start.x, y: start.y }, { x: nearEdge, y: start.y }, { shiftKey: true });
            expect(rectOf(floating).x).toBe(nearEdge);
            drag(header(floating), { x: nearEdge, y: start.y }, { x: nearEdge + 1, y: start.y });
            expect(rectOf(floating).x).toBe(window.innerWidth - Natural.w);
        });

        it("ignores a drag that starts on a button in the header, or with another mouse button", () => {
            const floating = watches();
            floating.open();
            const before = rectOf(floating);
            drag(floating.panel.querySelector(".close"), { x: 20, y: 70 }, { x: 300, y: 300 });
            pointer(header(floating), "pointerdown", 20, 70, { button: 2 });
            pointer(header(floating), "pointermove", 300, 300, {});
            expect(rectOf(floating)).toEqual(before);
        });

        it("is resized from an edge or corner, no smaller than its minimum", () => {
            const floating = watches();
            floating.open();
            const start = rectOf(floating);
            drag(
                handle(floating, "bottom-right"),
                { x: start.x + 200, y: start.y + 100 },
                { x: start.x + 260, y: start.y + 180 },
            );
            expect(rectOf(floating)).toEqual({ ...start, w: 260, h: 180 });
            drag(handle(floating, "left"), { x: start.x, y: start.y + 50 }, { x: start.x + 1000, y: start.y + 50 });
            expect(rectOf(floating)).toMatchObject({ x: start.x + 260 - 120, w: 120, h: 180 });
        });

        it("stays at its minimum when a resized edge snaps inward past it", () => {
            const neighbour = disc();
            neighbour.open();
            const lined = { x: Natural.w - 120 + 10, y: NavbarHeight + Natural.h + 12 };
            const at = rectOf(neighbour);
            drag(header(neighbour), { x: at.x, y: at.y }, lined, { shiftKey: true });
            expect(rectOf(neighbour)).toMatchObject(lined);
            const floating = watches();
            floating.open();
            const start = rectOf(floating);
            drag(handle(floating, "left"), { x: start.x, y: start.y + 50 }, { x: lined.x - 3, y: start.y + 50 });
            expect(rectOf(floating)).toMatchObject({ x: start.x + Natural.w - 120, w: 120 });
        });

        it("does not take the focus from the machine when dragged or resized", () => {
            const floating = watches();
            floating.open();
            const down = new PointerEvent("pointerdown", { pointerId: 1, button: 0, cancelable: true });
            handle(floating, "right").dispatchEvent(down);
            expect(down.defaultPrevented).toBe(true);
        });
    });

    describe("remembering", () => {
        it("saves where the user leaves it, and not where a window resize puts it", () => {
            const floating = disc();
            floating.open();
            const start = rectOf(floating);
            drag(header(floating), { x: start.x, y: start.y }, { x: start.x - 100, y: start.y + 200 });
            const remembered = saved();
            expect(remembered.panels.disc.x).toMatchObject({ anchor: "end" });
            resizeWindow(500, 400);
            expect(saved()).toEqual(remembered);
        });

        it("saves the size it is resized to", () => {
            const floating = watches();
            floating.open();
            const start = rectOf(floating);
            drag(
                handle(floating, "bottom"),
                { x: start.x + 50, y: start.y + 100 },
                { x: start.x + 50, y: start.y + 150 },
            );
            expect(saved().panels.watches).toMatchObject({ w: null, h: 150 });
        });

        it("reopens only the panels that reopen, where they were left", () => {
            const first = watches();
            const second = media();
            first.open();
            second.open();
            drag(header(first), { x: 20, y: 70 }, { x: 420, y: 370 });
            const left = rectOf(first);

            load();
            const reloaded = [watches(), media()];
            arrangement.reopen();
            expect(reloaded.map((floating) => floating.isOpen)).toEqual([true, false]);
            expect(rectOf(reloaded[0])).toEqual(left);
        });

        it("carries on with the defaults when storage cannot be used", () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            storage = {
                getItem: () => {
                    throw new Error("blocked");
                },
                setItem: () => {
                    throw new Error("blocked");
                },
            };
            const floating = watches();
            floating.open();
            drag(header(floating), { x: 20, y: 70 }, { x: 220, y: 270 });
            expect(rectOf(floating)).toMatchObject({ x: 200, y: NavbarHeight + 200 });
            expect(warn).toHaveBeenCalled();
        });
    });
});

describe("navbarHeightOf", () => {
    const header = (height, openMenuHeight) => ({
        offsetHeight: height,
        querySelector: (selector) =>
            selector === ".navbar-collapse.show" && openMenuHeight !== undefined
                ? { offsetHeight: openMenuHeight }
                : null,
    });

    it("is the bar's height, less a menu dropped open over the screen, and never less than nothing", () => {
        expect(navbarHeightOf(header(72))).toBe(72);
        expect(navbarHeightOf(header(380, 308))).toBe(72);
        expect(navbarHeightOf(header(72, 308))).toBe(0);
        expect(navbarHeightOf(null)).toBe(0);
    });
});
