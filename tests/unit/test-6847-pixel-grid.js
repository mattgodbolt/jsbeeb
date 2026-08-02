import { describe, it, expect } from "vitest";
import { Video6847 } from "../../src/6847.js";
import { decodeLineGrid } from "../../src/video-filters/pixel-grid.js";

// The 6847 tells display filters how wide its logical pixels are, and getting
// that wrong is worse than not reporting it at all: the filter reconstructs
// edges on a stretched grid and produces a picture that is confidently wrong.
// Rather than restate the arithmetic, these tests run the blitters and measure
// what they actually wrote.

const FbWidth = 1024;

/** A stand-in for Video that is just somewhere to blit into. */
function fakeVideo() {
    return {
        fb32: new Uint32Array(FbWidth * 4),
        lineGrid: new Uint8Array(FbWidth),
        // Video6847 resets through these on construction.
        clearPaintBuffer() {},
        paint() {},
    };
}

/** The length of the shortest run of equal texels in a blitted row. */
function shortestRun(fb32, from, to) {
    let shortest = Infinity;
    let runStart = from;
    for (let x = from + 1; x <= to; ++x) {
        if (x === to || fb32[x] !== fb32[runStart]) {
            shortest = Math.min(shortest, x - runStart);
            runStart = x;
        }
    }
    return shortest;
}

describe("6847 logical pixel grid", () => {
    // Every graphics mode the 6847 offers, keyed by the value written to the
    // mode register; see `Video6847.modes` for what each one is.
    const GraphicsModes = [0xf0, 0xb0, 0x70, 0x30, 0xd0, 0x90, 0x50, 0x10];

    it.each(GraphicsModes.map((mode) => [`0x${mode.toString(16)}`, mode]))(
        "records what blitPixels actually writes in mode %s",
        (_name, mode) => {
            const video = fakeVideo();
            const vdg = new Video6847(video);
            vdg.setValuesFromMode(mode);
            vdg.bitmapY = 0;

            // Alternating bits give the shortest runs the mode can produce: at
            // 1bpp neighbouring pixels differ, and at 2bpp so do neighbouring
            // colour pairs.
            const pattern = 0b01100110;
            vdg.blitPixels(video.fb32, pattern, 0, 0);
            const blitted = shortestRun(video.fb32, 0, 8 * vdg.pixelsPerBit);

            // Ask for the width the same way the render loop does, so this
            // pins the decision the 6847 makes and not just the arithmetic.
            vdg.recordLineGrid(false);
            expect(decodeLineGrid(video.lineGrid[0]).texelsWide).toBe(blitted);
        },
    );

    it("does not ask blitPixels' mode table for a text mode width", () => {
        // The table holds -1 there, because text mode does not blit pixels.
        // Reaching for it would encode a negative width and throw.
        const video = fakeVideo();
        const vdg = new Video6847(video);
        vdg.setValuesFromMode(0x00);
        expect(vdg.pixelsPerBit).toBeLessThan(0);
        expect(() => vdg.recordLineGrid(true)).not.toThrow();
    });

    it("records what blitChar actually writes", () => {
        const video = fakeVideo();
        const vdg = new Video6847(video);
        vdg.setValuesFromMode(0x00); // text
        vdg.bitmapY = 0;
        vdg.scanlineCounter = 4; // a scanline through the middle of the glyph

        // Character 'A' has both set and clear pixels on a middle scanline.
        vdg.blitChar(video.fb32, 0x21, 0, vdg.pixelsPerChar, 0);
        const texelsPerChar = vdg.pixelsPerChar * vdg.bitmapPxPerPixel;
        const blitted = shortestRun(video.fb32, 0, texelsPerChar);

        vdg.recordLineGrid(true);
        expect(decodeLineGrid(video.lineGrid[0]).texelsWide).toBe(blitted);
    });

    it("marks both framebuffer rows of a pixel row", () => {
        // Every 6847 blitter writes each pixel row twice, so the descriptor has
        // to say so and cover both rows.
        const video = fakeVideo();
        const vdg = new Video6847(video);
        vdg.setValuesFromMode(0xb0); // four texels per pixel
        vdg.bitmapY = 2;
        vdg.recordLineGrid(false);

        for (const row of [2, 3]) {
            expect(decodeLineGrid(video.lineGrid[row])).toEqual({
                rendered: true,
                texelsWide: 4,
                texelsHigh: 2,
            });
        }
        expect(decodeLineGrid(video.lineGrid[1]).rendered).toBe(false);
        expect(decodeLineGrid(video.lineGrid[4]).rendered).toBe(false);
    });
});
