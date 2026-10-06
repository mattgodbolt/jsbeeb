import { beforeEach, describe, expect, it } from "vitest";

import { matchRegions, regionMatches, SymbolNames } from "../../src/symbol-names.js";
import { parseSet } from "../../src/symbol-sets.js";

const set = (json) => parseSet({ format: 1, licence: "CC0-1.0", source: "a test", ...json });

const region = (start, end, anchorAt, symbols = {}) => ({
    start: `0x${start.toString(16)}`,
    end: `0x${end.toString(16)}`,
    anchors: [{ at: `0x${anchorAt.toString(16)}`, bytes: "a9008d01" }],
    symbols,
});

describe("symbol names", () => {
    let memory;
    const peek = (address) => memory[address];
    const anchor = (at) => memory.set([0xa9, 0x00, 0x8d, 0x01], at);
    const breakAnchor = (at) => (memory[at] = 0xea);
    const namesFrom = (...sets) =>
        new SymbolNames([...matchRegions(sets, peek)].map(([matched, regions]) => ({ set: matched, regions })));
    const nameOf = (named) => named && `${named.name} from ${named.set.title}`;

    const mos = set({
        title: "MOS",
        system: true,
        globals: { scratch: "0x70", os_text_ptr: "0xf2", wrchv: "0x20e", vdu_queue: "0x1180" },
        regions: { rom: region(0xc000, 0x10000, 0xc000, { oswrch: "0xffee" }) },
    });
    const loader = set({
        title: "Loader",
        globals: { pointer: "0x70", level_buffer: "0x1800", screen: "0x3000", catalogue: "0x2e00" },
        regions: { stub: region(0x900, 0xa00, 0x900, { read_whole_run: "0x916" }) },
    });
    const game = set({
        title: "Game",
        globals: { lives: "0x70", objects: "0x1a00", screen: "0x3000" },
        regions: {
            main: region(0x1100, 0x1a00, 0x1100, { main_loop: "0x1100", sprites: "0x1800" }),
            startup: region(0x1a00, 0x1b00, 0x1a00, { init: "0x1a00" }),
        },
    });
    const LoaderCode = 0x910;
    const GameCode = 0x1200;
    const MosCode = 0xe000;
    const UncoveredCode = 0x5000;

    beforeEach(() => {
        memory = new Uint8Array(0x10000);
        for (const at of [0xc000, 0x900, 0x1100, 0x1a00]) anchor(at);
    });

    describe("matching", () => {
        const twoAnchors = (minAnchors) =>
            set({
                regions: {
                    code: {
                        ...region(0x2000, 0x2100, 0x2000),
                        minAnchors,
                        anchors: [
                            { at: "0x2000", bytes: "a9008d01" },
                            { at: "0x2010", bytes: "a9008d01" },
                        ],
                    },
                },
            }).regions[0];

        it("needs every anchor to match, and at least minAnchors of them", () => {
            anchor(0x2000);
            anchor(0x2010);
            expect(regionMatches(twoAnchors(2), peek)).toBe(true);
            expect(regionMatches(twoAnchors(3), peek)).toBe(false);
            breakAnchor(0x2013);
            expect(regionMatches(twoAnchors(1), peek)).toBe(false);
        });

        it("never matches a region without anchors", () => {
            const bare = set({ regions: { data: { start: "0x2000", end: "0x2100" } } }).regions[0];
            expect(regionMatches(bare, peek)).toBe(false);
        });

        it("shows neither of two sets whose regions match over the same addresses", () => {
            const rival = set({
                title: "Rival",
                regions: { main: region(0x1000, 0x1200, 0x1100, { rival: "0x1100" }) },
            });
            const names = namesFrom(mos, game, rival);
            expect(names.sets.map(({ title }) => title)).toEqual(["MOS", "Game"]);
            expect(names.address(0x1100)).toBeUndefined();
            expect(nameOf(names.address(0x1a00))).toBe("init from Game");
        });

        it("shows neither of a set's own regions that match over the same addresses", () => {
            const overlays = set({
                title: "Overlays",
                globals: { flag: "0x80" },
                regions: {
                    one: region(0x2000, 0x2100, 0x2000, { one: "0x2000" }),
                    two: region(0x2000, 0x2100, 0x2000, { two: "0x2000" }),
                },
            });
            anchor(0x2000);
            const names = namesFrom(overlays);
            expect(names.sets).toEqual([]);
            expect(names.address(0x2000)).toBeUndefined();
            expect(names.address(0x80)).toBeUndefined();
        });
    });

    describe("an instruction's operands", () => {
        it("take names from the instruction's own set first", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.operand(LoaderCode, 0x70))).toBe("pointer from Loader");
            expect(nameOf(names.operand(GameCode, 0x70))).toBe("lives from Game");
            expect(nameOf(names.operand(LoaderCode, 0x916))).toBe("read_whole_run from Loader");
        });

        it("take a region's name over its set's global, and the global once the region stops matching", () => {
            expect(nameOf(namesFrom(mos, game).operand(GameCode, 0x1a00))).toBe("init from Game");
            breakAnchor(0x1a00);
            expect(nameOf(namesFrom(mos, game).operand(GameCode, 0x1a00))).toBe("objects from Game");
        });

        it("take another set's region names after their own set's globals", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.operand(LoaderCode, 0x1100))).toBe("main_loop from Game");
            expect(nameOf(names.operand(LoaderCode, 0x1800))).toBe("level_buffer from Loader");
            expect(nameOf(names.operand(GameCode, 0x1800))).toBe("sprites from Game");
        });

        it("take a set's globals only in that set's code", () => {
            const names = namesFrom(mos, loader, game);
            expect(names.operand(GameCode, 0x2e00)).toBeUndefined();
            expect(names.operand(UncoveredCode, 0x2e00)).toBeUndefined();
        });

        it("take the system set's globals last, in code no set covers too", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.operand(UncoveredCode, 0x70))).toBe("scratch from MOS");
            expect(nameOf(names.operand(UncoveredCode, 0x20e))).toBe("wrchv from MOS");
            expect(nameOf(names.operand(UncoveredCode, 0xffee))).toBe("oswrch from MOS");
            expect(nameOf(names.operand(GameCode, 0x20e))).toBe("wrchv from MOS");
            expect(nameOf(names.operand(MosCode, 0xf2))).toBe("os_text_ptr from MOS");
        });

        it("never take a system global inside a non-system set's matching region, even in the system's code", () => {
            expect(namesFrom(mos, game).operand(UncoveredCode, 0x1180)).toBeUndefined();
            expect(namesFrom(mos, game).operand(MosCode, 0x1180)).toBeUndefined();
            expect(nameOf(namesFrom(mos, game).operand(MosCode, 0x1100))).toBe("main_loop from Game");
            breakAnchor(0x1100);
            expect(nameOf(namesFrom(mos, game).operand(UncoveredCode, 0x1180))).toBe("vdu_queue from MOS");
        });

        it("take no system globals while no region of the system set matches", () => {
            breakAnchor(0xc000);
            expect(namesFrom(mos, game).operand(GameCode, 0x20e)).toBeUndefined();
        });
    });

    describe("an address on its own", () => {
        it("inside a matching region, takes only that region's names", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x916))).toBe("read_whole_run from Loader");
            expect(nameOf(names.address(0x1a00))).toBe("init from Game");
            expect(names.address(0x1180)).toBeUndefined();
            expect(nameOf(names.address(0xffee))).toBe("oswrch from MOS");
        });

        it("outside every matching region, takes the global of the one non-system set that names it", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x2e00))).toBe("catalogue from Loader");
            expect(nameOf(names.address(0x3000))).toBe("screen from Loader");
            breakAnchor(0x1a00);
            expect(nameOf(namesFrom(mos, game).address(0x1a00))).toBe("objects from Game");
        });

        it("takes no name when two non-system sets name it differently, not even the system set's", () => {
            expect(namesFrom(mos, loader, game).address(0x70)).toBeUndefined();
            breakAnchor(0x900);
            expect(nameOf(namesFrom(mos, loader, game).address(0x70))).toBe("lives from Game");
        });

        it("takes a system global when no non-system set names it", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x20e))).toBe("wrchv from MOS");
            breakAnchor(0x900);
            breakAnchor(0x1100);
            breakAnchor(0x1a00);
            expect(nameOf(namesFrom(mos, loader, game).address(0x70))).toBe("scratch from MOS");
        });

        it("takes a non-system set's globals only while one of its regions matches", () => {
            breakAnchor(0x900);
            expect(namesFrom(mos, loader, game).address(0x2e00)).toBeUndefined();
        });
    });
});
