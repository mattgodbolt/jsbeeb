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
 * Places, stacks and remembers every floating panel. What the user arranged is saved in one
 * localStorage entry (see panel-layout.js); window resizes lay the panels out again from it
 * without writing to it.
 */
export class PanelArrangement {
    /** @param {function(): Storage} storage */
    constructor(storage) {
        this._storage = storage;
        /** @type {FloatingPanel[]} lowest first */
        this._stack = [];
        this._onWindowResize = () => this.relayout();
    }

    /** @param {FloatingPanel} floating */
    register(floating) {
        if (this._stack.length === 0) window.addEventListener("resize", this._onWindowResize);
        this._stack.push(floating);
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

    raise(floating) {
        this._stack = [...this._stack.filter((other) => other !== floating), floating];
        this._stack.forEach((other, index) => (other.panel.style.zIndex = `${BaseZIndex + index}`));
    }

    onOpen(floating) {
        const layout = opened(this._read(), floating.id);
        this._save(layout);
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
}

export const panelArrangement = new PanelArrangement(() => window.localStorage);

/**
 * A panel that floats over the machine: hidden until opened, dragged by its header, resized from
 * its edges and corners, raised by a click, and closed by its button or Escape. A
 * PanelArrangement places it and remembers where the user put it. Raises "open" and "close".
 */
export class FloatingPanel extends EventTarget {
    /**
     * @param {object} options
     * @param {HTMLElement} options.panel
     * @param {HTMLElement} options.header the drag handle
     * @param {HTMLElement} options.closeButton
     * @param {string} options.id one of panel-layout.js's PanelIds, under which its place is saved
     * @param {{x: object, y: object}} options.place where it goes until the user arranges it
     * @param {{w: number, h: number}} options.minSize
     * @param {boolean} options.reopens whether it opens again on reload if it was open
     * @param {PanelArrangement} options.arrangement
     */
    constructor({ panel, header, closeButton, id, place, minSize, reopens, arrangement }) {
        super();
        this.panel = panel;
        this.header = header;
        this.id = id;
        this.place = place;
        this.minSize = minSize;
        this.reopens = reopens;
        this.isOpen = false;
        this._arrangement = arrangement;
        this._gesture = null;
        closeButton.addEventListener("click", () => this.close());
        panel.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            this.close();
        });
        panel.addEventListener("pointerdown", () => arrangement.raise(this), true);
        this._bindGestures();
        arrangement.register(this);
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
        this._gesture = null;
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
        return {
            id: this.id,
            natural: { w: this.panel.offsetWidth, h: this.panel.offsetHeight },
            min: this.minSize,
            header: this.headerHeight(),
            place: this.place,
        };
    }

    _bindGestures() {
        this.header.addEventListener("pointerdown", (e) => {
            if (e.target.closest("button")) return;
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
        for (const ending of ["pointerup", "pointercancel"])
            this.panel.addEventListener(ending, (e) => {
                const gesture = this._gesture;
                if (!gesture || gesture.pointerId !== e.pointerId) return;
                this._gesture = null;
                if (gesture.rect) this._arrangement.settle(this, gesture.context, gesture.rect, gesture.edges);
            });
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
        // Also keeps the focus where it was: the keyboard belongs to the machine.
        e.preventDefault();
    }
}
