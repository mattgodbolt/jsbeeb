import { describe, it, expect } from "vitest";
import { Video6847 } from "../../src/6847.js";

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
});
