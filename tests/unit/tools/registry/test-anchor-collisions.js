import { describe, expect, it } from "vitest";
import {
    AnchorLength,
    AnchorSpacing,
    AnchorsPerRegion,
    holds,
    identicalShare,
    indexByPage,
    pickOffsets,
    regionMatches,
    seededRandom,
    titlesHolding,
} from "../../../../tools/registry/anchor-collisions.js";

const file = (title, load, bytes) => ({
    title,
    name: `${title}:${load.toString(16)}`,
    load,
    data: Uint8Array.from(bytes),
});
const counting = (length, from = 0) => Array.from({ length }, (_, i) => (from + i) & 0xff);
const anchorsAt = (source, addresses) =>
    addresses.map((address) => ({
        address,
        bytes: source.data.subarray(address - source.load, address - source.load + AnchorLength),
    }));

describe("anchor collisions", () => {
    it("draws the same sample from the same seed", () => {
        const draw = (seed) => Array.from({ length: 5 }, seededRandom(seed));
        expect(draw(1)).toEqual(draw(1));
        expect(draw(1)).not.toEqual(draw(2));
    });

    it("picks runs that aren't fill, spaced apart", () => {
        const offsets = pickOffsets(Uint8Array.from(counting(2048)), seededRandom(1));
        expect(offsets).toHaveLength(AnchorsPerRegion);
        for (const a of offsets)
            for (const b of offsets) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(AnchorSpacing);
        expect(pickOffsets(new Uint8Array(2048).fill(0xe5), seededRandom(1))).toEqual([]);
    });

    it("finds bytes only within a file placed at its load address", () => {
        const f = file("a", 0x1900, counting(16));
        expect(holds(f, 0x1902, [2, 3, 4])).toBe(true);
        expect(holds(f, 0x1903, [2, 3, 4])).toBe(false);
        expect(holds(f, 0x190e, [14, 15, 0])).toBe(false);
        expect(holds(f, 0x18ff, [0, 0])).toBe(false);
    });

    it("counts other titles holding a run, not the run's own", () => {
        const files = [
            file("a", 0x1900, counting(16)),
            file("b", 0x1900, counting(16)),
            file("c", 0x1908, counting(8, 8)),
        ];
        expect([...titlesHolding(indexByPage(files), 0x1908, [8, 9, 10, 11], "a")].sort()).toEqual(["b", "c"]);
    });

    describe("a region's anchors", () => {
        const source = file("a", 0x2000, counting(0x400));
        const anchors = anchorsAt(source, [0x2000, 0x2100, 0x2200]);

        it("match a title when one of its files holds all of them", () => {
            const copy = file("b", 0x2000, counting(0x400));
            const matches = regionMatches(indexByPage([source, copy]), anchors, "a");
            expect([...matches.keys()]).toEqual(["b"]);
            expect(matches.get("b")).toEqual([copy]);
        });

        it("don't match a title whose files each hold only some of them", () => {
            const front = file("b", 0x2000, counting(0x180));
            const back = file("b", 0x2180, counting(0x280, 0x180));
            expect(regionMatches(indexByPage([source, front, back]), anchors, "a").size).toBe(0);
        });
    });

    it("measures the share of the source that's identical at the same addresses", () => {
        const source = file("a", 0x3000, counting(100));
        expect(identicalShare(source, file("b", 0x3000, counting(100)))).toBe(1);
        expect(identicalShare(source, file("b", 0x3000, counting(50)))).toBe(0.5);
        expect(identicalShare(source, file("b", 0x3001, counting(100)))).toBe(0);
    });
});
