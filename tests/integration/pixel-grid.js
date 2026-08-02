import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";
import { Video } from "../../src/video.js";
import { findBands, decodeLineGrid } from "../../src/video-filters/pixel-grid.js";

// The logical pixel grid that display filters rely on is derived from the video
// chips' own state, so the only test that really proves it is to render a real
// screen and check the recorded grid against what the mode actually put in the
// framebuffer. These assert the invariant the filters depend on: every texel
// covered by one logical pixel holds the same colour.

const FbWidth = 1024;
const FbHeight = 625;

/**
 * A Video that keeps a copy of a complete frame. Reading `fb32` and `lineGrid`
 * directly after running for a fixed time gives whatever part of the raster the
 * CPU had reached — about the top sixth of the screen — and the rest would never
 * be examined. Snapshotting at paint time gives the whole picture.
 */
class FrameCapturingVideo extends Video {
    constructor(isAtom) {
        super(false, new Uint32Array(FbWidth * FbHeight), () => {}, { isAtom });
        this.paint_ext = () => {
            this.frame = { fb32: this.fb32.slice(), lineGrid: this.lineGrid.slice() };
        };
    }
}

async function render(model, program, { isAtom = false } = {}) {
    const video = new FrameCapturingVideo(isAtom);
    const machine = new TestMachine(model, { video });
    await machine.initialise();
    await machine.runUntilInput();
    for (const line of program) await machine.type(line);
    await machine.runFor(15 * 1000 * 1000);
    // Drawing has finished; take the next complete frame.
    video.frame = null;
    for (let attempt = 0; attempt < 10 && !video.frame; ++attempt) await machine.runFor(1000 * 1000);
    if (!video.frame) throw new Error("no complete frame was painted");
    return video.frame;
}

/** Distinct colours in a band, so a test cannot pass on a blank screen. */
function coloursIn(frame, band, left, right) {
    const colours = new Set();
    for (let y = band.top; y < band.bottom; ++y) {
        for (let x = left; x < right; ++x) colours.add(frame.fb32[y * FbWidth + x]);
    }
    return colours;
}

/** The bands covering an actual picture, ignoring stray single rows. */
function pictureBands(frame) {
    return findBands(frame.lineGrid, 0, FbHeight).filter((band) => band.bottom - band.top > 8);
}

/**
 * Check that the recorded grid agrees with the pixels: within each logical
 * pixel every texel must hold the same colour. If the grid claimed pixels were
 * wider than they are, this finds two different colours inside one.
 */
function gridDescribesPixels(frame, band, left, right) {
    const { texelsWide, texelsHigh } = band;
    for (let y = band.top; y + texelsHigh <= band.bottom; y += texelsHigh) {
        for (let x = left; x + texelsWide <= right; x += texelsWide) {
            const first = frame.fb32[y * FbWidth + x];
            for (let dy = 0; dy < texelsHigh; ++dy) {
                for (let dx = 0; dx < texelsWide; ++dx) {
                    if (frame.fb32[(y + dy) * FbWidth + x + dx] !== first) {
                        return `texel (${x + dx},${y + dy}) differs from the rest of its logical pixel`;
                    }
                }
            }
        }
    }
    return null;
}

describe("logical pixel grid over real screens", { timeout: 60000 }, () => {
    // Single-pixel-wide vertical stripes with a gap between them. If the grid
    // claimed pixels were wider than they are, a lit and an unlit pixel would
    // land inside one and gridDescribesPixels would say so. A grid that claimed
    // pixels were *narrower* would still look uniform, so the expected width is
    // asserted outright as well, and notBlank guards against the whole thing
    // passing on an empty screen.
    //
    // 16 graphics units is 8 pixels in MODE 0, 4 in MODE 1 and 4, and 2 in
    // MODE 2 and 5 — a gap in every mode under test.
    const stripes = (mode) => [
        `MODE ${mode}`,
        "VDU 23,1,0;0;0;0;",
        "GCOL 0,1",
        "FOR X%=0 TO 1279 STEP 16:MOVE X%,0:DRAW X%,1023:NEXT",
    ];

    it.each([
        ["MODE 0", 0, 1],
        ["MODE 1", 1, 2],
        ["MODE 2", 2, 4],
        ["MODE 4", 4, 2],
        ["MODE 5", 5, 4],
    ])("records %s as %i texels per pixel", async (_name, mode, expectedWidth) => {
        const frame = await render("B-DFS1.2", stripes(mode));
        const bands = pictureBands(frame);
        expect(bands).toHaveLength(1);
        expect(bands[0].texelsWide).toBe(expectedWidth);
        expect(bands[0].texelsHigh).toBe(2);
        expect(coloursIn(frame, bands[0], 200, 840).size).toBeGreaterThan(1);
        expect(gridDescribesPixels(frame, bands[0], 200, 840)).toBeNull();
    });

    it("records MODE 7 at the framebuffer's own resolution", async () => {
        // The SAA5050 writes every texel of its output individually, so its
        // rounded glyphs are already one texel per pixel.
        const frame = await render("B-DFS1.2", ["MODE 7", "VDU 23,1,0;0;0;0;", 'PRINT "Teletext"']);
        const bands = pictureBands(frame);
        expect(bands.length).toBeGreaterThanOrEqual(1);
        expect(bands[0].texelsWide).toBe(1);
        expect(coloursIn(frame, bands[0], 250, 800).size).toBeGreaterThan(1);
    });

    it("records a grid for the Atom's 6847 as well", async () => {
        // Without this the Atom would offer the filter and get nothing from it,
        // which is exactly the failure this whole mechanism exists to prevent.
        const frame = await render("Atom", ["CLEAR4", "MOVE0,0", "DRAW255,191"], { isAtom: true });
        const bands = pictureBands(frame);
        expect(bands).toHaveLength(1);
        // CLEAR4 is 256x192, and the 6847 draws every pixel two texels wide and
        // two framebuffer lines tall.
        expect(bands[0].texelsWide).toBe(2);
        expect(bands[0].texelsHigh).toBe(2);
        expect(bands[0].bottom - bands[0].top).toBe(192 * 2);
        expect(coloursIn(frame, bands[0], 150, 600).size).toBeGreaterThan(1);
        expect(gridDescribesPixels(frame, bands[0], 150, 600)).toBeNull();
    });

    it("leaves rows outside the picture marked as not rendered", async () => {
        const frame = await render("B-DFS1.2", ["MODE 1", "VDU 23,1,0;0;0;0;"]);
        expect(decodeLineGrid(frame.lineGrid[0]).rendered).toBe(false);
        expect(decodeLineGrid(frame.lineGrid[FbHeight - 1]).rendered).toBe(false);
    });
});
