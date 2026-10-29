// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingPanel, navbarHeightOf, PanelArrangement, panelShell } from "../../src/web/floating-panel.js";
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
                <div class="panel-header" style="cursor: move"><button class="panel-close">Close</button></div>
                <input class="inside" />
            </div>`,
        );
        const panel = document.getElementById(id);
        const header = panel.querySelector(".panel-header");
        boxFromStyle(panel, Natural);
        header.getBoundingClientRect = () => {
            const top = panel.getBoundingClientRect().top;
            return { top, bottom: top + HeaderHeight };
        };
        const floating = new FloatingPanel({
            panel,
            id,
            title: reopens ? id : null,
            group: null,
            place: () => place,
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
    const header = (floating) => floating.panel.querySelector(".panel-header");
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
            floating.panel.querySelector(".panel-close").click();
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
            drag(floating.panel.querySelector(".panel-close"), { x: 20, y: 70 }, { x: 300, y: 300 });
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

        it("reopens the panels it has where they were, passing over one saved open that this page never made, as a device panel on an Atom", () => {
            const device = make("sysvia", { x: EndEdge, y: EndEdge }, true);
            const first = watches();
            device.open();
            first.open();
            drag(header(first), { x: 20, y: 70 }, { x: 420, y: 370 });
            const left = rectOf(first);

            load();
            const reloaded = watches();
            arrangement.reopen();
            expect(reloaded.isOpen).toBe(true);
            expect(rectOf(reloaded)).toEqual(left);
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

    describe("the keyboard", () => {
        it("keeps its buttons and links from focus", () => {
            const floating = watches();
            floating.open();
            floating.panel.insertAdjacentHTML("beforeend", `<a href="#" class="link">link</a>`);
            for (const target of [
                floating.panel.querySelector(".panel-close"),
                floating.panel.querySelector(".link"),
            ]) {
                const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
                target.dispatchEvent(press);
                expect(press.defaultPrevented).toBe(true);
            }
        });

        it("gives the keyboard back on Escape in one of its text fields, and closes on Escape elsewhere in it", () => {
            const floating = watches();
            floating.open();
            const field = floating.panel.querySelector(".inside");
            field.classList.add("panel-field");
            const pageSaw = vi.fn();
            document.addEventListener("keydown", pageSaw);
            field.focus();
            field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            expect(document.activeElement).not.toBe(field);
            expect(floating.isOpen).toBe(true);
            floating.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            expect(floating.isOpen).toBe(false);
            document.removeEventListener("keydown", pageSaw);
            expect(pageSaw).not.toHaveBeenCalled();
        });

        it("ranks panels by which was clicked or opened last", () => {
            const [one, two] = [watches(), disc()];
            one.open();
            two.open();
            expect(arrangement.frontmost([one, two])).toBe(two);
            one.panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            expect(arrangement.frontmost([one, two])).toBe(one);
            expect(arrangement.frontmost([])).toBe(null);
        });

        it("says which panel opened or closed", () => {
            const floating = watches();
            const changed = [];
            arrangement.addEventListener("change", (e) => changed.push(e.detail.floating));
            floating.open();
            floating.close();
            expect(changed).toEqual([floating, floating]);
        });

        it("lists the panels with a title, in the registry's order", () => {
            media();
            disc();
            watches();
            expect(arrangement.listed().map((floating) => floating.id)).toEqual(["watches", "disc"]);
        });
    });

    describe("attached panels", () => {
        const above = () => make("disassembly", { x: StartEdge, y: StartEdge }, true);
        const below = () =>
            make(
                "registers",
                { x: StartEdge, y: { ...StartEdge, attach: { to: "disassembly", side: "after" } } },
                true,
            );

        it("sit under the panel they are attached to by default, and follow it as its content grows", () => {
            const top = above();
            const under = below();
            top.open();
            under.open();
            expect(rectOf(under).y).toBe(NavbarHeight + Natural.h + Gap);
            boxFromStyle(top.panel, { w: Natural.w, h: Natural.h + 40 });
            arrangement.keepAttached();
            expect(rectOf(under).y).toBe(NavbarHeight + Natural.h + 40 + Gap);
        });

        it("lay out nothing again while they still abut", () => {
            const top = above();
            const under = below();
            top.open();
            under.open();
            const relayout = vi.spyOn(arrangement, "relayout");
            arrangement.keepAttached();
            expect(relayout).not.toHaveBeenCalled();
        });

        it("are measured rounded up, so content laid out at a fraction of a pixel never wraps", () => {
            const floating = watches();
            boxFromStyle(floating.panel, { w: 150.4, h: 80.2 });
            expect(floating.measure().natural).toEqual({ w: 151, h: 81 });
        });

        it("are measured at the width their default place gives them", () => {
            const floating = make("memory", { x: StartEdge, y: StartEdge, w: 150 }, true);
            floating.open();
            expect(rectOf(floating).w).toBe(150);
            expect(floating.measure().natural.w).toBe(150);
        });
    });

    describe("made from a shell", () => {
        const shelled = (id, group) => {
            const { panel, body } = panelShell({ id, title: `The ${id}`, feature: id });
            const floating = new FloatingPanel({
                panel,
                id,
                title: `The ${id}`,
                group,
                place: () => ({ x: StartEdge, y: StartEdge }),
                minSize: { w: 120, h: 60 },
                reopens: true,
                arrangement,
            });
            return { floating, body };
        };

        it("has a header with its title and a button that closes it, and an empty body, hidden until opened", () => {
            const { floating, body } = shelled("sysvia", "debug");
            expect(floating.panel.id).toBe("sysvia-panel");
            expect(floating.panel.hidden).toBe(true);
            expect(floating.header.querySelector(".panel-title").textContent).toBe("The sysvia");
            expect(body.childElementCount).toBe(0);
            floating.open();
            floating.header.querySelector(".panel-close").click();
            expect(floating.isOpen).toBe(false);
        });

        it("is grouped with the panels made in its group, in the order they were made", () => {
            const sysvia = shelled("sysvia", "debug").floating;
            shelled("watches", null);
            const uservia = shelled("uservia", "debug").floating;
            expect(arrangement.panelsIn("debug")).toEqual([sysvia, uservia]);
        });

        it("opens and closes from any element that names it, leaving the rest of the page's clicks alone", () => {
            const { floating } = shelled("uservia", "debug");
            document.body.insertAdjacentHTML(
                "beforeend",
                `<a href="#" data-opens="uservia-panel"><span class="inner">open</span></a><a href="#" class="other">no</a>`,
            );
            const click = (selector) => {
                const event = new MouseEvent("click", { bubbles: true, cancelable: true });
                document.querySelector(selector).dispatchEvent(event);
                return event.defaultPrevented;
            };
            expect(click(".inner")).toBe(true);
            expect(floating.isOpen).toBe(true);
            expect(click("[data-opens]")).toBe(true);
            expect(floating.isOpen).toBe(false);
            expect(click(".other")).toBe(false);
        });
    });

    describe("keeping up with the machine", () => {
        let frames;
        let cycles;
        const runFrame = () => {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback();
        };

        beforeEach(() => {
            frames = new Map();
            let handle = 0;
            vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
                frames.set(++handle, callback);
                return handle;
            });
            vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
            cycles = 0;
            arrangement.followMachine(() => cycles);
        });

        it("draws an open panel once a frame, but only when the machine has moved on or it is asked to", () => {
            const floating = watches();
            const draw = vi.fn();
            const refresh = arrangement.refreshing(() => floating.isOpen, draw);
            floating.open();
            refresh.drawNow();
            runFrame();
            expect(draw).toHaveBeenCalledTimes(1);
            cycles += 100;
            runFrame();
            runFrame();
            expect(draw).toHaveBeenCalledTimes(2);
            refresh.drawSoon();
            runFrame();
            expect(draw).toHaveBeenCalledTimes(3);
            cycles = 0;
            runFrame();
            expect(draw).toHaveBeenCalledTimes(4);
        });

        it("draws again at the next frame when a draw asks to, with work left over, though the machine stands still", () => {
            const floating = watches();
            let workLeft = 2;
            const draw = vi.fn(() => {
                if (--workLeft > 0) refresh.drawSoon();
            });
            const refresh = arrangement.refreshing(() => floating.isOpen, draw);
            floating.open();
            refresh.drawNow();
            runFrame();
            runFrame();
            expect(draw).toHaveBeenCalledTimes(2);
        });

        it("takes what its owner drew itself as up to date", () => {
            const floating = watches();
            const draw = vi.fn();
            const refresh = arrangement.refreshing(() => floating.isOpen, draw);
            floating.open();
            cycles += 100;
            refresh.drawn();
            runFrame();
            expect(draw).not.toHaveBeenCalled();
        });

        it("runs one loop of frames for every panel, and none once nothing it draws is shown", () => {
            const first = watches();
            const second = disc();
            const other = media();
            const draws = [vi.fn(), vi.fn()];
            arrangement.refreshing(() => first.isOpen, draws[0]);
            arrangement.refreshing(() => second.isOpen, draws[1]);
            other.open();
            expect(frames.size).toBe(0);
            first.open();
            second.open();
            expect(frames.size).toBe(1);
            cycles += 1;
            runFrame();
            expect(draws.map((draw) => draw.mock.calls.length)).toEqual([1, 1]);
            first.close();
            expect(frames.size).toBe(1);
            second.close();
            expect(frames.size).toBe(0);
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
