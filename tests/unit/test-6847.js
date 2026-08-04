import { describe, it, expect } from "vitest";
import { Video6847 } from "../../src/6847.js";
import { decodeLineGrid } from "../../src/video-filters/pixel-grid.js";
import { shortestRun } from "../pixel-runs.js";

// The Video6847 constructor needs a `video` object with a few methods it
// calls during init. A minimal stub is enough for mode-table tests.
function makeStubVideo() {
    return {
        paint: () => {},
        clearPaintBuffer: () => {},
        fb32: new Uint32Array(2048 * 2048),
        interlacedSyncAndVideo: false,
        doubledScanlines: false,
        frameCount: 0,
        bitmapX: 0,
        bitmapY: 0,
        lineGrid: new Uint8Array(1024),
    };
}

describe("Video6847", () => {
    describe("setValuesFromMode", () => {
        // These expectations come from the mode table in the MC6847 code
        // itself (src/6847.js line 185). Each entry is
        // [pixelsPerChar, pixelsPerBit (in VDG pixels), linesPerRow, bpp].
        // The stored pixelsPerBit is multiplied by bitmapPxPerPixel=2.
        const cases = [
            // mode  pixelsPerChar  pixelsPerBit  linesPerRow  bpp
            ["0x00", 0x00, 8, -1, 12, 1], // text mode (GM bits ignored)
            ["0x10", 0x10, 16, 4, 3, 2], //  64×64×4
            ["0x30", 0x30, 16, 2, 3, 1], // 128×64×2
            ["0x50", 0x50, 8, 2, 3, 2], // 128×64×4
            ["0x70", 0x70, 16, 2, 2, 1], // 128×96×2
            ["0x90", 0x90, 8, 2, 2, 2], // 128×96×4
            ["0xb0", 0xb0, 16, 2, 1, 1], // 128×192×2
            ["0xd0", 0xd0, 8, 2, 1, 2], // 128×192×4
            ["0xf0", 0xf0, 8, 1, 1, 1], // 256×192×2
        ];

        it.each(cases)("mode %s sets correct geometry", (_label, mode, perChar, pxPerBit, lines, bpp) => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(mode);
            expect(vdg.pixelsPerChar).toBe(perChar);
            expect(vdg.pixelsPerBit).toBe(vdg.bitmapPxPerPixel * pxPerBit);
            expect(vdg.charLinesreg9).toBe(lines - 1);
            expect(vdg.bpp).toBe(bpp);
        });

        it("should treat modes without MODE_AG as text mode", () => {
            // Any mode with bit 4 clear (AG=0) is text regardless of GM bits.
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(0x60); // AG=0, but GM bits would be 0x70 otherwise
            expect(vdg.pixelsPerChar).toBe(8); // text mode pixelsPerChar
            expect(vdg.bpp).toBe(1);
            expect(vdg.lastmode).toBe(0x00);
        });

        it("should mask low nibble from mode value", () => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(0xff); // low nibble should be ignored
            // 0xff & 0xf0 = 0xf0 → clear4 geometry
            expect(vdg.pixelsPerChar).toBe(8);
            expect(vdg.bpp).toBe(1);
            expect(vdg.charLinesreg9).toBe(0);
        });

        it("should skip work when mode unchanged", () => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(0xf0);
            vdg.scanlineCounter = 42; // set something setValuesFromMode would reset
            vdg.setValuesFromMode(0xf0); // no change
            expect(vdg.scanlineCounter).toBe(42); // not reset
        });

        it("should reset scanline counter on mode change", () => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(0xf0);
            vdg.scanlineCounter = 42;
            vdg.setValuesFromMode(0x10); // different mode
            expect(vdg.scanlineCounter).toBe(0);
        });
    });

    describe("VDG clock", () => {
        const fakeCpu = (clockMhz) => ({ model: { clockMhz } });

        it("advances 3.638004 VDG cycles per cycle of the Atom's 1MHz CPU", () => {
            const vdg = new Video6847(makeStubVideo());
            vdg.reset(fakeCpu(1), {});
            expect(vdg.vdgCyclesPerCpuCycle).toBeCloseTo(3.638004, 6);
        });

        it("advances half as far per cycle if the CPU runs twice as fast", () => {
            const vdg = new Video6847(makeStubVideo());
            vdg.reset(fakeCpu(2), {});
            expect(vdg.vdgCyclesPerCpuCycle).toBeCloseTo(3.638004 / 2, 6);
        });
    });
});

describe("Video6847 logical pixel grid", () => {
    // Every graphics mode the 6847 offers, keyed by the value written to the
    // mode register; see `Video6847.modes` for what each one is.
    const GraphicsModes = [0xf0, 0xb0, 0x70, 0x30, 0xd0, 0x90, 0x50, 0x10];

    it.each(GraphicsModes.map((mode) => [`0x${mode.toString(16)}`, mode]))(
        "records what blitPixels actually writes in mode %s",
        (_name, mode) => {
            const video = makeStubVideo();
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
        const video = makeStubVideo();
        const vdg = new Video6847(video);
        vdg.setValuesFromMode(0x00);
        expect(vdg.pixelsPerBit).toBeLessThan(0);
        expect(() => vdg.recordLineGrid(true)).not.toThrow();
    });

    it("records what blitChar actually writes", () => {
        const video = makeStubVideo();
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
        const video = makeStubVideo();
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
