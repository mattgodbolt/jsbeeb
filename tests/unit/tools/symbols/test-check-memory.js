import path from "node:path";
import { describe, expect, it } from "vitest";

import { SymbolsDir } from "../../../../tools/symbols/build-index.js";
import { loadTitleSets, matchingRegions, overlappingRegions } from "../../../../tools/symbols/check-memory.js";
import { parseSet } from "../../../../src/symbol-sets.js";

const set = (regions) => parseSet({ format: 1, title: "t", licence: "CC0-1.0", source: "s", regions });
const anchored = (start, end, at, bytes) => ({
    start,
    end,
    minAnchors: 1,
    anchors: [{ at, bytes }],
});

const sets = {
    loader: set({ main: anchored("0x0400", "0x043c", "0x0400", "a9008d01") }),
    cheat: set({
        decrypted: anchored("0x043b", "0x0500", "0x0440", "a2058e02"),
        far: anchored("0x2000", "0x2100", "0x2000", "deadbeef"),
    }),
};

const memoryWith = (writes) => {
    const memory = new Uint8Array(0x10000);
    for (const [at, bytes] of writes) memory.set(bytes, at);
    return (address) => memory[address];
};

describe("matchingRegions", () => {
    it("lists every region whose anchors all match, by set and region", () => {
        const peek = memoryWith([
            [0x0400, [0xa9, 0x00, 0x8d, 0x01]],
            [0x2000, [0xde, 0xad, 0xbe, 0xef]],
        ]);
        expect(matchingRegions(sets, peek)).toEqual(["cheat/far", "loader/main"]);
    });
});

describe("overlappingRegions", () => {
    it("pairs matching regions over the same addresses, whichever sets they're in", () => {
        expect(overlappingRegions(sets, ["cheat/decrypted", "loader/main", "cheat/far"])).toEqual([
            "cheat/decrypted and loader/main",
        ]);
        expect(overlappingRegions(sets, ["cheat/far", "loader/main"])).toEqual([]);
    });
});

describe("loadTitleSets", () => {
    it("reads a title's shipped sets by their ids", () => {
        const pipeline = loadTitleSets(path.join(SymbolsDir, "sets"), "pipeline");
        expect(Object.keys(pipeline)).toContain("game");
        expect(Object.keys(pipeline)).not.toContain("bbc-b-mos-1.20");
        expect(pipeline.game.regions.map(({ name }) => name)).toContain("main_high");
    });
});
