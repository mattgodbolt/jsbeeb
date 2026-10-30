import { noteFeature } from "./analytics.js";
import {
    AllEdges,
    arranged,
    capture,
    closed,
    emptyLayout,
    Gap,
    opened,
    parseLayout,
    placeOf,
    placeOpened,
    resolve,
    snap,
} from "./panel-layout.js";

const StorageKey = "panelLayout";
const BaseZIndex = 10;
/** The group of the panels Alt-D and Alt-S show and hide: the debugger's own, and the decoded devices. */
export const DebugGroup = "debug";
/** The headings a menu of panels lists them under, in this order. */
export const MenuGroup = { cpu: "CPU", hardware: "Hardware", software: "Software" };
const MenuGroupOrder = Object.values(MenuGroup);
const ResizeEdges = ["top", "right", "bottom", "left", "top-left", "top-right", "bottom-left", "bottom-right"];
const GeometryStyles = ["left", "top", "width", "height", "maxHeight"];

const boundsOf = (element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { x: left, y: top, w: width, h: height };
};

/**
 * The height the bar takes from the screen: on a narrow window its menu drops open over the
 * screen rather than above it, so an open menu does not count.
 */
export function navbarHeightOf(header) {
    if (!header) return 0;
    const openMenu = header.querySelector(".navbar-collapse.show");
    return Math.max(0, header.offsetHeight - (openMenu?.offsetHeight ?? 0));
}

/**
 * `start` moved or resized by the pointer having travelled `dx`, `dy`, for `edges` (`AllEdges`
 * for a move), never smaller than `min`.
 */
function dragged(start, edges, dx, dy, min) {
    if (edges === AllEdges) return { ...start, x: start.x + dx, y: start.y + dy };
    const rect = { ...start };
    if (edges.right) rect.w = Math.max(min.w, start.w + dx);
    if (edges.bottom) rect.h = Math.max(min.h, start.h + dy);
    if (edges.left) {
        rect.w = Math.max(min.w, start.w - dx);
        rect.x = start.x + start.w - rect.w;
    }
    if (edges.top) {
        rect.h = Math.max(min.h, start.h - dy);
        rect.y = start.y + start.h - rect.h;
    }
    return rect;
}

const AxisSpans = { x: ["x", "w"], y: ["y", "h"] };
/** In px, for the rounding between where a panel was put and where the page drew it. */
const AbutTolerance = 1;

/** Whether `rect` sits a Gap from `neighbour` on `axis`, on the `side` it is attached to. */
function abuts(rect, neighbour, axis, side) {
    const [pos, size] = AxisSpans[axis];
    const gap =
        side === "after" ? rect[pos] - (neighbour[pos] + neighbour[size]) : neighbour[pos] - (rect[pos] + rect[size]);
    return Math.abs(gap - Gap) <= AbutTolerance;
}

/** `rect` kept inside `area`: moved for a move, cut at the moving edges for a resize. */
function keptInside(rect, area, edges, min) {
    const lo = { x: area.left, y: area.top };
    const hi = { x: area.right, y: area.bottom };
    if (edges === AllEdges)
        return {
            ...rect,
            x: Math.max(lo.x, Math.min(rect.x, hi.x - rect.w)),
            y: Math.max(lo.y, Math.min(rect.y, hi.y - rect.h)),
        };
    const out = { ...rect };
    // Snapping can pull a dragged left or top edge inward past the minimum.
    if (edges.left && out.w < min.w) {
        out.x -= min.w - out.w;
        out.w = min.w;
    }
    if (edges.top && out.h < min.h) {
        out.y -= min.h - out.h;
        out.h = min.h;
    }
    if (edges.left && out.x < lo.x) {
        out.w = Math.max(min.w, out.w - (lo.x - out.x));
        out.x = lo.x;
    }
    if (edges.top && out.y < lo.y) {
        out.h = Math.max(min.h, out.h - (lo.y - out.y));
        out.y = lo.y;
    }
    if (edges.right) out.w = Math.max(min.w, Math.min(out.w, hi.x - out.x));
    if (edges.bottom) out.h = Math.max(min.h, Math.min(out.h, hi.y - out.y));
    return out;
}

/**
 * What a panel that keeps up with the machine shows, redrawn by its PanelArrangement once a frame
 * while shown, when the machine has moved on since it was drawn or when asked.
 */
class PanelRefresh {
    /**
     * @param {PanelArrangement} arrangement
     * @param {function(): boolean} isShown
     * @param {function(): void} draw
     */
    constructor(arrangement, isShown, draw) {
        this._arrangement = arrangement;
        this.isShown = isShown;
        this._draw = draw;
        this._drawnAt = null;
        this._wanted = false;
    }

    drawNow() {
        // Recorded first, so that a draw asking to draw again, with work left over, is kept to it.
        this.drawn();
        this._draw();
    }

    /** Records that what is shown is up to date with the machine as it is now, for an owner that drew it itself. */
    drawn() {
        this._drawnAt = this._arrangement.cycleCount();
        this._wanted = false;
    }

    /** Has it drawn at the next frame, for a change the machine's cycle count does not show, such as the pointer's. */
    drawSoon() {
        this._wanted = true;
        if (this.isShown()) this._arrangement.keepRefreshing();
    }

    isDue(cycles) {
        return this._wanted || cycles !== this._drawnAt;
    }
}

/**
 * Places, stacks and remembers every floating panel. What the user arranged is saved in one
 * localStorage entry (see panel-layout.js); window resizes lay the panels out again from it
 * without writing to it. Raises "change", its detail `{floating}`, when a panel opens or closes.
 *
 * It also redraws the panels that keep up with the machine (see `refreshing`), from one loop of
 * animation frames that runs only while one of them is shown, and opens and closes the panel that
 * a clicked `[data-opens="<element id>"]` element names.
 */
export class PanelArrangement extends EventTarget {
    /** @param {function(): Storage} storage */
    constructor(storage) {
        super();
        this._storage = storage;
        /** @type {FloatingPanel[]} in the order they were made */
        this._panels = [];
        /** @type {FloatingPanel[]} lowest first */
        this._stack = [];
        /** @type {PanelRefresh[]} */
        this._refreshes = [];
        this._cycles = () => null;
        this._frameHandle = null;
        /** @type {Set<FloatingPanel>} */
        this._gesturing = new Set();
        this._attachDeferred = false;
        this._onWindowResize = () => this.relayout();
        this._onClick = (e) => this._openFrom(e);
    }

    /** @param {FloatingPanel} floating */
    register(floating) {
        if (this._panels.length === 0) {
            window.addEventListener("resize", this._onWindowResize);
            document.addEventListener("click", this._onClick);
        }
        this._panels.push(floating);
        this._stack.push(floating);
    }

    /** The panels shown and hidden together as `group`, in the order they were made. */
    panelsIn(group) {
        return this._panels.filter((floating) => floating.group === group);
    }

    _openFrom(e) {
        const opener = e.target.closest("[data-opens]");
        if (!opener) return;
        const element = document.getElementById(opener.dataset.opens);
        const floating = this._panels.find((other) => other.panel === element);
        if (!floating) return;
        e.preventDefault();
        floating.toggle();
    }

    /**
     * Where the machine's cycle count comes from, by which the panels that keep up with the machine
     * tell that it has moved on.
     * @param {function(): number} cycles
     */
    followMachine(cycles) {
        this._cycles = cycles;
    }

    /** The machine's cycle count, or null before there is a machine to follow. */
    cycleCount() {
        return this._cycles();
    }

    /**
     * Has `draw` called once a frame while `isShown()`, but only when the machine has moved on since
     * it last drew or it has been asked to draw again. Left alone while nothing moves, what it shows
     * stays put, so that a click lands on what was under the pointer when it went down. Its owner
     * draws it on opening, with `drawNow`.
     * @param {function(): boolean} isShown
     * @param {function(): void} draw
     * @returns {PanelRefresh}
     */
    refreshing(isShown, draw) {
        const refresh = new PanelRefresh(this, isShown, draw);
        this._refreshes.push(refresh);
        return refresh;
    }

    /** Draws every shown panel that keeps up with the machine, for a change to it that took no cycles. */
    drawAllNow() {
        for (const refresh of this._refreshes) if (refresh.isShown()) refresh.drawNow();
    }

    keepRefreshing() {
        if (this._frameHandle === null) this._frameHandle = requestAnimationFrame(() => this._refreshFrame());
    }

    _refreshFrame() {
        this._frameHandle = null;
        const shown = this._refreshes.filter((refresh) => refresh.isShown());
        if (shown.length === 0) return;
        const cycles = this.cycleCount();
        for (const refresh of shown) if (refresh.isDue(cycles)) refresh.drawNow();
        this.keepRefreshing();
    }

    _refreshWhileShown() {
        if (this._refreshes.some((refresh) => refresh.isShown())) {
            this.keepRefreshing();
        } else if (this._frameHandle !== null) {
            cancelAnimationFrame(this._frameHandle);
            this._frameHandle = null;
        }
    }

    /** Opens again the panels that were open when the page was last left, of those that reopen. */
    reopen() {
        const layout = this._read();
        for (const id of layout.order) {
            const floating = this._stack.find((other) => other.id === id);
            if (floating?.reopens && layout.panels[id]?.open) floating.open();
        }
    }

    _read() {
        try {
            return parseLayout(this._storage().getItem(StorageKey));
        } catch (error) {
            console.warn(`Could not read the panel layout: ${error}`);
            return emptyLayout();
        }
    }

    _save(layout) {
        try {
            this._storage().setItem(StorageKey, JSON.stringify(layout));
        } catch (error) {
            console.warn(`Could not save the panel layout: ${error}`);
        }
    }

    /** The window below the navbar. Panels may go over the lights. */
    workArea() {
        return {
            left: 0,
            top: navbarHeightOf(document.getElementById("header-bar")),
            right: window.innerWidth,
            bottom: window.innerHeight,
        };
    }

    /** Of `floatings`, the one stacked highest, or null if none is registered here. */
    frontmost(floatings) {
        return this._stack.findLast((floating) => floatings.includes(floating)) ?? null;
    }

    /** The panels that offer themselves in a menu, by MenuGroup and then by title. */
    listed() {
        return this._stack
            .filter((floating) => floating.listed)
            .sort(
                (a, b) =>
                    MenuGroupOrder.indexOf(a.menuGroup) - MenuGroupOrder.indexOf(b.menuGroup) ||
                    a.title.localeCompare(b.title),
            );
    }

    raise(floating) {
        this._stack = [...this._stack.filter((other) => other !== floating), floating];
        this._stack.forEach((other, index) => (other.panel.style.zIndex = `${BaseZIndex + index}`));
    }

    onOpen(floating) {
        const layout = opened(this._read(), floating.id);
        this._save(layout);
        this.dispatchEvent(new CustomEvent("change", { detail: { floating } }));
        this._refreshWhileShown();
        this.raise(floating);
        floating.clearGeometry();
        if (!floating.movable) return;
        const area = this.workArea();
        const spec = floating.measure();
        const avoid = this._defaultsAvoid();
        this._apply(
            floating,
            placeOpened(layout, area, spec, this._others(floating), avoid),
            spec,
            layout,
            area,
            avoid,
        );
    }

    onClose(floating) {
        this._save(closed(this._read(), floating.id));
        this.dispatchEvent(new CustomEvent("change", { detail: { floating } }));
        this._refreshWhileShown();
    }

    /** Lays every open panel out again for the window as it is now. */
    relayout() {
        const open = this._stack.filter((floating) => floating.isOpen);
        // Cleared to be measured, nothing inside overflows and the browser forgets how far it was scrolled.
        const scrolled = open
            .flatMap((floating) => [...floating.panel.querySelectorAll("*")])
            .filter((element) => element.scrollTop > 0)
            .map((element) => [element, element.scrollTop]);
        for (const floating of open) floating.clearGeometry();
        const movable = open.filter((floating) => floating.movable);
        const specs = movable.map((floating) => floating.measure());
        const layout = this._read();
        const area = this.workArea();
        const avoid = this._defaultsAvoid();
        const rects = resolve(layout, area, specs, avoid);
        for (const [id, rect] of Object.entries(rects)) {
            const index = movable.findIndex((floating) => floating.id === id);
            this._apply(movable[index], rect, specs[index], layout, area, avoid);
            if (rect.overlapping) this.raise(movable[index]);
        }
        for (const [element, scrollTop] of scrolled) element.scrollTop = scrollTop;
    }

    /**
     * Lays the panels out again if one has come away from the neighbour it is attached to, as when the
     * neighbour's content has grown. Owners whose content changes size call this. Put off while a panel
     * is moved or resized, as the panel being dragged has come away from its neighbour on purpose.
     */
    keepAttached() {
        if (this._gesturing.size > 0) {
            this._attachDeferred = true;
            return;
        }
        const open = this._stack.filter((floating) => floating.isOpen && floating.movable);
        const rects = Object.fromEntries(open.map((floating) => [floating.id, boundsOf(floating.panel)]));
        const layout = this._read();
        const detached = open.some((floating) => {
            const place = placeOf(layout, floating.id) ?? floating.place();
            return ["x", "y"].some((axis) => {
                const attach = place[axis].attach;
                const neighbour = attach && rects[attach.to];
                return neighbour && !abuts(rects[floating.id], neighbour, axis, attach.side);
            });
        });
        if (detached) this.relayout();
    }

    /** Panels may be put over the lights, but do not open over them by default. */
    _defaultsAvoid() {
        const lights = document.getElementById("leds");
        if (!lights || lights.getClientRects().length === 0) return {};
        const bounds = boundsOf(lights);
        return { lights: { ...bounds, header: bounds.h } };
    }

    _others(except) {
        const others = {};
        for (const floating of this._stack)
            if (floating !== except && floating.isOpen && floating.movable)
                others[floating.id] = { ...boundsOf(floating.panel), header: floating.headerHeight() };
        return others;
    }

    _apply(floating, rect, spec, layout, area, avoid) {
        const style = floating.panel.style;
        style.left = `${rect.x}px`;
        style.top = `${rect.y}px`;
        style.width = `${rect.w}px`;
        const place = placeOf(layout, floating.id);
        if (place?.h) {
            style.height = `${rect.h}px`;
            style.maxHeight = "";
        } else {
            // Following its content, it may grow into the room below, unless it was squeezed, and in its
            // default place not into what it was placed clear of.
            const below = Object.values(place ? {} : avoid).filter(
                (other) => other.y >= rect.y + rect.h && other.x < rect.x + rect.w && rect.x < other.x + other.w,
            );
            const floor = Math.min(area.bottom, ...below.map((other) => other.y - Gap));
            style.height = "";
            style.maxHeight = `${rect.h < spec.natural.h ? rect.h : floor - rect.y}px`;
        }
    }

    /** What a gesture on `floating` snaps to and is kept inside, fixed when it starts. */
    beginGesture(floating) {
        this._gesturing.add(floating);
        return { area: this.workArea(), others: this._others(floating) };
    }

    /** Shows `floating` at `rect` part way through a gesture, and returns where it went. */
    follow(floating, gesture, rect, edges, snapping) {
        const snapped = snapping ? snap(rect, gesture.area, gesture.others, edges) : rect;
        const kept = keptInside(snapped, gesture.area, edges, floating.minSize);
        const style = floating.panel.style;
        style.left = `${kept.x}px`;
        style.top = `${kept.y}px`;
        if (edges !== AllEdges) {
            style.width = `${kept.w}px`;
            style.height = `${kept.h}px`;
            style.maxHeight = "";
        } else if (!style.height) {
            style.maxHeight = `${gesture.area.bottom - kept.y}px`;
        }
        return kept;
    }

    /** Saves where the user left `floating` at the end of a gesture that moved `edges`. */
    settle(floating, gesture, rect, edges) {
        const layout = this._read();
        const before = placeOf(layout, floating.id);
        const isResize = edges !== AllEdges;
        const size = {
            w: isResize && (edges.left || edges.right) ? Math.round(rect.w) : (before?.w ?? null),
            h: isResize && (edges.top || edges.bottom) ? Math.round(rect.h) : (before?.h ?? null),
        };
        this._save(arranged(layout, floating.id, capture(rect, gesture.area, gesture.others, size)));
    }

    /** Ends a gesture on `floating`, settled or not, and catches up with what it put off. */
    endGesture(floating) {
        this._gesturing.delete(floating);
        if (this._gesturing.size > 0 || !this._attachDeferred) return;
        this._attachDeferred = false;
        this.keepAttached();
    }
}

/**
 * The frame of a panel whose content is built in code, added to the page hidden: a header with its
 * title and a close button, as FloatingPanel finds them, and an empty body.
 * @param {object} options
 * @param {string} options.id the panel's, of panel-layout.js's PanelIds; the element's is `<id>-panel`
 * @param {string} options.title
 * @param {string} options.feature what analytics calls it
 * @returns {{panel: HTMLElement, body: HTMLElement}}
 */
export function panelShell({ id, title, feature }) {
    const panel = document.createElement("div");
    panel.id = `${id}-panel`;
    panel.dataset.feature = feature;
    panel.hidden = true;
    const header = document.createElement("div");
    header.className = "panel-header";
    const heading = document.createElement("span");
    heading.className = "panel-title";
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-sm btn-outline-light panel-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    header.append(heading, close);
    const body = document.createElement("div");
    body.className = "panel-body";
    panel.append(header, body);
    document.body.append(panel);
    return { panel, body };
}

/**
 * A panel that floats over the machine: hidden until opened, dragged by its header, resized from
 * its edges and corners, raised by a click, and closed by its button or Escape. Its buttons and
 * links never take focus, and Escape in one of its text fields (class `panel-field`) gives the
 * keyboard back instead of closing it. A PanelArrangement places it and remembers where the user
 * put it. Raises "open" and "close".
 *
 * Its element holds its header, the drag handle, as `.panel-header`, with a `.panel-close` button.
 */
export class FloatingPanel extends EventTarget {
    /**
     * @param {object} options
     * @param {HTMLElement} options.panel
     * @param {string} options.id one of panel-layout.js's PanelIds, under which its place is saved
     * @param {string | null} options.title what a menu of panels calls it, or null to stay out of such menus
     * @param {string | null} options.menuGroup the MenuGroup it is listed under, null when its title is
     * @param {string | null} options.group the panels it is shown and hidden with, such as the debugger's
     * ("debug"), or null
     * @param {function(): {x: object, y: object, w?: number}} options.place where it goes until the user
     * arranges it, asked afresh each time it is laid out
     * @param {{w: number, h: number}} options.minSize
     * @param {boolean} options.reopens whether it opens again on reload if it was open
     * @param {PanelArrangement} options.arrangement
     */
    constructor({ panel, id, title, menuGroup, group, place, minSize, reopens, arrangement }) {
        super();
        this.panel = panel;
        this.header = panel.querySelector(".panel-header");
        this.id = id;
        this.title = title;
        this.menuGroup = menuGroup;
        this.group = group;
        this.place = place;
        this.minSize = minSize;
        this.reopens = reopens;
        this.isOpen = false;
        this._arrangement = arrangement;
        panel.classList.add("floating-panel");
        this._gesture = null;
        this.header.querySelector(".panel-close").addEventListener("click", () => this.close());
        panel.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (e.target.closest(".panel-field")) e.target.blur();
            else this.close();
        });
        // Focus left on a control would keep the keys from the machine and the panels.
        panel.addEventListener("mousedown", (e) => {
            if (e.target.closest("button, a")) e.preventDefault();
        });
        panel.addEventListener("pointerdown", () => arrangement.raise(this), true);
        this._bindGestures();
        arrangement.register(this);
    }

    /** Whether it offers itself in menus of panels. */
    get listed() {
        return this.title !== null;
    }

    /** Whether it can be moved: only while its header is styled as a drag handle, with the move cursor. */
    get movable() {
        return getComputedStyle(this.header).cursor === "move";
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.panel.hidden = false;
        this._arrangement.onOpen(this);
        noteFeature(this.panel, "open");
        this.dispatchEvent(new Event("open"));
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this._endGesture();
        // Focus left inside a hidden panel would keep the keyboard from the machine.
        if (this.panel.contains(document.activeElement)) document.activeElement.blur();
        this.panel.hidden = true;
        this._arrangement.onClose(this);
        this.dispatchEvent(new Event("close"));
    }

    clearGeometry() {
        for (const name of GeometryStyles) this.panel.style[name] = "";
    }

    headerHeight() {
        return this.header.getBoundingClientRect().bottom - this.panel.getBoundingClientRect().top;
    }

    /** Its size as its content and stylesheet would have it, once its geometry is cleared, for the layout. */
    measure() {
        const place = this.place();
        // Its content may wrap at the width its place gives it, and be taller there.
        if (place.w) this.panel.style.width = `${place.w}px`;
        const bounds = this.panel.getBoundingClientRect();
        return {
            id: this.id,
            // Rounded up, as a width rounded down would wrap its content.
            natural: { w: Math.ceil(bounds.width), h: Math.ceil(bounds.height) },
            min: this.minSize,
            header: this.headerHeight(),
            place,
        };
    }

    _bindGestures() {
        this.header.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button, input")) return;
            this._begin(e, this.header, AllEdges);
        });
        for (const name of ResizeEdges) {
            const handle = document.createElement("div");
            handle.className = `panel-resize panel-resize-${name}`;
            const edges = Object.fromEntries(name.split("-").map((edge) => [edge, true]));
            handle.addEventListener("pointerdown", (e) => this._begin(e, handle, edges));
            this.panel.append(handle);
        }
        // Pointer capture sends the gesture's moves to the header or handle, and they bubble here.
        this.panel.addEventListener("pointermove", (e) => {
            const gesture = this._gesture;
            if (!gesture || gesture.pointerId !== e.pointerId) return;
            const rect = dragged(
                gesture.start,
                gesture.edges,
                e.clientX - gesture.fromX,
                e.clientY - gesture.fromY,
                this.minSize,
            );
            gesture.rect = this._arrangement.follow(this, gesture.context, rect, gesture.edges, !e.shiftKey);
        });
        for (const ending of ["pointerup", "pointercancel", "lostpointercapture"])
            this.panel.addEventListener(ending, (e) => {
                const gesture = this._gesture;
                if (!gesture || gesture.pointerId !== e.pointerId) return;
                if (gesture.rect) this._arrangement.settle(this, gesture.context, gesture.rect, gesture.edges);
                this._endGesture();
            });
    }

    _endGesture() {
        if (!this._gesture) return;
        this._gesture = null;
        this._arrangement.endGesture(this);
    }

    _begin(e, target, edges) {
        if (e.button !== 0 || !this.movable) return;
        this._gesture = {
            pointerId: e.pointerId,
            fromX: e.clientX,
            fromY: e.clientY,
            start: boundsOf(this.panel),
            edges,
            context: this._arrangement.beginGesture(this),
            rect: null,
        };
        target.setPointerCapture(e.pointerId);
        // Besides stopping a text selection, keeps the focus where it was: the keyboard belongs to the machine.
        e.preventDefault();
    }
}
