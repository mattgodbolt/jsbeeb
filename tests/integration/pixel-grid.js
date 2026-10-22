import { describe, it, expect } from "vitest";
import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { decodeLineGrid, findBands } from "../helpers/line-grid.js";

const FbWidth = 1024;
const FbHeight = 625;

/**
 * A Video that copies the next complete frame painted once one is wanted: read straight after a run,
 * `fb32` and `lineGrid` hold only as much of the raster as the beam had reached.
 */
class FrameCapturingVideo extends Video {
    constructor(isAtom) {
        super(false, FbWidth * FbHeight, () => {}, { isAtom });
        this.wanted = false;
        this.frame = null;
        this.paint_ext = () => {
            if (!this.wanted) return;
            this.wanted = false;
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
    await machine.runUntilInput();
    video.wanted = true;
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

/** Check that within each logical pixel the recorded grid describes, every texel holds the same colour. */
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

describe("logical pixel grid over real screens", () => {
    // A grid claiming pixels wider than they are puts a lit and an unlit pixel of these stripes in one; one
    // claiming them narrower still looks uniform, so the width is asserted outright. 16 graphics units is 8
    // pixels in MODE 0, 4 in MODE 1 and 4, and 2 in MODE 2 and 5, a gap in every mode under test.
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
