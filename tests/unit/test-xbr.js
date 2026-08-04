import { describe, it, expect } from "vitest";
import { xbrUpscale, makePixelImage } from "../../src/video-filters/xbr.js";

const Black = 0xff000000;
const White = 0xffffffff;
const Red = 0xff0000ff;
const Blue = 0xffff0000;

function imageFrom(rows, palette) {
    const height = rows.length;
    const width = rows[0].length;
    const image = makePixelImage(width, height);
    rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            image.data[y * width + x] = palette[ch];
        });
    });
    return image;
}

const upscale = (src, factor) => xbrUpscale(src, makePixelImage(src.width * factor, src.height * factor));

const distinctColours = (image) => new Set(image.data);

describe("xBR-lv2 upscaler", () => {
    it("leaves a solid area completely alone", () => {
        const src = imageFrom(["....", "....", "....", "...."], { ".": Red });
        const out = upscale(src, 2);
        expect([...distinctColours(out)]).toEqual([Red]);
    });

    it("does not blur a straight vertical edge", () => {
        // A vertical edge is already perfectly representable at any scale, so
        // xBR must leave it hard — this is the property that separates it from
        // bilinear filtering.
        const src = imageFrom(["##..", "##..", "##..", "##.."], { "#": White, ".": Black });
        const out = upscale(src, 4);
        expect([...distinctColours(out)].sort()).toEqual([White, Black].sort());
    });

    it("does not blur a straight horizontal edge", () => {
        const src = imageFrom(["####", "####", "....", "...."], { "#": White, ".": Black });
        const out = upscale(src, 4);
        expect([...distinctColours(out)].sort()).toEqual([White, Black].sort());
    });

    it("introduces intermediate colours along a diagonal edge", () => {
        const src = imageFrom(["#...", "##..", "###.", "####"], { "#": White, ".": Black });
        const out = upscale(src, 4);
        const colours = distinctColours(out);
        expect(colours.size).toBeGreaterThan(2);
        // Every new colour must lie between the two originals, not be invented.
        for (const word of colours) {
            const red = word & 0xff;
            expect((word >>> 8) & 0xff).toBe(red);
            expect((word >>> 16) & 0xff).toBe(red);
        }
    });

    it("softens the staircase of a shallow diagonal", () => {
        // A 2:1 slope: rows step across by two pixels at a time.
        const rows = [];
        for (let y = 0; y < 8; ++y) rows.push("".padEnd(2 * y + 1, "#").padEnd(16, "."));
        const src = imageFrom(rows, { "#": White, ".": Black });
        const out = upscale(src, 3);
        expect(distinctColours(out).size).toBeGreaterThan(2);
    });

    it("blends towards the colours actually present at the edge", () => {
        const src = imageFrom(["#...", "##..", "###.", "####"], { "#": Red, ".": Blue });
        const out = upscale(src, 4);
        for (const word of distinctColours(out)) {
            // Red is 0x0000ff, blue is 0xff0000 in framebuffer order; a blend of
            // the two never has a green component.
            expect((word >>> 8) & 0xff).toBe(0);
        }
    });

    it("chamfers an isolated single pixel but keeps its core", () => {
        // xBR rounds the corners of a lone pixel — a MODE 0 full stop, say —
        // rather than leaving it square. It stays solid in the middle and does
        // not bleed outside its own cell, so the effect is a chamfer and not a
        // blur, but it is a real difference from hqx and is worth knowing about
        // when judging text-heavy modes.
        const src = imageFrom([".....", ".....", "..#..", ".....", "....."], { "#": White, ".": Black });
        const scale = 4;
        const out = upscale(src, scale);
        const cell = [];
        for (let y = 2 * scale; y < 3 * scale; ++y)
            for (let x = 2 * scale; x < 3 * scale; ++x) cell.push(out.data[y * out.width + x]);
        expect(cell.filter((word) => word === White)).toHaveLength(scale * scale - 4);
        expect(cell.filter((word) => word !== White && word !== Black)).toHaveLength(4);

        // Nothing outside the source pixel's own cell is touched.
        const outside = [...out.data].filter((_word, index) => {
            const x = index % out.width;
            const y = Math.floor(index / out.width);
            return x < 2 * scale || x >= 3 * scale || y < 2 * scale || y >= 3 * scale;
        });
        expect(new Set(outside)).toEqual(new Set([Black]));
    });

    it("handles non-square and non-integer scale factors", () => {
        const src = imageFrom(["#...", "##..", "###.", "####"], { "#": White, ".": Black });
        const out = xbrUpscale(src, makePixelImage(37, 11));
        expect(out.data).toHaveLength(37 * 11);
        expect(distinctColours(out).size).toBeGreaterThan(2);
    });

    it("clamps at the image edges rather than sampling off the end", () => {
        const src = imageFrom(["#.", ".#"], { "#": White, ".": Black });
        const out = upscale(src, 3);
        expect(out.data.every((word) => word >>> 24 === 0xff)).toBe(true);
    });

    it("reproduces the source exactly at 1:1 for an image with no edges to fix", () => {
        const src = imageFrom(["##..", "##..", "..##", "..##"], { "#": White, ".": Black });
        const out = xbrUpscale(src, makePixelImage(4, 4));
        // The centre is a checkerboard corner; xBR's corner rules leave the
        // 2x2 blocks themselves untouched even though it rounds the junction.
        expect(out.data[0]).toBe(White);
        expect(out.data[3]).toBe(Black);
        expect(out.data[12]).toBe(Black);
        expect(out.data[15]).toBe(White);
    });
});
