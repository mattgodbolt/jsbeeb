import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createZipBlob } from "../../../../src/archive.js";
import { fingerprint } from "../../../../tools/registry/fingerprint.js";
import { SymbolsDir } from "../../../../tools/symbols/build-index.js";
import {
    fetchDisc,
    loadTitleSets,
    matchingRegions,
    overlappingRegions,
} from "../../../../tools/symbols/check-memory.js";
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
        tail: anchored("0x20ff", "0x2200", "0x2100", "a9018d02"),
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
        expect(overlappingRegions(sets, ["cheat/far", "cheat/tail"])).toEqual(["cheat/far and cheat/tail"]);
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

describe("fetchDisc", () => {
    const url = "https://example.com/demo.zip";
    const image = "Games/Demo.ssd";
    const disc = new Uint8Array(0x400).map((_, i) => i * 7);
    const { discKey } = fingerprint(image, disc);

    afterEach(() => vi.restoreAllMocks());

    const serving = (files) =>
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(createZipBlob(files)));

    it("takes the named image out of the zip when its key is the config's", async () => {
        serving([{ name: image, data: disc }]);
        expect(await fetchDisc({ url, image, key: discKey })).toEqual(disc);
    });

    it("refuses an image whose key isn't the config's, or a zip without it", async () => {
        serving([{ name: image, data: disc }]);
        await expect(fetchDisc({ url, image, key: "0".repeat(32) })).rejects.toThrow(`is image ${discKey}`);
        await expect(fetchDisc({ url, image: "Other.ssd", key: discKey })).rejects.toThrow("holds no Other.ssd");
    });
});
