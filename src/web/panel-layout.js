/**
 * Where floating panels go, as pure functions of what the user arranged and the space there is.
 *
 * A panel the user has moved or resized has a place: for each axis an anchor (the start edge, the
 * end edge, the centre, or stretched across), and its size on each axis, or null to follow its
 * content. Window changes never rewrite a place; `resolve` works the screen out from it each time,
 * so shrinking the window and growing it back puts everything where it was.
 *
 * Terms: an area is `{left, top, right, bottom}`, the window below the navbar; a rect
 * is `{x, y, w, h}`.
 */

/** Between neighbouring panels; a panel goes flush against the area's edges. */
export const Gap = 8;
export const SnapDistance = 12;
export const LayoutVersion = 1;
/** Every panel there is or will be. Saved entries under any other id are dropped. */
export const PanelIds = [
    "media",
    "session",
    "watches",
    "disc",
    "toolbar",
    "disassembly",
    "memory",
    "registers",
    "peripherals",
];
export const AllEdges = { left: true, right: true, top: true, bottom: true };
export const StartEdge = { anchor: "start", offset: 0, fraction: 0 };
export const EndEdge = { anchor: "end", offset: 0, fraction: 1 };
export const Centred = { anchor: "centre", fraction: 0.5 };

const NearFraction = 1 / 3;
const Tolerance = 1;
const FractionDigits = 4;
/** How short, in headers, a panel may be squeezed when nothing else fits. */
const SqueezedHeaders = 2;
const Anchors = new Set(["start", "end", "centre", "stretch"]);
const Sides = new Set(["before", "after"]);
const AxisNames = ["x", "y"];
const Axes = {
    x: { pos: "x", size: "w", lo: "left", hi: "right", other: "y" },
    y: { pos: "y", size: "h", lo: "top", hi: "bottom", other: "x" },
};

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi));
const endOf = (rect, axis) => rect[Axes[axis].pos] + rect[Axes[axis].size];
const spansOverlap = (a, b, axis) => a[Axes[axis].pos] < endOf(b, axis) && b[Axes[axis].pos] < endOf(a, axis);
const spanOf = (area, axis) => ({ lo: area[Axes[axis].lo], hi: area[Axes[axis].hi] });
const headerOf = (rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.header });
const without = (list, id) => list.filter((other) => other !== id);

export const overlaps = (a, b) => spansOverlap(a, b, "x") && spansOverlap(a, b, "y");

export function emptyLayout() {
    return { version: LayoutVersion, order: [], panels: {} };
}

/** The panel's saved entry, holding its place, if the user has arranged it, else null. */
export const placeOf = (layout, id) => (layout.panels[id]?.x ? layout.panels[id] : null);

function captureAxis(rect, axis, area, others, sized) {
    const { pos, size, other } = Axes[axis];
    const { lo, hi } = spanOf(area, axis);
    const free = hi - lo - rect[size];
    const fromStart = rect[pos] - lo;
    const fromEnd = free - fromStart;
    if (sized && fromStart <= Tolerance && fromEnd <= Tolerance) return { anchor: "stretch" };
    const fraction = free > 0 ? Number(clamp(fromStart / free, 0, 1).toFixed(FractionDigits)) : 0;
    let anchor;
    if (fromStart <= Tolerance) anchor = { anchor: "start", offset: 0, fraction };
    else if (fromEnd <= Tolerance) anchor = { anchor: "end", offset: 0, fraction };
    else if (fraction < NearFraction) anchor = { anchor: "start", offset: Math.round(fromStart), fraction };
    else if (fraction > 1 - NearFraction) anchor = { anchor: "end", offset: Math.round(fromEnd), fraction };
    else anchor = { anchor: "centre", fraction };
    for (const [id, neighbour] of Object.entries(others)) {
        if (!spansOverlap(rect, neighbour, other)) continue;
        if (Math.abs(rect[pos] - (endOf(neighbour, axis) + Gap)) <= Tolerance)
            return { ...anchor, attach: { to: id, side: "after" } };
        if (Math.abs(endOf(rect, axis) + Gap - neighbour[pos]) <= Tolerance)
            return { ...anchor, attach: { to: id, side: "before" } };
    }
    return anchor;
}

/**
 * The place to save for a panel the user has just left at `rect`, among the open panels `others`
 * ({id: rect}). `size` holds what the user has sized each axis to, null for an axis that follows
 * the content. Only a sized axis touching both edges is saved as stretched.
 */
export function capture(rect, area, others, size) {
    return {
        x: captureAxis(rect, "x", area, others, size.w !== null),
        y: captureAxis(rect, "y", area, others, size.h !== null),
        w: size.w,
        h: size.h,
    };
}

function sizeOn(place, axis, area, panel) {
    const { size } = Axes[axis];
    const { lo, hi } = spanOf(area, axis);
    const room = hi - lo;
    if (place[axis].anchor === "stretch") return Math.max(panel.min[size], room);
    return Math.round(clamp(place[size] ?? panel.natural[size], panel.min[size], room));
}

function positionOn(anchor, axis, area, size, placed) {
    const { lo, hi } = spanOf(area, axis);
    const free = Math.max(0, hi - lo - size);
    const neighbour = anchor.attach && placed[anchor.attach.to];
    let at;
    if (neighbour)
        at = anchor.attach.side === "after" ? endOf(neighbour, axis) + Gap : neighbour[Axes[axis].pos] - Gap - size;
    else if (anchor.anchor === "start") at = lo + Math.min(anchor.offset, anchor.fraction * free);
    else if (anchor.anchor === "end") at = hi - size - Math.min(anchor.offset, (1 - anchor.fraction) * free);
    else if (anchor.anchor === "centre") at = lo + anchor.fraction * free;
    else at = lo;
    return Math.round(clamp(at, lo, hi - size));
}

/** Shrinks each run of attached panels that is too long for an axis, in proportion, down to their minimums. */
function fitChains(panels, places, sizes, area) {
    const byId = Object.fromEntries(panels.map((panel) => [panel.id, panel]));
    for (const axis of AxisNames) {
        const { size } = Axes[axis];
        const { lo, hi } = spanOf(area, axis);
        const next = new Map();
        const hasPrevious = new Set();
        for (const panel of panels) {
            const attach = places[panel.id][axis].attach;
            if (!attach || !byId[attach.to]) continue;
            const [first, second] = attach.side === "after" ? [attach.to, panel.id] : [panel.id, attach.to];
            if (next.has(first) || hasPrevious.has(second)) continue;
            next.set(first, second);
            hasPrevious.add(second);
        }
        for (const head of next.keys()) {
            if (hasPrevious.has(head)) continue;
            const chain = [head];
            while (next.has(chain.at(-1)) && !chain.includes(next.get(chain.at(-1))))
                chain.push(next.get(chain.at(-1)));
            const gaps = Gap * (chain.length - 1);
            const total = chain.reduce((sum, id) => sum + sizes[id][size], gaps);
            if (total <= hi - lo) continue;
            const mins = chain.map((id) => byId[id].min[size]);
            const minTotal = mins.reduce((sum, min) => sum + min, gaps);
            const factor = Math.max(0, (hi - lo - minTotal) / (total - minTotal));
            chain.forEach((id, i) => (sizes[id][size] = Math.floor(mins[i] + (sizes[id][size] - mins[i]) * factor)));
        }
    }
}

/**
 * Where `want` can go without covering any panel in `placed`: the nearest free spot, trimmed
 * towards the panel's minimum if that is nearer. Failing that, the nearest spot that leaves every
 * placed panel's header uncovered, squeezed below its minimum if it must be, and marked as
 * overlapping so that it is stacked above them.
 */
function findRoom(want, panel, placed, area) {
    const others = Object.values(placed);
    if (!others.some((other) => overlaps(want, other))) return { ...want, overlapping: false };
    const ix = spanOf(area, "x");
    const iy = spanOf(area, "y");
    const xs = new Set([want.x, ix.lo, ix.hi - want.w]);
    const ys = new Set([want.y, iy.lo, iy.hi - want.h]);
    for (const other of others) {
        xs.add(other.x + other.w + Gap).add(other.x - Gap - want.w);
        ys.add(other.y + other.h + Gap)
            .add(other.y - Gap - want.h)
            .add(other.y + other.header);
    }
    const rooms = [];
    for (const x of xs)
        for (const y of ys)
            if (x >= ix.lo && y >= iy.lo)
                rooms.push({ x, y, w: Math.min(want.w, ix.hi - x), h: Math.min(want.h, iy.hi - y) });
    const cost = (rect) =>
        Math.abs(rect.x - want.x) + Math.abs(rect.y - want.y) + (want.w - rect.w) + (want.h - rect.h);
    const nearest = (rects) =>
        rects.reduce((best, rect) => (rect && (!best || cost(rect) < cost(best)) ? rect : best), null);
    const free = nearest(rooms.map((room) => trimmedClear(room, panel.min, others)));
    if (free) return { ...free, overlapping: false };
    const squeezed = { w: Math.min(panel.min.w, ix.hi - ix.lo), h: SqueezedHeaders * panel.header };
    const covering = nearest(rooms.map((room) => trimmedClear(room, squeezed, others.map(headerOf))));
    if (covering) return { ...covering, overlapping: true };
    // Below the lowest header it would cover, as far as the area allows.
    const below = Math.max(...others.filter((other) => overlaps(want, other)).map((other) => other.y + other.header));
    const y = Math.max(iy.lo, Math.min(below, iy.hi - panel.header));
    return { x: want.x, y, w: want.w, h: Math.max(panel.header, Math.min(want.h, iy.hi - y)), overlapping: true };
}

/** `rect` trimmed on its right or bottom, whichever loses less, until it clears `obstacles`; null if it cannot. */
function trimmedClear(rect, min, obstacles) {
    if (rect.w < min.w || rect.h < min.h) return null;
    const out = { ...rect };
    for (const obstacle of obstacles) {
        if (!overlaps(out, obstacle)) continue;
        const trimW = obstacle.x > out.x ? obstacle.x - Gap - out.x : -1;
        const trimH = obstacle.y > out.y ? obstacle.y - Gap - out.y : -1;
        const lossW = trimW >= min.w ? (out.w - trimW) * out.h : Infinity;
        const lossH = trimH >= min.h ? (out.h - trimH) * out.w : Infinity;
        if (lossW === Infinity && lossH === Infinity) return null;
        if (lossW <= lossH) out.w = trimW;
        else out.h = trimH;
    }
    return obstacles.some((obstacle) => overlaps(out, obstacle)) ? null : out;
}

function wantedRect(place, size, area, placed) {
    return {
        ...size,
        x: positionOn(place.x, "x", area, size.w, placed),
        y: positionOn(place.y, "y", area, size.h, placed),
    };
}

const placeFor = (layout, panel) => placeOf(layout, panel.id) ?? { w: null, h: null, ...panel.place };
const sizeFor = (place, panel, area) => ({ w: sizeOn(place, "x", area, panel), h: sizeOn(place, "y", area, panel) });
/** What `panel` must keep clear of: `placed`, and `avoid` too while it is in its default place. */
const obstaclesFor = (layout, panel, placed, avoid) => (placeOf(layout, panel.id) ? placed : { ...avoid, ...placed });

/**
 * Where every open panel goes in `area`. Panels go in the layout's order, each after any it is
 * attached to, and each moves aside for the ones already placed.
 * @param {object} layout
 * @param {object} area
 * @param {{id: string, natural: {w: number, h: number}, min: {w: number, h: number}, header: number, place: object}[]} panels
 * the open panels: their content's size, their smallest usable size, their header's height, and
 * the place they take until the user arranges them, which may give a width
 * @param {Object<string, object>} avoid rects, with their header's height set to their whole height, that
 * panels keep clear of while in their default places
 * @returns {Object<string, {x: number, y: number, w: number, h: number, overlapping: boolean}>} in the
 * order they were placed, which is the order to stack the overlapping ones in
 */
export function resolve(layout, area, panels, avoid) {
    const places = Object.fromEntries(panels.map((panel) => [panel.id, placeFor(layout, panel)]));
    const sizes = Object.fromEntries(panels.map((panel) => [panel.id, sizeFor(places[panel.id], panel, area)]));
    fitChains(panels, places, sizes, area);
    const rank = (panel) => {
        const at = layout.order.indexOf(panel.id);
        return at < 0 ? layout.order.length + panels.indexOf(panel) : at;
    };
    const pending = [...panels].sort((a, b) => rank(a) - rank(b));
    const placed = {};
    const result = {};
    const isReady = (panel) =>
        AxisNames.every((axis) => {
            const to = places[panel.id][axis].attach?.to;
            return !to || !sizes[to] || placed[to];
        });
    while (pending.length) {
        // A cycle of attachments is broken at its highest ranked panel.
        const [panel] = pending.splice(Math.max(0, pending.findIndex(isReady)), 1);
        const want = wantedRect(places[panel.id], sizes[panel.id], area, placed);
        const rect = findRoom(want, panel, obstaclesFor(layout, panel, placed, avoid), area);
        placed[panel.id] = { ...rect, header: panel.header };
        result[panel.id] = rect;
    }
    return result;
}

/**
 * Where a panel being opened goes, leaving the open panels `others` ({id: rect with its header's
 * height}) where they are, and keeping clear of `avoid` as `resolve` does.
 */
export function placeOpened(layout, area, panel, others, avoid) {
    const place = placeFor(layout, panel);
    const want = wantedRect(place, sizeFor(place, panel, area), area, others);
    return findRoom(want, panel, obstaclesFor(layout, panel, others, avoid), area);
}

/**
 * `rect` pulled to the nearest edge of the area or of `others` within the snap distance, on each
 * axis. `edges` are the ones moving: `AllEdges` for a drag, the dragged ones for a resize.
 */
export function snap(rect, area, others, edges) {
    const out = { ...rect };
    const isMove = edges === AllEdges;
    for (const axis of AxisNames) {
        const { pos, size, lo: loEdge, hi: hiEdge, other } = Axes[axis];
        const { lo, hi } = spanOf(area, axis);
        // Judged against `out`, so y sees where x snapped to, and lines up with the panel it now sits beside.
        const reach = Gap + SnapDistance;
        const near = Object.values(others).filter(
            (o) => o[Axes[other].pos] < endOf(out, other) + reach && endOf(o, other) + reach > out[Axes[other].pos],
        );
        const candidates = [];
        if (edges[loEdge])
            for (const line of [lo, ...near.flatMap((o) => [endOf(o, axis) + Gap, o[pos]])])
                candidates.push({ shift: line - rect[pos], isStart: true });
        if (edges[hiEdge])
            for (const line of [hi, ...near.flatMap((o) => [o[pos] - Gap, endOf(o, axis)])])
                candidates.push({ shift: line - endOf(rect, axis), isStart: false });
        const best = candidates.reduce(
            (nearest, candidate) =>
                !nearest || Math.abs(candidate.shift) < Math.abs(nearest.shift) ? candidate : nearest,
            null,
        );
        if (!best || Math.abs(best.shift) > SnapDistance) continue;
        if (isMove) out[pos] += best.shift;
        else if (best.isStart) {
            out[pos] += best.shift;
            out[size] -= best.shift;
        } else out[size] += best.shift;
    }
    return out;
}

/**
 * The layout once the user has arranged panel `id` to `place`. It goes first in the order, and a
 * panel attached to it on an axis it now attaches back on lets go, so attachments never pair up.
 */
export function arranged(layout, id, place) {
    const panels = { ...layout.panels, [id]: { ...layout.panels[id], ...place } };
    for (const [other, entry] of Object.entries(panels)) {
        if (other === id || !entry.x) continue;
        for (const axis of AxisNames)
            if (entry[axis].attach?.to === id && place[axis].attach?.to === other) {
                const { attach: _letGo, ...own } = entry[axis];
                panels[other] = { ...panels[other], [axis]: own };
            }
    }
    return { ...layout, order: [id, ...without(layout.order, id)], panels };
}

/** The layout once panel `id` is opened: last in the order, so it never displaces one already open. */
export function opened(layout, id) {
    return {
        ...layout,
        order: [...without(layout.order, id), id],
        panels: { ...layout.panels, [id]: { ...layout.panels[id], open: true } },
    };
}

export function closed(layout, id) {
    return { ...layout, panels: { ...layout.panels, [id]: { ...layout.panels[id], open: false } } };
}

const isFraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const isSize = (value) => value === null || (Number.isFinite(value) && value > 0);

function isAnchor(anchor) {
    if (!anchor || !Anchors.has(anchor.anchor)) return false;
    if (anchor.attach && !(PanelIds.includes(anchor.attach.to) && Sides.has(anchor.attach.side))) return false;
    if (anchor.anchor === "stretch") return true;
    if (!isFraction(anchor.fraction)) return false;
    return anchor.anchor === "centre" || (Number.isFinite(anchor.offset) && anchor.offset >= 0);
}

function parseEntry(entry) {
    const open = entry?.open === true;
    if (!isAnchor(entry?.x) || !isAnchor(entry?.y) || !isSize(entry?.w) || !isSize(entry?.h)) return { open };
    const { x, y, w, h } = entry;
    return { open, x, y, w, h };
}

/**
 * The layout saved as `text`. Anything not understood, from a whole layout of another version to
 * one panel's place, is dropped, which leaves that panel where it goes by default.
 */
export function parseLayout(text) {
    let saved;
    try {
        saved = JSON.parse(text);
    } catch {
        return emptyLayout();
    }
    if (saved?.version !== LayoutVersion) return emptyLayout();
    const panels = {};
    for (const id of PanelIds) if (saved.panels?.[id]) panels[id] = parseEntry(saved.panels[id]);
    const order = Array.isArray(saved.order) ? [...new Set(saved.order.filter((id) => PanelIds.includes(id)))] : [];
    return { version: LayoutVersion, order, panels };
}
