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
        workspace: { plot_mask: "0xd1", vdu_buffer: "0x1190" },
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
    const overlaid = set({
        title: "Overlaid",
        globals: { work: "0x70" },
        regions: {
            code: {
                ...region(0x2000, 0x2100, 0x2000, { aim: "0x2010", explode: "0x2080" }),
                scopes: [
                    { start: "0x2010", end: "0x2080", symbols: { target_x: "0x70", target_y: "0x71" } },
                    {
                        start: "0x2080",
                        end: "0x20c0",
                        symbols: { blast_x: "0x70", blast_entry: "0x2080", over_main: "0x1100" },
                    },
                ],
            },
        },
    });
    const sidewaysRom = set({
        title: "Sideways ROM",
        workspace: { net_tx_ptr: "0x70", rom_buffer: "0x1b80" },
        regions: { rom: region(0x8000, 0xc000, 0x8000, { service: "0x8003" }) },
    });
    const LoaderCode = 0x910;
    const GameCode = 0x1200;
    const MosCode = 0xe000;
    const RomCode = 0x8100;
    const UncoveredCode = 0x5000;

    beforeEach(() => {
        memory = new Uint8Array(0x10000);
        for (const at of [0xc000, 0x900, 0x1100, 0x1a00, 0x2000, 0x8000]) anchor(at);
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

        it("take the names of the scope the instruction is in before any other", () => {
            const names = namesFrom(mos, game, overlaid);
            expect(nameOf(names.operand(0x2090, 0x2080))).toBe("blast_entry from Overlaid");
            expect(nameOf(names.operand(0x20c0, 0x2080))).toBe("explode from Overlaid");
            expect(nameOf(names.operand(0x2090, 0x1100))).toBe("over_main from Overlaid");
            expect(nameOf(names.operand(0x20c0, 0x1100))).toBe("main_loop from Game");
            expect(nameOf(names.operand(0x2020, 0x70))).toBe("target_x from Overlaid");
            expect(nameOf(names.operand(0x2020, 0x71))).toBe("target_y from Overlaid");
            expect(nameOf(names.operand(0x2090, 0x70))).toBe("blast_x from Overlaid");
            expect(nameOf(names.operand(0x2090, 0x71))).toBeUndefined();
            expect(nameOf(names.operand(0x20c0, 0x70))).toBe("work from Overlaid");
            breakAnchor(0x2000);
            expect(nameOf(namesFrom(mos, overlaid).operand(0x2020, 0x70))).toBe("scratch from MOS");
        });

        it("ignore a system set's scopes", () => {
            const scopedMos = set({
                title: "Scoped MOS",
                system: true,
                globals: { scratch: "0x70" },
                regions: {
                    rom: {
                        ...region(0xc000, 0x10000, 0xc000),
                        scopes: [{ start: "0xe000", end: "0xe100", symbols: { mos_temp: "0x70" } }],
                    },
                },
            });
            const names = namesFrom(scopedMos);
            expect(nameOf(names.operand(MosCode, 0x70))).toBe("scratch from Scoped MOS");
            expect(names.address(0x70, MosCode)?.name).toBe("scratch");
        });

        it("take the system set's workspace names only in the system set's own code", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.operand(MosCode, 0xd1))).toBe("plot_mask from MOS");
            expect(names.operand(UncoveredCode, 0xd1)).toBeUndefined();
            expect(names.operand(GameCode, 0xd1)).toBeUndefined();
        });

        it("never take a workspace name inside a non-system set's matching region", () => {
            expect(namesFrom(mos, game).operand(MosCode, 0x1190)).toBeUndefined();
            breakAnchor(0x1100);
            expect(nameOf(namesFrom(mos, game).operand(MosCode, 0x1190))).toBe("vdu_buffer from MOS");
        });

        it("take a non-system set's workspace names only in that set's own code", () => {
            const names = namesFrom(mos, game, sidewaysRom);
            expect(nameOf(names.operand(RomCode, 0x70))).toBe("net_tx_ptr from Sideways ROM");
            expect(nameOf(names.operand(RomCode, 0x1b80))).toBe("rom_buffer from Sideways ROM");
            expect(names.operand(GameCode, 0x1b80)).toBeUndefined();
            expect(names.operand(UncoveredCode, 0x1b80)).toBeUndefined();
            expect(nameOf(names.operand(GameCode, 0x70))).toBe("lives from Game");
            expect(nameOf(names.operand(UncoveredCode, 0x70))).toBe("scratch from MOS");
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

        it("takes the global of the set whose code the CPU is in, over another set's", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x70, GameCode))).toBe("lives from Game");
            expect(nameOf(names.address(0x70, LoaderCode))).toBe("pointer from Loader");
            expect(nameOf(namesFrom(mos, game, overlaid).address(0x1100, 0x2090))).toBe("main_loop from Game");
            expect(nameOf(names.address(0x3000, GameCode))).toBe("screen from Game");
        });

        it("takes the name of the scope the CPU is in, over its set's global", () => {
            const names = namesFrom(mos, loader, overlaid);
            expect(nameOf(names.address(0x70, 0x2090))).toBe("blast_x from Overlaid");
            expect(nameOf(names.address(0x70, 0x20c0))).toBe("work from Overlaid");
            expect(nameOf(names.address(0x70, LoaderCode))).toBe("pointer from Loader");
            expect(nameOf(namesFrom(mos, game, overlaid).address(0x1100, 0x2090))).toBe("main_loop from Game");
        });

        it("takes no name for a clash while the CPU is in the system set's code or no set's", () => {
            const names = namesFrom(mos, loader, game);
            expect(names.address(0x70, MosCode)).toBeUndefined();
            expect(names.address(0x70, UncoveredCode)).toBeUndefined();
        });

        it("falls back to the other sets when the one the CPU is in doesn't name it", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x2e00, GameCode))).toBe("catalogue from Loader");
            expect(nameOf(names.address(0x20e, GameCode))).toBe("wrchv from MOS");
        });

        it("takes a system global when no non-system set names it", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0x20e))).toBe("wrchv from MOS");
            breakAnchor(0x900);
            breakAnchor(0x1100);
            breakAnchor(0x1a00);
            expect(nameOf(namesFrom(mos, loader, game).address(0x70))).toBe("scratch from MOS");
        });

        it("takes a workspace name only while the CPU is in its set's code", () => {
            const names = namesFrom(mos, loader, game);
            expect(nameOf(names.address(0xd1, MosCode))).toBe("plot_mask from MOS");
            expect(names.address(0xd1, UncoveredCode)).toBeUndefined();
            expect(names.address(0xd1, GameCode)).toBeUndefined();
            expect(names.address(0xd1)).toBeUndefined();
        });

        it("takes the workspace name of the system set the CPU is in, over a non-system set's global", () => {
            const takeover = set({
                title: "Takeover",
                globals: { ship_x: "0xd1" },
                regions: { main: region(0x4000, 0x4100, 0x4000) },
            });
            anchor(0x4000);
            const names = namesFrom(mos, takeover);
            expect(nameOf(names.address(0xd1, MosCode))).toBe("plot_mask from MOS");
            expect(nameOf(names.address(0xd1, 0x4010))).toBe("ship_x from Takeover");
            expect(nameOf(names.address(0xd1, UncoveredCode))).toBe("ship_x from Takeover");
        });

        it("takes a non-system set's workspace name only while the CPU is in its code, not while it merely matches", () => {
            const names = namesFrom(mos, game, sidewaysRom);
            expect(nameOf(names.address(0x70, RomCode))).toBe("net_tx_ptr from Sideways ROM");
            expect(nameOf(names.address(0x1b80, RomCode))).toBe("rom_buffer from Sideways ROM");
            expect(nameOf(names.address(0x70, GameCode))).toBe("lives from Game");
            expect(nameOf(names.address(0x70, UncoveredCode))).toBe("lives from Game");
            expect(nameOf(names.address(0x70))).toBe("lives from Game");
            expect(names.address(0x1b80, GameCode)).toBeUndefined();
            expect(names.address(0x1b80)).toBeUndefined();
        });

        it("takes a non-system set's globals only while one of its regions matches", () => {
            breakAnchor(0x900);
            expect(namesFrom(mos, loader, game).address(0x2e00)).toBeUndefined();
        });
    });

    describe("the region an address is in", () => {
        const regionOf = (names, address) => {
            const found = names.regionAt(address);
            return found && `${found.region.name} from ${found.set.title}`;
        };

        it("is the matching region holding it, from its first address to its last", () => {
            const names = namesFrom(mos, loader, game);
            expect(regionOf(names, 0x1100)).toBe("main from Game");
            expect(regionOf(names, 0x19ff)).toBe("main from Game");
            expect(regionOf(names, 0x1a00)).toBe("startup from Game");
            expect(regionOf(names, 0xffff)).toBe("rom from MOS");
            expect(regionOf(names, 0x70)).toBeUndefined();
        });

        it("is none where the region doesn't match", () => {
            breakAnchor(0x1a00);
            expect(regionOf(namesFrom(mos, game), 0x1a00)).toBeUndefined();
        });
    });

    describe("a name's address", () => {
        it("finds a global or a region's name in the sets that match", () => {
            const names = namesFrom(mos, loader, game);
            expect(names.addressOf("catalogue")).toBe(0x2e00);
            expect(names.addressOf("read_whole_run")).toBe(0x916);
            expect(names.addressOf("oswrch")).toBe(0xffee);
            expect(names.addressOf("wrchv")).toBe(0x20e);
            expect(names.addressOf("plot_mask", UncoveredCode)).toBe(0xd1);
            expect(names.addressOf("nobody")).toBeUndefined();
        });

        it("finds nothing from a set or region that doesn't match", () => {
            breakAnchor(0x900);
            const names = namesFrom(mos, loader, game);
            expect(names.addressOf("catalogue")).toBeUndefined();
            expect(names.addressOf("read_whole_run")).toBeUndefined();
            breakAnchor(0x1a00);
            expect(namesFrom(mos, game).addressOf("init")).toBeUndefined();
        });

        it("finds a scope's name wherever the CPU is", () => {
            const names = namesFrom(mos, overlaid);
            expect(names.addressOf("blast_x", 0x2090)).toBe(0x70);
            expect(names.addressOf("target_y", UncoveredCode)).toBe(0x71);
        });

        it("goes to the address of the scope the CPU is in when two scopes give a name different addresses", () => {
            const routines = set({
                title: "Routines",
                regions: {
                    code: {
                        ...region(0x2000, 0x2100, 0x2000),
                        scopes: [
                            { start: "0x2010", end: "0x2080", symbols: { tmp: "0x70" } },
                            { start: "0x2080", end: "0x20c0", symbols: { tmp: "0x72" } },
                        ],
                    },
                },
            });
            const names = namesFrom(routines);
            expect(names.addressOf("tmp", 0x2090)).toBe(0x72);
            expect(names.addressOf("tmp", 0x2020)).toBe(0x70);
            expect(names.addressOf("tmp", UncoveredCode)).toBe(0x70);
        });

        it("finds no name from a system set's scopes, which are ignored", () => {
            const scopedMos = set({
                title: "Scoped MOS",
                system: true,
                regions: {
                    rom: {
                        ...region(0xc000, 0x10000, 0xc000),
                        scopes: [{ start: "0xc000", end: "0xc100", symbols: { vdu_temp: "0xda" } }],
                    },
                },
            });
            expect(namesFrom(scopedMos).addressOf("vdu_temp", 0xc010)).toBeUndefined();
        });

        it("goes to the address shown by that name when two sets give it different addresses", () => {
            const sequel = set({
                title: "Sequel",
                globals: { lives: "0x80" },
                regions: { main: region(0x4000, 0x4100, 0x4000) },
            });
            anchor(0x4000);
            const names = namesFrom(mos, game, sequel);
            expect(names.addressOf("lives", GameCode)).toBe(0x70);
            expect(names.addressOf("lives", 0x4010)).toBe(0x80);
            expect(names.addressOf("lives")).toBe(0x70);
        });
    });
});
