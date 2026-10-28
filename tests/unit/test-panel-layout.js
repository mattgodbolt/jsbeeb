import { describe, expect, it } from "vitest";

import {
    AllEdges,
    arranged,
    capture,
    Centred,
    closed,
    emptyLayout,
    EndEdge,
    Gap,
    LayoutVersion,
    opened,
    overlaps,
    parseLayout,
    placeOf,
    placeOpened,
    resolve,
    snap,
    StartEdge,
} from "../../src/web/panel-layout.js";

const NavbarHeight = 56;
const LightsHeight = 50;
const HeaderHeight = 30;

const areaOf = (width, height) => ({ left: 0, top: NavbarHeight, right: width, bottom: height - LightsHeight });
const small = areaOf(1280, 720);
const large = areaOf(1920, 1080);
const huge = areaOf(2560, 1440);
const narrow = areaOf(760, 600);
const tiny = areaOf(640, 480);

const Panels = {
    media: { natural: { w: 860, h: 520 }, min: { w: 420, h: 240 }, place: { x: Centred, y: EndEdge } },
    session: { natural: { w: 460, h: 220 }, min: { w: 300, h: 120 }, place: { x: StartEdge, y: EndEdge } },
    watches: { natural: { w: 300, h: 200 }, min: { w: 200, h: 80 }, place: { x: StartEdge, y: StartEdge } },
    disc: { natural: { w: 420, h: 480 }, min: { w: 300, h: 300 }, place: { x: EndEdge, y: StartEdge } },
    memory: { natural: { w: 290, h: 270 }, min: { w: 220, h: 120 }, place: { x: StartEdge, y: StartEdge } },
    disassembly: { natural: { w: 300, h: 270 }, min: { w: 220, h: 120 }, place: { x: EndEdge, y: StartEdge } },
};

const specs = (ids) => ids.map((id) => ({ id, header: HeaderHeight, ...Panels[id] }));
const layOut = (layout, area, ids) => resolve(layout, area, specs(ids));
const rectsOnly = (rects) =>
    Object.fromEntries(Object.entries(rects).map(([id, { x, y, w, h }]) => [id, { x, y, w, h }]));

/** What the user does: drags `id` to `rect`, which snaps, and lets go. */
function drop(layout, area, open, id, rect, size) {
    const { [id]: _dragged, ...others } = rectsOnly(layOut(layout, area, open));
    const snapped = snap(rect, area, others, AllEdges);
    return arranged(layout, id, capture(snapped, area, others, size));
}
const unsized = { w: null, h: null };

function expectApart(rects) {
    const list = Object.entries(rects);
    for (const [i, [id, rect]] of list.entries())
        for (const [other, otherRect] of list.slice(i + 1))
            expect(overlaps(rect, otherRect), `${id} overlaps ${other}`).toBe(false);
}

function expectInside(rects, area) {
    for (const rect of Object.values(rects)) {
        expect(rect.x).toBeGreaterThanOrEqual(area.left);
        expect(rect.y).toBeGreaterThanOrEqual(area.top);
        expect(rect.x + rect.w).toBeLessThanOrEqual(area.right);
        expect(rect.y + rect.h).toBeLessThanOrEqual(area.bottom);
    }
}

describe("panel layout", () => {
    describe("defaults", () => {
        it("puts each panel against its edges, a Gap inside the area", () => {
            const rects = layOut(emptyLayout(), small, ["watches", "disc", "session", "media"]);
            expect(rects.watches).toMatchObject({ x: Gap, y: small.top + Gap });
            expect(rects.disc.x + rects.disc.w).toBe(small.right - Gap);
            expect(rects.session.x).toBe(Gap);
            expect(rects.session.y + rects.session.h).toBe(small.bottom - Gap);
            expectApart(rects);
            expectInside(rects, small);
        });

        it("save nothing, so a panel opened after the window grows takes its default for the new size", () => {
            const layout = opened(emptyLayout(), "disc");
            expect(placeOf(layout, "disc")).toBeNull();
            const before = layOut(layout, small, ["disc"]).disc;
            const after = layOut(layout, large, ["disc"]).disc;
            expect(before.x + before.w).toBe(small.right - Gap);
            expect(after.x + after.w).toBe(large.right - Gap);
        });
    });

    describe("growing and shrinking the window", () => {
        it("keeps a panel dropped near the left edge half way down on that edge, at the same height proportion", () => {
            const midY = (small.top + small.bottom) / 2 - 100;
            const layout = drop(
                emptyLayout(),
                small,
                ["watches"],
                "watches",
                { x: Gap + 5, y: midY, w: 300, h: 200 },
                unsized,
            );
            expect(layout.panels.watches.x).toEqual(StartEdge);
            expect(layout.panels.watches.y.anchor).toBe("centre");
            const before = layOut(layout, small, ["watches"]).watches;
            const after = layOut(layout, huge, ["watches"]).watches;
            expect(after.x).toBe(huge.left + Gap);
            const middle = (rect, area) => (rect.y + rect.h / 2 - area.top) / (area.bottom - area.top);
            expect(middle(after, huge)).toBeCloseTo(middle(before, small), 2);
        });

        it("keeps a panel dragged to the right edge on that edge", () => {
            const layout = drop(
                emptyLayout(),
                small,
                ["watches"],
                "watches",
                { x: 1280 - 300 - 4, y: 300, w: 300, h: 200 },
                unsized,
            );
            expect(layout.panels.watches.x).toEqual(EndEdge);
            const grown = layOut(layout, huge, ["watches"]).watches;
            expect(grown.x + grown.w).toBe(huge.right - Gap);
        });

        it("keeps a panel near the right edge near it, growing or shrinking", () => {
            const layout = drop(
                emptyLayout(),
                huge,
                ["watches"],
                "watches",
                { x: 2560 - Gap - 500, y: 200, w: 300, h: 200 },
                unsized,
            );
            expect(layout.panels.watches.x).toMatchObject({ anchor: "end", offset: 200 });
            expect(layOut(layout, areaOf(3840, 2160), ["watches"]).watches.x).toBe(3840 - Gap - 500);
            const shrunk = layOut(layout, small, ["watches"]).watches;
            const free = small.right - small.left - 2 * Gap - shrunk.w;
            expect((shrunk.x - Gap) / free).toBeGreaterThan(2 / 3);
        });

        it("puts everything back where it was after shrinking and growing again", () => {
            const open = ["watches", "disc", "memory", "disassembly"];
            let layout = drop(emptyLayout(), large, open, "watches", { x: 600, y: 500, w: 300, h: 200 }, unsized);
            layout = drop(layout, large, open, "memory", { x: 20, y: 700, w: 290, h: 270 }, unsized);
            layout = drop(layout, large, open, "disc", { x: 1300, y: 300, w: 500, h: 500 }, { w: 500, h: 500 });
            const before = layOut(layout, large, open);
            const squeezed = layOut(layout, tiny, open);
            expect(squeezed).not.toEqual(before);
            expect(layOut(layout, large, open)).toEqual(before);
        });

        it("keeps a panel stretched top to bottom full height", () => {
            const full = small.bottom - small.top - 2 * Gap;
            const rect = { x: 900, y: small.top + Gap, w: 300, h: full };
            const layout = drop(emptyLayout(), small, ["disassembly"], "disassembly", rect, { w: 300, h: full });
            expect(layout.panels.disassembly.y).toEqual({ anchor: "stretch" });
            expect(layOut(layout, huge, ["disassembly"]).disassembly.h).toBe(huge.bottom - huge.top - 2 * Gap);
        });

        it("does not stretch a panel that only follows its content to full height", () => {
            const full = small.bottom - small.top - 2 * Gap;
            const rect = { x: 900, y: small.top + Gap, w: 300, h: full };
            const layout = drop(emptyLayout(), small, ["disassembly"], "disassembly", rect, unsized);
            expect(layout.panels.disassembly.y).toEqual(StartEdge);
        });
    });

    describe("panels stacked on an edge", () => {
        const open = ["memory", "watches"];
        const stacked = () => {
            const layout = drop(
                emptyLayout(),
                small,
                ["memory"],
                "memory",
                { x: Gap, y: small.top + Gap, w: 290, h: 270 },
                unsized,
            );
            const memory = layOut(layout, small, ["memory"]).memory;
            return drop(
                layout,
                small,
                open,
                "watches",
                { x: memory.x + 4, y: memory.y + memory.h + Gap + 6, w: 300, h: 200 },
                unsized,
            );
        };

        it("attach when one is dropped against another", () => {
            expect(stacked().panels.watches.y.attach).toEqual({ to: "memory", side: "after" });
        });

        it("stay together as the window grows", () => {
            const grown = layOut(stacked(), huge, open);
            expect(grown.watches.y).toBe(grown.memory.y + grown.memory.h + Gap);
            expect(grown.watches.x).toBe(grown.memory.x);
        });

        it("share out the height in proportion when it runs short, in the same order", () => {
            const short = areaOf(1280, 480);
            const squeezed = layOut(stacked(), short, open);
            expectApart(squeezed);
            expectInside(squeezed, short);
            expect(squeezed.memory.y).toBe(short.top + Gap);
            expect(squeezed.watches.y).toBe(squeezed.memory.y + squeezed.memory.h + Gap);
            expect(squeezed.memory.h).toBeLessThan(270);
            expect(squeezed.watches.h).toBeLessThan(200);
            expect(squeezed.memory.h / squeezed.watches.h).toBeCloseTo(270 / 200, 0);
        });

        it("go back to their own edge when the neighbour is closed", () => {
            expect(layOut(stacked(), small, ["watches"]).watches.x).toBe(Gap);
        });

        it("never attach to each other both ways", () => {
            let layout = stacked();
            const watches = layOut(layout, huge, open).watches;
            layout = drop(
                layout,
                huge,
                open,
                "memory",
                { x: Gap, y: watches.y + watches.h + Gap, w: 290, h: 270 },
                unsized,
            );
            expect(layout.panels.memory.y.attach).toEqual({ to: "watches", side: "after" });
            expect(layout.panels.watches.y.attach).toBeUndefined();
            const rects = layOut(layout, huge, open);
            expectApart(rects);
        });

        it("are placed even when saved attachments form a cycle", () => {
            const attached = (to) => ({ ...StartEdge, attach: { to, side: "after" } });
            const layout = {
                ...emptyLayout(),
                order: ["memory", "watches"],
                panels: {
                    memory: { open: true, x: StartEdge, y: attached("watches"), w: null, h: null },
                    watches: { open: true, x: StartEdge, y: attached("memory"), w: null, h: null },
                },
            };
            const rects = layOut(layout, small, open);
            expectApart(rects);
            expectInside(rects, small);
        });
    });

    describe("a narrow window", () => {
        it("keeps each panel on its own edge, apart", () => {
            const open = ["watches", "disc"];
            let layout = drop(emptyLayout(), large, open, "watches", { x: Gap, y: 400, w: 300, h: 200 }, unsized);
            layout = drop(layout, large, open, "disc", { x: 1920 - Gap - 420, y: 380, w: 420, h: 480 }, unsized);
            const rects = layOut(layout, narrow, open);
            expectApart(rects);
            expectInside(rects, narrow);
            expect(rects.disc.x + rects.disc.w).toBe(narrow.right - Gap);
            expect(rects.watches.x).toBe(narrow.left + Gap);
        });
    });

    describe("when nothing fits", () => {
        const open = ["media", "session", "watches", "disc", "memory", "disassembly"];

        it("keeps every panel inside the area, none exactly over another", () => {
            const rects = layOut(emptyLayout(), tiny, open);
            expectInside(rects, tiny);
            const corners = Object.values(rects).map(({ x, y }) => `${x},${y}`);
            expect(new Set(corners).size).toBe(corners.length);
            expect(Object.values(rects).some((rect) => rect.overlapping)).toBe(true);
        });

        it("leaves every header uncovered by the panels stacked above it", () => {
            const rects = Object.entries(layOut(emptyLayout(), tiny, open));
            for (const [i, [id, rect]] of rects.entries()) {
                const header = { x: rect.x, y: rect.y, w: rect.w, h: HeaderHeight };
                for (const [above, aboveRect] of rects.slice(i + 1))
                    expect(overlaps(aboveRect, header), `${above} covers ${id}'s header`).toBe(false);
                if (!rect.overlapping)
                    for (const [other, otherRect] of rects.slice(i + 1))
                        if (!otherRect.overlapping) expect(overlaps(rect, otherRect), `${id} and ${other}`).toBe(false);
            }
        });
    });

    describe("opening and closing", () => {
        it("never moves a panel already open, even one that ranks below by default", () => {
            const area = small;
            let layout = opened(emptyLayout(), "watches");
            const watches = layOut(layout, area, ["watches"]).watches;
            // Memory's default is the same corner as the watches', and it comes first among the panels.
            layout = opened(layout, "memory");
            const others = { watches: { ...watches, header: HeaderHeight } };
            const memory = placeOpened(layout, area, specs(["memory"])[0], others);
            expect(overlaps(memory, watches)).toBe(false);
            const rects = resolve(layout, area, specs(["memory", "watches"]));
            expect(rectsOnly(rects).watches).toEqual(rectsOnly({ watches }).watches);
            expect(rectsOnly(rects).memory).toEqual(rectsOnly({ memory }).memory);
        });

        it("moves a reopened panel whose place was taken, not the panel in it", () => {
            let layout = drop(emptyLayout(), small, ["memory"], "memory", { x: 400, y: 200, w: 290, h: 270 }, unsized);
            layout = closed(layout, "memory");
            layout = drop(layout, small, ["watches"], "watches", { x: 410, y: 210, w: 300, h: 200 }, unsized);
            const watches = layOut(layout, small, ["watches"]).watches;
            layout = opened(layout, "memory");
            const rects = layOut(layout, small, ["watches", "memory"]);
            expect(rects.watches).toEqual(watches);
            expectApart(rects);
        });

        it("lets a panel the user placed keep its spot over one in its default place", () => {
            const layout = drop(
                emptyLayout(),
                small,
                ["watches"],
                "watches",
                { x: 1280 - Gap - 300, y: small.top + Gap, w: 300, h: 200 },
                unsized,
            );
            const rects = layOut(layout, small, ["watches", "disc"]);
            expectApart(rects);
            expect(rects.watches).toMatchObject({ x: 1280 - Gap - 300, y: small.top + Gap });
        });

        it("remembers which panels are open", () => {
            let layout = opened(emptyLayout(), "watches");
            layout = opened(layout, "disc");
            layout = closed(layout, "watches");
            expect(layout.panels.watches.open).toBe(false);
            expect(layout.panels.disc.open).toBe(true);
            expect(layout.order).toEqual(["watches", "disc"]);
        });
    });

    describe("snapping", () => {
        it("pulls a dragged panel to the area's edge within the snap distance, and not beyond it", () => {
            const toEdge = snap({ x: 1280 - Gap - 300 - 11, y: 300, w: 300, h: 200 }, small, {}, AllEdges);
            expect(toEdge.x + toEdge.w).toBe(1280 - Gap);
            const tooFar = snap({ x: 1280 - Gap - 300 - 13, y: 300, w: 300, h: 200 }, small, {}, AllEdges);
            expect(tooFar.x).toBe(1280 - Gap - 300 - 13);
        });

        it("abuts a neighbour a Gap away and lines its top up with it", () => {
            const others = { memory: { x: Gap, y: 100, w: 290, h: 270 } };
            const beside = snap({ x: Gap + 290 + Gap + 9, y: 104, w: 300, h: 200 }, small, others, AllEdges);
            expect(beside).toMatchObject({ x: Gap + 290 + Gap, y: 100 });
        });

        it("moves only the dragged edge of a resize", () => {
            const resized = snap({ x: 100, y: 100, w: 1280 - 100 - Gap - 6, h: 200 }, small, {}, { right: true });
            expect(resized).toEqual({ x: 100, y: 100, w: 1280 - 100 - Gap, h: 200 });
        });
    });

    describe("the saved layout", () => {
        it("reads back what was saved", () => {
            const layout = drop(
                opened(emptyLayout(), "watches"),
                small,
                ["watches"],
                "watches",
                { x: 400, y: 300, w: 300, h: 200 },
                { w: 300, h: null },
            );
            expect(parseLayout(JSON.stringify(layout))).toEqual(layout);
            expect(layout.version).toBe(LayoutVersion);
        });

        it("is the defaults when missing, corrupt or of another version", () => {
            expect(parseLayout(null)).toEqual(emptyLayout());
            expect(parseLayout("{not json")).toEqual(emptyLayout());
            expect(parseLayout(JSON.stringify({ version: LayoutVersion + 1, order: ["watches"], panels: {} }))).toEqual(
                emptyLayout(),
            );
        });

        it("drops unknown panels and any place it does not understand", () => {
            const saved = {
                version: LayoutVersion,
                order: ["watches", "gone", "watches", "disc"],
                panels: {
                    gone: { open: true, x: StartEdge, y: StartEdge, w: null, h: null },
                    watches: { open: true, x: { anchor: "sideways" }, y: StartEdge, w: null, h: null },
                    disc: {
                        open: "yes",
                        x: EndEdge,
                        y: { ...StartEdge, attach: { to: "gone", side: "after" } },
                        w: 4,
                        h: null,
                    },
                    memory: { open: false, x: EndEdge, y: Centred, w: 300, h: -1 },
                    session: { open: false, x: EndEdge, y: Centred, w: 300, h: null },
                },
            };
            expect(parseLayout(JSON.stringify(saved))).toEqual({
                version: LayoutVersion,
                order: ["watches", "disc"],
                panels: {
                    watches: { open: true },
                    disc: { open: false },
                    memory: { open: false },
                    session: { open: false, x: EndEdge, y: Centred, w: 300, h: null },
                },
            });
        });
    });
});
