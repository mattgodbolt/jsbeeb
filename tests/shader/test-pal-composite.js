import { describe, it, expect, beforeAll } from "vitest";
import { buildPattern, eachPixel, pixelAt, renderJobs } from "./render.js";
import { applyFirCoefficients } from "../../tools/vite-plugin-fir-shader.js";

// These run the PAL composite shader itself, as shipped, and assert on what it
// draws; see test-xbr.js for why that means headless Chrome. The properties
// here are the ones a composite encode and decode must keep whatever else it
// does to a picture: a flat field comes back as the colour that went in, and
// nothing about where that field sits in the framebuffer or which field of
// the 8-field sequence is showing changes that.

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

/** Texels the fragment shader reads either side of the one it is drawing: half the FIR's taps. */
const FirReach = 10;

/** The shader blends chroma with the line two above, so that line must be picture too. */
const LineReach = 2;

/** Context around each pattern so its outermost texels see picture rather than nothing. */
const Padding = { x: FirReach + 2, y: LineReach + 1 };

/** Frame counts spanning the shader's 8-field sequence; the app hands it frameCount % 8. */
const FrameCounts = [0, 3, 7];

/** WebGL setup as PALCompositeFilter does it; see render.js for why these run in the page. */
const PalHarness = {
    vert: "pal-composite.vert.glsl",
    frag: "pal-composite.frag.glsl",
    prepareFragment: (source) => applyFirCoefficients(source).code,
    setup(gl, program) {
        return {
            uFramebuffer: gl.getUniformLocation(program, "uFramebuffer"),
            uResolution: gl.getUniformLocation(program, "uResolution"),
            uTexelSize: gl.getUniformLocation(program, "uTexelSize"),
            uFrameCount: gl.getUniformLocation(program, "uFrameCount"),
        };
    },
    bind(gl, state, params) {
        gl.uniform1i(state.uFramebuffer, 0);
        gl.uniform2f(state.uResolution, params.width, params.height);
        gl.uniform2f(state.uTexelSize, 1 / params.width, 1 / params.height);
        gl.uniform1f(state.uFrameCount, params.frameCount % 8);
    },
};

const flatRows = (colour, width, height) => Array.from({ length: height }, () => Array(width).fill(colour));

const flatName = (colour, origin, frameCount) => `flat-${colour}-${origin.x}-${origin.y}-${frameCount}`;

/** The two whose every channel is at an extreme, in different combinations. */
const PlacedColours = ["white", "magenta"];

/** Both texel row parities, with the field itself spanning both output row parities. */
const ParityOrigins = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
];

/** Elsewhere in the texture, out to its far column and well down it. */
const FarOrigins = [
    { x: 2, y: 3 },
    { x: 500, y: 61 },
    { x: 992, y: 200 },
];

const FlatWidth = 8;
const FlatHeight = 4;

/** Colour bars wide enough that the FIR sees only one bar from the middle of each. */
const BarWidth = 32;
const BarHeight = 8;
const BarOrder = ["red", "green", "blue", "white", "yellow", "cyan", "magenta", "black"];
const BarRows = Array.from({ length: BarHeight }, () => BarOrder.flatMap((colour) => Array(BarWidth).fill(colour)));
const BarOrigin = { x: 20, y: 40 };

/** Columns of a bar the FIR reaches no neighbour from. */
const barInterior = (bar) => {
    const columns = [];
    for (let x = bar * BarWidth + FirReach; x < (bar + 1) * BarWidth - FirReach; ++x) columns.push(x);
    return columns;
};

function buildJobs() {
    const jobs = [];
    for (const colour of Object.keys(Palette))
        for (const origin of ParityOrigins)
            for (const frameCount of FrameCounts)
                jobs.push(
                    buildPattern({
                        name: flatName(colour, origin, frameCount),
                        rows: flatRows(colour, FlatWidth, FlatHeight),
                        palette: Palette,
                        padding: Padding,
                        origin,
                        params: { frameCount },
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
                    params: { frameCount: 0 },
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
                params: { frameCount: 0 },
            }),
        );
    return jobs;
}

const rgbOf = (word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];

const isColour = (pixel, word) => rgbOf(word).every((channel, i) => Math.abs(pixel[i] - channel) <= Tolerance);

const channelDifference = (a, b) => Math.max(...a.slice(0, 3).map((channel, i) => Math.abs(channel - b[i])));

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

    beforeAll(() => {
        jobs = buildJobs();
        rendered = renderJobs(PalHarness, jobs);
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
        it.each(Object.entries(Palette))(
            "decodes a field of %s to itself at every parity and frame count",
            (colour, word) => {
                for (const origin of ParityOrigins)
                    for (const frameCount of FrameCounts) {
                        const image = rendered[flatName(colour, origin, frameCount)];
                        for (const pixel of eachPixel(image)) expect(isColour(pixel, word)).toBe(true);
                    }
            },
        );

        it("decodes the same wherever the field sits in the texture", () => {
            for (const colour of PlacedColours) {
                const reference = rendered[flatName(colour, ParityOrigins[0], 0)];
                for (const origin of [...ParityOrigins.slice(1), ...FarOrigins]) {
                    const image = rendered[flatName(colour, origin, 0)];
                    for (let y = 0; y < reference.height; ++y)
                        for (let x = 0; x < reference.width; ++x)
                            expect(
                                channelDifference(pixelAt(image, x, y), pixelAt(reference, x, y)),
                            ).toBeLessThanOrEqual(Tolerance);
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

        // Skipped until #903 lands: the shader takes subcarrier phase and row
        // parity from gl_FragCoord, so at scale 2 the edges decode differently.
        it.skip("gives the same picture when drawn at twice the size", () => {
            const expected = rendered["bars-1"];
            const actual = downsample(rendered["bars-2"], 2);
            for (let y = 0; y < expected.height; ++y)
                for (let x = 0; x < expected.width; ++x)
                    expect(channelDifference(pixelAt(actual, x, y), pixelAt(expected, x, y))).toBeLessThanOrEqual(
                        Tolerance,
                    );
        });
    });
});
