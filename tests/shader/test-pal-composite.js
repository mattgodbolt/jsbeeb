import { describe, it, expect, beforeAll } from "vitest";
import { buildPattern, eachPixel, pixelAt, renderJobs, TextureSize } from "./render.js";
import { applyFirCoefficients } from "../../tools/vite-plugin-fir-shader.js";
import { LumaKernel, LumaTaps } from "../../src/video-filters/pal-composite.js";

// These run the PAL composite shader itself, as shipped, and assert on what it
// draws; see test-xbr.js for why that means headless Chrome. The properties
// here are the ones a composite encode and decode must keep whatever else it
// does to a picture: a flat field comes back as the colour that went in, and
// nothing about where that field sits in the framebuffer or which line of
// the subcarrier's cycle it lands on changes that. Where the picture has
// cross-colour, that depends on the scanline it was drawn on and nothing
// else: not the texture row, not the size it is drawn at.

const Black = 0xff000000;
const Red = 0xff0000ff;
const Green = 0xff00ff00;
const Yellow = 0xff00ffff;
const Blue = 0xffff0000;
const Magenta = 0xffff00ff;
const Cyan = 0xffffff00;
const White = 0xffffffff;

const Palette = {
    black: Black,
    red: Red,
    green: Green,
    yellow: Yellow,
    blue: Blue,
    magenta: Magenta,
    cyan: Cyan,
    white: White,
};

/** Eight-bit rounding through the shader; colours meant to be equal land within this. */
const Tolerance = 2;

/** Texels the chroma FIR reads either side of the one it is drawing: half its taps. */
const FirReach = 10;

/** Texels the luma FIR reads either side of that, again. */
const LumaReach = (LumaTaps - 1) / 2;

/** Texels either side of the one drawn that the shader reads at all. */
const Reach = FirReach + LumaReach;

/** The shader blends chroma with the line two above, so that line must be picture too. */
const LineReach = 2;

/** Context around each pattern so its outermost texels see picture rather than nothing. */
const Padding = { x: Reach + 2, y: LineReach + 1 };

/** The subcarrier's phase against the line repeats every 2500 lines; see video.js. */
const PhasePeriodLines = 2500;

/** Line numbers spanning the four-line phase cycle and both V-switch parities, and the last before the period wraps. */
const LineBases = [0, 1, 2, 3, PhasePeriodLines - 1];

/** WebGL setup as PALCompositeFilter does it; see render.js for why these run in the page. */
const PalHarness = {
    vert: "pal-composite.vert.glsl",
    frag: "pal-composite.frag.glsl",
    prepareFragment: (source) => applyFirCoefficients(source).code,
    constants: { lumaKernel: Array.from(LumaKernel) },
    setup(gl, program, constants) {
        gl.uniform1fv(gl.getUniformLocation(program, "uLumaFir[0]"), new Float32Array(constants.lumaKernel));
        return {
            uFramebuffer: gl.getUniformLocation(program, "uFramebuffer"),
            uResolution: gl.getUniformLocation(program, "uResolution"),
            uTexelSize: gl.getUniformLocation(program, "uTexelSize"),
            uLineBase: gl.getUniformLocation(program, "uLineBase"),
        };
    },
    bind(gl, state, params) {
        gl.uniform1i(state.uFramebuffer, 0);
        gl.uniform2f(state.uResolution, params.width, params.height);
        gl.uniform2f(state.uTexelSize, 1 / params.width, 1 / params.height);
        gl.uniform2f(state.uLineBase, params.lineBaseEven ?? 0, params.lineBaseOdd ?? 0);
    },
};

/** Both rows of a doubled scanline drawn under the same line, as video.js records it. */
const sameLine = (lineBase) => ({ lineBaseEven: lineBase, lineBaseOdd: lineBase });

const flatRows = (colour, width, height) => Array.from({ length: height }, () => Array(width).fill(colour));

const flatName = (colour, origin, lineBase) => `flat-${colour}-${origin.x}-${origin.y}-${lineBase}`;

/** The two whose every channel is at an extreme, in different combinations. */
const PlacedColours = ["white", "magenta"];

/** Both texel row parities, with the field itself spanning both output row parities. */
const ParityOrigins = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
];

const FlatWidth = 8;
const FlatHeight = 4;

/** Elsewhere in the texture, out to its far column and well down it. */
const FarOrigins = [
    { x: 2, y: 3 },
    { x: 500, y: 61 },
    { x: TextureSize - FlatWidth - 2 * Padding.x, y: 200 },
];

/** Colour bars wide enough that the shader sees only one bar from the middle of each. */
const BarWidth = 64;
const BarHeight = 8;
const BarOrder = ["red", "green", "blue", "white", "yellow", "cyan", "magenta", "black"];
const BarRows = Array.from({ length: BarHeight }, () => BarOrder.flatMap((colour) => Array(BarWidth).fill(colour)));
const BarOrigin = { x: 20, y: 40 };

/** Columns of a bar the shader reaches no neighbour from. */
const barInterior = (bar) => {
    const columns = [];
    for (let x = bar * BarWidth + Reach; x < (bar + 1) * BarWidth - Reach; ++x) columns.push(x);
    return columns;
};

/**
 * A picture full of cross-colour: saturated edges, and a one-pixel stripe whose
 * 4 MHz sits beside the 4.43 MHz subcarrier. Drawn as MODE 1 draws, two texels
 * wide and doubled onto two rows, at one output pixel per texel so both rows of
 * each scanline can be read back.
 */
const StripeWidth = 12;
const StripeRow = [
    ...Array(StripeWidth).fill("red"),
    ...Array(StripeWidth).fill("cyan"),
    ...Array(StripeWidth).fill("white"),
    ...Array(StripeWidth).fill("black"),
    ...Array.from({ length: StripeWidth }, (_, i) => (i % 2 ? "black" : "white")),
    ...Array(StripeWidth).fill("green"),
];
const StripeHeight = 4;
const StripeRows = Array.from({ length: StripeHeight }, () => StripeRow);
const DoubledStripes = { rows: StripeRows, palette: Palette, padding: Padding, texelsWide: 2, texelsHigh: 2, scale: 2 };

/**
 * Luma detail at two rates, drawn one texel per pixel: alternate texels are
 * 8 MHz, which a set cannot resolve, and four-texel bars are 2 MHz, which it
 * shows at nearly full contrast. Wide enough to have an interior beyond the
 * shader's reach from the picture's edges.
 */
const DetailWidth = 96;
const DetailHeight = 4;
const detailRows = (period) =>
    Array.from({ length: DetailHeight }, () =>
        Array.from({ length: DetailWidth }, (_, x) => (x % period < period / 2 ? "white" : "black")),
    );
const Detail = {
    unresolved: { period: 2 },
    resolved: { period: 8 },
};

const stripeName = (lineBase, origin) => `stripes-${lineBase}-${origin.x}-${origin.y}`;
/** The line the picture is compared against when moved, wrapped or stepped. */
const StripeBase = 3;
const StripeOrigin = { x: 0, y: 0 };
/** Two texel rows lower: the next scanline's rows. */
const NextScanlineOrigin = { x: 0, y: 2 };

function buildJobs() {
    const jobs = [];
    for (const colour of Object.keys(Palette))
        for (const origin of ParityOrigins)
            for (const lineBase of LineBases)
                jobs.push(
                    buildPattern({
                        name: flatName(colour, origin, lineBase),
                        rows: flatRows(colour, FlatWidth, FlatHeight),
                        palette: Palette,
                        padding: Padding,
                        origin,
                        params: sameLine(lineBase),
                    }),
                );
    for (const colour of PlacedColours)
        for (const origin of FarOrigins)
            jobs.push(
                buildPattern({
                    name: flatName(colour, origin, 0),
                    rows: flatRows(colour, FlatWidth, FlatHeight),
                    palette: Palette,
                    padding: Padding,
                    origin,
                    params: sameLine(0),
                }),
            );
    for (const scale of [1, 2])
        jobs.push(
            buildPattern({
                name: `bars-${scale}`,
                rows: BarRows,
                palette: Palette,
                padding: Padding,
                origin: BarOrigin,
                scale,
                params: sameLine(0),
            }),
        );
    for (const [name, { period }] of Object.entries(Detail))
        jobs.push(
            buildPattern({
                name: `detail-${name}`,
                rows: detailRows(period),
                palette: Palette,
                padding: Padding,
                params: sameLine(0),
            }),
        );
    for (const lineBase of LineBases)
        jobs.push(
            buildPattern({
                ...DoubledStripes,
                name: stripeName(lineBase, StripeOrigin),
                origin: StripeOrigin,
                params: sameLine(lineBase),
            }),
        );
    jobs.push(
        buildPattern({
            ...DoubledStripes,
            name: stripeName(StripeBase + PhasePeriodLines, StripeOrigin),
            origin: StripeOrigin,
            params: sameLine(StripeBase + PhasePeriodLines),
        }),
    );
    for (const lineBase of [StripeBase, StripeBase - 1])
        jobs.push(
            buildPattern({
                ...DoubledStripes,
                name: stripeName(lineBase, NextScanlineOrigin),
                origin: NextScanlineOrigin,
                params: sameLine(lineBase),
            }),
        );
    return jobs;
}

/**
 * The bars again, sampled nearest-texel. At two output pixels per texel the
 * app's linear sampling reads a quarter of a texel into each neighbour, which
 * softens every edge before the shader sees it; nearest sampling leaves the
 * shader's own handling of the output size as the only difference between
 * the two scales.
 */
function buildNearestJobs() {
    return [1, 2].map((scale) =>
        buildPattern({
            name: `bars-${scale}`,
            rows: BarRows,
            palette: Palette,
            padding: Padding,
            origin: BarOrigin,
            scale,
            params: sameLine(0),
        }),
    );
}

const rgbOf = (word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];

const isColour = (pixel, word) => rgbOf(word).every((channel, i) => Math.abs(pixel[i] - channel) <= Tolerance);

const channelDifference = (a, b) => Math.max(...a.slice(0, 3).map((channel, i) => Math.abs(channel - b[i])));

/** The largest channel difference between two pictures of the same size. */
function pictureDifference(a, b) {
    let worst = 0;
    for (let y = 0; y < a.height; ++y)
        for (let x = 0; x < a.width; ++x)
            worst = Math.max(worst, channelDifference(pixelAt(a, x, y), pixelAt(b, x, y)));
    return worst;
}

/** Box-filter a picture drawn at `scale` back down to one output pixel per logical pixel. */
function downsample(image, scale) {
    const width = image.width / scale;
    const height = image.height / scale;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; ++y)
        for (let x = 0; x < width; ++x) {
            const sum = [0, 0, 0, 0];
            for (let dy = 0; dy < scale; ++dy)
                for (let dx = 0; dx < scale; ++dx)
                    pixelAt(image, x * scale + dx, y * scale + dy).forEach((channel, i) => (sum[i] += channel));
            data.set(
                sum.map((total) => Math.round(total / (scale * scale))),
                (y * width + x) * 4,
            );
        }
    return { width, height, data };
}

describe("PAL composite shader", () => {
    let jobs;
    let rendered;
    let renderedNearest;

    beforeAll(() => {
        jobs = buildJobs();
        rendered = renderJobs(PalHarness, jobs);
        renderedNearest = renderJobs({ ...PalHarness, nearestSampling: true }, buildNearestJobs());
    }, 180000);

    it("renders every job at the size asked for", () => {
        // Guards every other test here: an empty image would satisfy all of
        // them by having no pixels to disagree.
        for (const job of jobs) {
            const image = rendered[job.name];
            expect([image.width, image.height]).toEqual([job.width * job.scale, job.height * job.scale]);
        }
    });

    describe("flat fields", () => {
        it.each(Object.entries(Palette))("decodes a field of %s to itself at every parity and line", (colour, word) => {
            for (const origin of ParityOrigins)
                for (const lineBase of LineBases) {
                    const image = rendered[flatName(colour, origin, lineBase)];
                    for (const pixel of eachPixel(image)) expect(isColour(pixel, word)).toBe(true);
                }
        });

        it("decodes the same wherever the field sits in the texture", () => {
            for (const colour of PlacedColours) {
                const reference = rendered[flatName(colour, ParityOrigins[0], 0)];
                for (const origin of [...ParityOrigins.slice(1), ...FarOrigins]) {
                    const image = rendered[flatName(colour, origin, 0)];
                    expect(pictureDifference(image, reference)).toBeLessThanOrEqual(Tolerance);
                }
            }
        });
    });

    describe("colour bars", () => {
        it("decodes the middle of each bar to its colour", () => {
            const image = rendered["bars-1"];
            BarOrder.forEach((colour, bar) => {
                for (const x of barInterior(bar))
                    for (let y = 0; y < image.height; ++y)
                        expect(isColour(pixelAt(image, x, y), Palette[colour])).toBe(true);
            });
        });

        it("gives the same flat colours when drawn at twice the size", () => {
            const expected = rendered["bars-1"];
            const actual = downsample(rendered["bars-2"], 2);
            for (let bar = 0; bar < BarOrder.length; ++bar)
                for (const x of barInterior(bar))
                    for (let y = 0; y < expected.height; ++y)
                        expect(channelDifference(pixelAt(actual, x, y), pixelAt(expected, x, y))).toBeLessThanOrEqual(
                            Tolerance,
                        );
        });

        it("gives the same picture, edges included, when drawn at twice the size", () => {
            // Sampled nearest-texel, so that the edges reach the shader
            // unsoftened at both scales; see buildNearestJobs.
            const expected = renderedNearest["bars-1"];
            const actual = downsample(renderedNearest["bars-2"], 2);
            expect(pictureDifference(actual, expected)).toBeLessThanOrEqual(Tolerance);
        });
    });

    describe("luma bandwidth", () => {
        /** Columns of a detail pattern the shader reaches no padding from. */
        const interior = [];
        for (let x = Reach; x < DetailWidth - Reach; ++x) interior.push(x);

        /** Peak-to-peak of the interior, per channel, and its mean. */
        function interiorContrast(image) {
            const low = [255, 255, 255];
            const high = [0, 0, 0];
            let total = 0;
            for (const x of interior)
                for (let y = 0; y < image.height; ++y) {
                    const pixel = pixelAt(image, x, y);
                    for (let i = 0; i < 3; ++i) {
                        low[i] = Math.min(low[i], pixel[i]);
                        high[i] = Math.max(high[i], pixel[i]);
                        total += pixel[i];
                    }
                }
            return {
                contrast: Math.max(...high.map((h, i) => h - low[i])),
                mean: total / (interior.length * image.height * 3),
            };
        }

        it("has interior columns to measure", () => {
            expect(interior.length).toBeGreaterThan(8);
        });

        it("cannot resolve alternate texels, and shows them as a flat grey", () => {
            const { contrast, mean } = interiorContrast(rendered["detail-unresolved"]);
            expect(contrast).toBeLessThanOrEqual(8);
            expect(mean).toBeGreaterThan(96);
            expect(mean).toBeLessThan(160);
        });

        it("keeps the contrast of detail well inside its bandwidth", () => {
            const { contrast } = interiorContrast(rendered["detail-resolved"]);
            expect(contrast).toBeGreaterThan(190);
        });
    });

    describe("doubled scanlines", () => {
        /** Cross-colour large enough that a change of line has to show. */
        const VisibleChange = 16;

        it("has cross-colour to test with", () => {
            // Guards the tests below: rows that agree because the picture
            // decoded to flat colour would prove nothing.
            const image = rendered[stripeName(StripeBase, StripeOrigin)];
            let worst = 0;
            for (let x = 0; x < image.width; ++x)
                for (let y = 0; y < image.height; ++y)
                    worst = Math.max(worst, channelDifference(pixelAt(image, x, y), pixelAt(image, x, 0)));
            expect(worst).toBeGreaterThan(VisibleChange);
        });

        it("decodes both rows of a scanline identically", () => {
            for (const lineBase of LineBases) {
                const image = rendered[stripeName(lineBase, StripeOrigin)];
                for (let y = 0; y < image.height; y += 2)
                    for (let x = 0; x < image.width; ++x)
                        expect(channelDifference(pixelAt(image, x, y), pixelAt(image, x, y + 1))).toBeLessThanOrEqual(
                            Tolerance,
                        );
            }
        });

        it("takes its phase from the line, not the texture row", () => {
            // Two rows lower is the next line down, unless the base is one
            // less, when every row keeps its line number. A per-row phase
            // would miss both: two rows is half a cycle, which cancels.
            const reference = rendered[stripeName(StripeBase, StripeOrigin)];
            const nextLine = rendered[stripeName(StripeBase, NextScanlineOrigin)];
            const sameLines = rendered[stripeName(StripeBase - 1, NextScanlineOrigin)];
            expect(pictureDifference(nextLine, reference)).toBeGreaterThan(VisibleChange);
            expect(pictureDifference(sameLines, reference)).toBeLessThanOrEqual(Tolerance);
        });

        it("repeats its phase every 2500 lines", () => {
            const reference = rendered[stripeName(StripeBase, StripeOrigin)];
            const wrapped = rendered[stripeName(StripeBase + PhasePeriodLines, StripeOrigin)];
            expect(pictureDifference(wrapped, reference)).toBeLessThanOrEqual(Tolerance);
        });

        it("decodes consecutive lines differently", () => {
            const consecutive = LineBases.filter((lineBase, i) => i > 0 && lineBase === LineBases[i - 1] + 1);
            expect(consecutive.length).toBeGreaterThan(0);
            for (const lineBase of consecutive) {
                const previous = rendered[stripeName(lineBase - 1, StripeOrigin)];
                const image = rendered[stripeName(lineBase, StripeOrigin)];
                expect(pictureDifference(image, previous)).toBeGreaterThan(VisibleChange);
            }
        });
    });
});
