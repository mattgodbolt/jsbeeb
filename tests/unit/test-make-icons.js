import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { MaskableMargin, SafeZoneRadius, renderIcons } from "../../tools/make-icons.js";

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

/** How far the owl's pixels reach from the image's centre, as a fraction of its size. The corner pixel is background. */
async function renderedReach(png) {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const centre = width / 2;
    let reach = 0;
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const pixel = (y * width + x) * channels;
            if (data.compare(data, 0, channels, pixel, pixel + channels) === 0) continue;
            reach = Math.max(reach, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
        }
    }
    return reach / width;
}

describe("make-icons", () => {
    let icons;
    beforeAll(async () => {
        icons = await renderIcons();
    });

    it("has rendered every checked-in icon from the current SVG (npm run icons)", async () => {
        for (const { file, data } of icons) {
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
        const maskable = icons.find(({ file }) => file.endsWith("maskable-512.png"));
        // An anti-aliased edge pixel's centre lies up to 0.71 px past the edge, and an odd border puts the owl half a
        // pixel off centre.
        const edgeSlack = 1.5 / 512;
        expect(await renderedReach(maskable.data)).toBeLessThanOrEqual(SafeZoneRadius - MaskableMargin + edgeSlack);
    });
});
