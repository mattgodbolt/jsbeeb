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

class GridCapturingVideo extends Video {
    constructor(isAtom) {
        super(false, new Uint32Array(FbWidth * FbHeight), () => {}, { isAtom });
    }
}

async function render(model, program, { isAtom = false } = {}) {
    const video = new GridCapturingVideo(isAtom);
    const machine = new TestMachine(model, { video });
    await machine.initialise();
    await machine.runUntilInput();
    for (const line of program) await machine.type(line);
    await machine.runFor(15 * 1000 * 1000);
    return video;
}

/** The bands covering an actual picture, ignoring stray single rows. */
function pictureBands(video) {
    return findBands(video.lineGrid, 0, FbHeight).filter((band) => band.bottom - band.top > 8);
}

/**
 * Check that the recorded grid agrees with the pixels: within each logical
 * pixel every texel must hold the same colour. If the grid claimed pixels were
 * wider than they are, this finds two different colours inside one.
 */
function gridDescribesPixels(video, band, left, right) {
    const { texelsWide, texelsHigh } = band;
    for (let y = band.top; y + texelsHigh <= band.bottom; y += texelsHigh) {
        for (let x = left; x + texelsWide <= right; x += texelsWide) {
            const first = video.fb32[y * FbWidth + x];
            for (let dy = 0; dy < texelsHigh; ++dy) {
                for (let dx = 0; dx < texelsWide; ++dx) {
                    if (video.fb32[(y + dy) * FbWidth + x + dx] !== first) {
                        return `texel (${x + dx},${y + dy}) differs from the rest of its logical pixel`;
                    }
                }
            }
        }
    }
    return null;
}

describe("logical pixel grid over real screens", { timeout: 60000 }, () => {
    // A pattern of single-pixel-wide vertical stripes is the strongest test
    // available: if the grid were one step too wide, two colours would land
    // inside one logical pixel and gridDescribesPixels would say so.
    const stripes = (mode) => [
        `MODE ${mode}`,
        "VDU 23,1,0;0;0;0;",
        "FOR X%=0 TO 1279 STEP 8:GCOL 0,X% MOD 4:MOVE X%,0:DRAW X%,1023:NEXT",
    ];

    it.each([
        ["MODE 0", 0, 1],
        ["MODE 1", 1, 2],
        ["MODE 2", 2, 4],
        ["MODE 4", 4, 2],
        ["MODE 5", 5, 4],
    ])("records %s as %i texels per pixel", async (_name, mode, expectedWidth) => {
        const video = await render("B-DFS1.2", stripes(mode));
        const bands = pictureBands(video);
        expect(bands).toHaveLength(1);
        expect(bands[0].texelsWide).toBe(expectedWidth);
        expect(bands[0].texelsHigh).toBe(2);
        expect(gridDescribesPixels(video, bands[0], 200, 840)).toBeNull();
    });

    it("records MODE 7 at the framebuffer's own resolution", async () => {
        // The SAA5050 writes every texel of its output individually, so its
        // rounded glyphs are already one texel per pixel.
        const video = await render("B-DFS1.2", ["MODE 7", "VDU 23,1,0;0;0;0;", 'PRINT "Teletext"']);
        const bands = pictureBands(video);
        expect(bands.length).toBeGreaterThanOrEqual(1);
        expect(bands[0].texelsWide).toBe(1);
    });

    it("records a grid for the Atom's 6847 as well", async () => {
        // Without this the Atom would offer the filter and get nothing from it,
        // which is exactly the failure this whole mechanism exists to prevent.
        const video = await render("Atom", ["CLEAR4", "MOVE0,0", "DRAW255,191"], { isAtom: true });
        const bands = pictureBands(video);
        expect(bands).toHaveLength(1);
        // CLEAR4 is 256x192, and the 6847 draws every pixel two texels wide and
        // two framebuffer lines tall.
        expect(bands[0].texelsWide).toBe(2);
        expect(bands[0].texelsHigh).toBe(2);
        expect(bands[0].bottom - bands[0].top).toBe(192 * 2);
    });

    it("leaves rows outside the picture marked as not rendered", async () => {
        const video = await render("B-DFS1.2", ["MODE 1", "VDU 23,1,0;0;0;0;"]);
        expect(decodeLineGrid(video.lineGrid[0]).rendered).toBe(false);
        expect(decodeLineGrid(video.lineGrid[FbHeight - 1]).rendered).toBe(false);
    });
});
