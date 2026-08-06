import { describe, it, expect, beforeAll } from "vitest";
import { buildPattern, renderPatterns } from "./render.js";

// These assert the xBR shader's behaviour by running the shader itself: the
// GLSL is what ships, and Node cannot execute it, so the patterns are drawn in
// headless Chrome and the pixels read back. The properties below are the ones
// the feature actually promises — hard edges stay hard, diagonals gain
// intermediate shades, and a mode's texel geometry makes no difference to the
// result.

const Black = 0xff000000;
const White = 0xffffffff;
const Red = 0xff0000ff;
const Blue = 0xffff0000;

/** Eight-bit rounding through the shader; colours meant to be equal land within this. */
const Tolerance = 2;

const Patterns = [
    { name: "solid", rows: ["....", "....", "....", "...."], palette: { ".": Red } },
    { name: "vertical", rows: ["##..", "##..", "##..", "##.."], palette: { "#": White, ".": Black } },
    { name: "horizontal", rows: ["####", "####", "....", "...."], palette: { "#": White, ".": Black } },
    { name: "diagonal", rows: ["#...", "##..", "###.", "####"], palette: { "#": White, ".": Black } },
    { name: "colourDiagonal", rows: ["#...", "##..", "###.", "####"], palette: { "#": Red, ".": Blue } },
    {
        name: "shallowDiagonal",
        // A 2:1 slope: each row steps across by two pixels.
        rows: Array.from({ length: 8 }, (_unused, y) => "".padEnd(2 * y + 1, "#").padEnd(16, ".")),
        palette: { "#": White, ".": Black },
        scale: 3,
    },
    {
        name: "lonePixel",
        rows: [".....", ".....", "..#..", ".....", "....."],
        palette: { "#": White, ".": Black },
    },
    // The same picture as `diagonal`, but drawn with the texel geometry of the
    // wider modes and with the usual scanline doubling. The shader must see
    // through all of that to the same logical pixels.
    {
        name: "diagonalMode1",
        rows: ["#...", "##..", "###.", "####"],
        palette: { "#": White, ".": Black },
        texelsWide: 2,
    },
    {
        name: "diagonalMode2",
        rows: ["#...", "##..", "###.", "####"],
        palette: { "#": White, ".": Black },
        texelsWide: 4,
    },
    {
        name: "diagonalDoubled",
        rows: ["#...", "##..", "###.", "####"],
        palette: { "#": White, ".": Black },
        texelsHigh: 2,
    },
];

const rgbOf = (word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];

/** Every output pixel, as [r, g, b, a]. */
function* eachPixel(image) {
    for (let i = 0; i < image.width * image.height; ++i) yield [...image.data.subarray(i * 4, i * 4 + 4)];
}

function pixelAt(image, x, y) {
    const offset = (y * image.width + x) * 4;
    return [...image.data.subarray(offset, offset + 4)];
}

const isColour = (pixel, word) => rgbOf(word).every((channel, i) => Math.abs(pixel[i] - channel) <= Tolerance);

/** Pixels matching none of the source colours: the shades xBR invented. */
const intermediates = (image, ...words) => [...eachPixel(image)].filter((p) => !words.some((w) => isColour(p, w)));

describe("xBR shader", () => {
    let rendered;

    beforeAll(() => {
        rendered = renderPatterns(Patterns.map(buildPattern));
    }, 180000);

    it("leaves a solid area completely alone", () => {
        for (const pixel of eachPixel(rendered.solid)) expect(isColour(pixel, Red)).toBe(true);
    });

    it.each([["vertical"], ["horizontal"]])("does not blur a straight %s edge", (name) => {
        // A straight edge is already exactly representable at any scale, so xBR
        // must leave it hard. This is the property separating it from bilinear.
        expect(intermediates(rendered[name], White, Black)).toHaveLength(0);
    });

    it("introduces intermediate shades along a diagonal edge", () => {
        const image = rendered.diagonal;
        expect(intermediates(image, White, Black).length).toBeGreaterThan(0);
        // Every invented shade must lie between the two originals, not be a
        // colour of its own: between black and white, that means grey.
        for (const [r, g, b] of eachPixel(image)) {
            expect(g).toBe(r);
            expect(b).toBe(r);
        }
    });

    it("softens the staircase of a shallow diagonal", () => {
        expect(intermediates(rendered.shallowDiagonal, White, Black).length).toBeGreaterThan(0);
    });

    it("blends towards the colours actually present at the edge", () => {
        // Red and blue have no green between them, so any green would be a
        // colour xBR invented rather than one it found.
        for (const [, g] of eachPixel(rendered.colourDiagonal)) expect(g).toBeLessThanOrEqual(Tolerance);
        expect(intermediates(rendered.colourDiagonal, Red, Blue).length).toBeGreaterThan(0);
    });

    it("chamfers an isolated single pixel without bleeding outside it", () => {
        // xBR rounds the corners of a lone pixel — a MODE 0 full stop, say —
        // rather than leaving it square. Worth knowing when judging text-heavy
        // modes: it is a real difference from hqx.
        const image = rendered.lonePixel;
        const scale = image.width / 5;
        const inCell = (x, y) => x >= 2 * scale && x < 3 * scale && y >= 2 * scale && y < 3 * scale;

        // Solid in the middle, but not solid throughout: the corners are cut.
        expect(isColour(pixelAt(image, 2.5 * scale, 2.5 * scale), White)).toBe(true);
        const cell = [];
        for (let y = 2 * scale; y < 3 * scale; ++y)
            for (let x = 2 * scale; x < 3 * scale; ++x) cell.push(pixelAt(image, x, y));
        expect(cell.filter((pixel) => !isColour(pixel, White)).length).toBeGreaterThan(0);

        for (let y = 0; y < image.height; ++y)
            for (let x = 0; x < image.width; ++x)
                if (!inCell(x, y)) expect(isColour(pixelAt(image, x, y), Black)).toBe(true);
    });

    it("renders every pixel fully opaque", () => {
        for (const [, , , a] of eachPixel(rendered.diagonal)) expect(a).toBe(0xff);
    });

    describe("logical pixel grid", () => {
        // The point of the whole mechanism: the framebuffer is a raster in which
        // one BBC pixel spans up to eight texels across and two down, and the
        // shader has to reconstruct from the pixels rather than the texels. Draw
        // the same picture with each mode's geometry and the output must match.
        it.each([
            ["two texels wide, as MODE 1", "diagonalMode1"],
            ["four texels wide, as MODE 2", "diagonalMode2"],
            ["with doubled scanlines", "diagonalDoubled"],
        ])("gives the same result when a pixel is %s", (_name, variant) => {
            const expected = rendered.diagonal;
            const actual = rendered[variant];
            expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);

            let worst = 0;
            for (let i = 0; i < expected.data.length; ++i)
                worst = Math.max(worst, Math.abs(expected.data[i] - actual.data[i]));
            expect(worst).toBeLessThanOrEqual(Tolerance);
        });
    });
});
