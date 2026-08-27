import { describe, it, expect, beforeAll } from "vitest";
import { buildPattern, eachPixel, pixelAt, renderJobs, TextureSize } from "./render.js";
import { encodeLineGrid, LineGridRows } from "../../src/video-filters/pixel-grid.js";

// These assert the xBR shader's behaviour by running the shader itself: the
// GLSL is what ships, and Node cannot execute it, so the patterns are drawn in
// headless Chrome and the pixels read back. The properties below are the ones
// the feature actually promises — hard edges stay hard, diagonals gain
// intermediate shades, and a mode's texel geometry makes no difference to the
// result.
//
// Assertions say where a colour is, not merely which colours are present. "Only
// black and white came back" is equally true of a picture drawn entirely in
// black, and an upscaler that returned its input flipped would satisfy every
// symmetric pattern here.

const Black = 0xff000000;
const White = 0xffffffff;
const Red = 0xff0000ff;
const Blue = 0xffff0000;

/** Eight-bit rounding through the shader; colours meant to be equal land within this. */
const Tolerance = 2;

const Scale = 4;

/**
 * Logical pixels drawn around the picture and then cropped off. The last row of
 * fragments in a drawn quad picks up a blend even where the picture either side
 * of it is uniform, so the picture's own edges are kept away from the quad's.
 */
const Margin = 1;

/** xBR reads a 5x5 neighbourhood, so the outermost pixel of the picture needs two more beyond it. */
const Padding = Margin + 2;

/** WebGL setup as XbrFilter does it; see render.js for why these run in the page. */
const XbrHarness = {
    vert: "xbr.vert.glsl",
    frag: "xbr.frag.glsl",
    nearestSampling: true,
    constants: { LineGridRows, TextureSize },
    setup(gl, program, constants) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE,
            constants.LineGridRows,
            1,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            null,
        );
        gl.activeTexture(gl.TEXTURE0);

        gl.uniform1i(gl.getUniformLocation(program, "tex"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "lineGrid"), 1);
        gl.uniform2f(gl.getUniformLocation(program, "uTextureSize"), constants.TextureSize, constants.TextureSize);
        gl.uniform2f(
            gl.getUniformLocation(program, "uTexelSize"),
            1 / constants.TextureSize,
            1 / constants.TextureSize,
        );
        return { texelsPerOutputPixel: gl.getUniformLocation(program, "uTexelsPerOutputPixel") };
    },
    bind(gl, state, params) {
        gl.uniform1f(state.texelsPerOutputPixel, params.texelsPerOutputPixel);
        gl.activeTexture(gl.TEXTURE1);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            params.lineGrid.length,
            1,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            params.lineGrid,
        );
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.activeTexture(gl.TEXTURE0);
    },
};
/** A pattern with xBR's geometry, described in a line grid the shader can read. */
function xbrPattern({ scale = Scale, ...pattern }) {
    const job = buildPattern({ ...pattern, scale, padding: Padding, margin: Margin });
    const lineGrid = new Uint8Array(LineGridRows);
    lineGrid.fill(encodeLineGrid(job.texelsWide, job.texelsHigh === 2), 0, job.texelRows);
    job.bytes = { lineGrid };
    return job;
}

// A right triangle: one pixel at the top left growing to a full bottom row.
// Asymmetric in both axes, so a flipped or mirrored result fails the corner
// checks rather than quietly looking plausible.
const DiagonalRows = ["#...", "##..", "###.", "####"];

const Patterns = [
    { name: "solid", rows: ["....", "....", "....", "...."], palette: { ".": Red } },
    { name: "vertical", rows: ["##..", "##..", "##..", "##.."], palette: { "#": White, ".": Black } },
    { name: "horizontal", rows: ["####", "####", "....", "...."], palette: { "#": White, ".": Black } },
    { name: "diagonal", rows: DiagonalRows, palette: { "#": White, ".": Black } },
    { name: "colourDiagonal", rows: DiagonalRows, palette: { "#": Red, ".": Blue } },
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
    { name: "diagonalMode1", rows: DiagonalRows, palette: { "#": White, ".": Black }, texelsWide: 2 },
    { name: "diagonalMode2", rows: DiagonalRows, palette: { "#": White, ".": Black }, texelsWide: 4 },
    { name: "diagonalDoubled", rows: DiagonalRows, palette: { "#": White, ".": Black }, texelsHigh: 2 },
];

const rgbOf = (word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];

/** The middle of one logical pixel, far enough from any edge to be unblended. */
const pixelCentre = (image, x, y, scale = Scale) =>
    pixelAt(image, Math.floor((x + 0.5) * scale), Math.floor((y + 0.5) * scale));

const isColour = (pixel, word) => rgbOf(word).every((channel, i) => Math.abs(pixel[i] - channel) <= Tolerance);

/** Pixels matching none of the source colours: the shades xBR invented. */
const intermediates = (image, ...words) => [...eachPixel(image)].filter((p) => !words.some((w) => isColour(p, w)));

describe("xBR shader", () => {
    let rendered;

    beforeAll(() => {
        rendered = renderJobs(XbrHarness, Patterns.map(xbrPattern));
    }, 180000);

    it("renders every pattern at the size asked for", () => {
        // Guards every other test here: an empty image would satisfy all of
        // them by having no pixels to disagree.
        for (const pattern of Patterns) {
            const scale = pattern.scale ?? Scale;
            const image = rendered[pattern.name];
            expect([image.width, image.height]).toEqual([pattern.rows[0].length * scale, pattern.rows.length * scale]);
        }
    });

    it("leaves a solid area completely alone", () => {
        for (const pixel of eachPixel(rendered.solid)) expect(isColour(pixel, Red)).toBe(true);
    });

    it("does not blur a straight vertical edge", () => {
        // A straight edge is already exactly representable at any scale, so xBR
        // must leave it hard: this is the property separating it from bilinear.
        // Checking which side each colour lands on also pins the picture's
        // horizontal orientation, which nothing else here would notice.
        const image = rendered.vertical;
        for (let y = 0; y < image.height; ++y)
            for (let x = 0; x < image.width; ++x)
                expect(isColour(pixelAt(image, x, y), x < 2 * Scale ? White : Black)).toBe(true);
    });

    it("does not blur a straight horizontal edge", () => {
        const image = rendered.horizontal;
        for (let y = 0; y < image.height; ++y)
            for (let x = 0; x < image.width; ++x)
                expect(isColour(pixelAt(image, x, y), y < 2 * Scale ? White : Black)).toBe(true);
    });

    it("introduces intermediate shades along a diagonal edge", () => {
        const image = rendered.diagonal;
        expect(intermediates(image, White, Black).length).toBeGreaterThan(0);
        // The triangle's own corners, which fix the orientation and rule out a
        // blank picture, on which "no unexpected colours" would hold trivially.
        expect(isColour(pixelCentre(image, 0, 3), White)).toBe(true);
        expect(isColour(pixelCentre(image, 3, 0), Black)).toBe(true);
        // Every invented shade must lie between the two originals, not be a
        // colour of its own: between black and white, that means grey.
        for (const [r, g, b] of eachPixel(image)) {
            expect(g).toBe(r);
            expect(b).toBe(r);
        }
    });

    it("softens the staircase of a shallow diagonal", () => {
        const image = rendered.shallowDiagonal;
        expect(intermediates(image, White, Black).length).toBeGreaterThan(0);
        expect(isColour(pixelCentre(image, 0, 7, 3), White)).toBe(true);
        expect(isColour(pixelCentre(image, 15, 0, 3), Black)).toBe(true);
    });

    it("blends towards the colours actually present at the edge", () => {
        const image = rendered.colourDiagonal;
        expect(isColour(pixelCentre(image, 0, 3), Red)).toBe(true);
        expect(isColour(pixelCentre(image, 3, 0), Blue)).toBe(true);
        expect(intermediates(image, Red, Blue).length).toBeGreaterThan(0);
        // Red and blue have no green between them, so any green would be a
        // colour xBR invented rather than one it found.
        for (const [, g] of eachPixel(image)) expect(g).toBeLessThanOrEqual(Tolerance);
    });

    it("chamfers an isolated single pixel without bleeding outside it", () => {
        // xBR rounds the corners of a lone pixel — a MODE 0 full stop, say —
        // rather than leaving it square. Worth knowing when judging text-heavy
        // modes: it is a real difference from hqx.
        const image = rendered.lonePixel;
        const inCell = (x, y) => x >= 2 * Scale && x < 3 * Scale && y >= 2 * Scale && y < 3 * Scale;

        // Solid in the middle, but not solid throughout: the corners are cut.
        expect(isColour(pixelCentre(image, 2, 2), White)).toBe(true);
        const cell = [];
        for (let y = 2 * Scale; y < 3 * Scale; ++y)
            for (let x = 2 * Scale; x < 3 * Scale; ++x) cell.push(pixelAt(image, x, y));
        expect(cell.filter((pixel) => !isColour(pixel, White)).length).toBeGreaterThan(0);

        for (let y = 0; y < image.height; ++y)
            for (let x = 0; x < image.width; ++x)
                if (!inCell(x, y)) expect(isColour(pixelAt(image, x, y), Black)).toBe(true);
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
            expect([...actual.data]).toEqual([...expected.data]);
        });
    });
});
