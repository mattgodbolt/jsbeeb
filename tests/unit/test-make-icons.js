import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { MaskableMargin, SafeZoneRadius, owlReach, renderIcons } from "../../tools/make-icons.js";

const RepoRoot = path.join(import.meta.dirname, "..", "..");

// Rasterisers may round differently on another CPU; a dot out of place differs by far more.
const MaxChannelDifference = 8;

async function pngPixels(png) {
    return [await sharp(png).raw().toBuffer()];
}

function icoPixels(ico) {
    return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
        const entry = 6 + index * 16;
        const imageStart = ico.readUInt32LE(entry + 12);
        return ico.subarray(imageStart, imageStart + ico.readUInt32LE(entry + 8));
    });
}

function maxDifference(a, b) {
    expect(a.length).toBe(b.length);
    let max = 0;
    for (let i = 0; i < a.length; ++i) max = Math.max(max, Math.abs(a[i] - b[i]));
    return max;
}

describe("make-icons", () => {
    it("has rendered every checked-in icon from the current SVG (npm run icons)", async () => {
        for (const { file, data } of await renderIcons()) {
            const checkedIn = readFileSync(path.join(RepoRoot, file));
            const pixels = file.endsWith(".ico") ? icoPixels : pngPixels;
            const [expected, actual] = await Promise.all([pixels(checkedIn), pixels(data)]);
            expect(actual.length, file).toBe(expected.length);
            for (let i = 0; i < expected.length; ++i) {
                expect(maxDifference(actual[i], expected[i]), file).toBeLessThanOrEqual(MaxChannelDifference);
            }
        }
    });

    it("keeps the maskable owl inside the safe zone by the margin", async () => {
        const maskable = (await renderIcons()).find(({ file }) => file.endsWith("maskable-512.png"));
        const onePixel = 1 / 512;
        expect(await owlReach(maskable.data)).toBeLessThanOrEqual(SafeZoneRadius - MaskableMargin + onePixel);
    });
});
