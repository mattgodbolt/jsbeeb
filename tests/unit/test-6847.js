import { describe, it, expect } from "vitest";
import { Video6847 } from "../../src/6847.js";
import { OPAQUE_BLACK, Video } from "../../src/video.js";
import { decodeLineGrid } from "../helpers/line-grid.js";
import { shortestRun } from "../helpers/pixel-runs.js";

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
            ["0x60, text as AG is clear", 0x60, 8, -1, 12, 1],
            ["0xff, as 0xf0", 0xff, 8, 1, 1, 1],
        ];

        it.each(cases)("mode %s sets correct geometry", (_label, mode, perChar, pxPerBit, lines, bpp) => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(mode);
            expect(vdg.pixelsPerChar).toBe(perChar);
            expect(vdg.pixelsPerBit).toBe(vdg.bitmapPxPerPixel * pxPerBit);
            expect(vdg.charLinesreg9).toBe(lines - 1);
            expect(vdg.bpp).toBe(bpp);
        });

        it.each([
            ["keeps the scanline counter when the mode is unchanged", 0xf0, 42],
            ["resets the scanline counter on a mode change", 0x10, 0],
        ])("%s", (_, nextMode, expected) => {
            const vdg = new Video6847(makeStubVideo());
            vdg.setValuesFromMode(0xf0);
            vdg.scanlineCounter = 42;
            vdg.setValuesFromMode(nextMode);
            expect(vdg.scanlineCounter).toBe(expected);
        });
    });

    it.each([
        ["the Atom's 1MHz CPU", 1, 3.638004],
        ["a CPU running twice as fast", 2, 3.638004 / 2],
    ])("advances the VDG clock for %s", (_, clockMhz, vdgCycles) => {
        const vdg = new Video6847(makeStubVideo());
        vdg.reset({ model: { clockMhz } }, {});
        expect(vdg.vdgCyclesPerCpuCycle).toBeCloseTo(vdgCycles, 6);
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

            // Alternating *pairs* of bits, so neighbouring colour pairs differ
            // at 2bpp — where alternating single bits would decode to one
            // colour throughout — and the single bits at each end still give a
            // shortest run of one pixel at 1bpp.
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

        // The 6847's set starts at '@', so 0x21 is '!': set and clear pixels
        // on a middle scanline, which is all this needs.
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

const FbWidth = 1024;
const FbHeight = 768;
const VdgLinesPerField = 263;
const VdgCyclesPerLine = 229;
const VdgClockMhz = 3.638004;
const CpuCyclesPerLine = VdgCyclesPerLine / VdgClockMhz;
const CpuCyclesPerField = VdgLinesPerField * CpuCyclesPerLine;
const FieldSyncLine = 240;
const MidPictureLine = 94;
const LinesPerRowMode = 0x50;
const LinesPerRow = 3;
const SnowAddr = 0x8123;

function makeAtomVideo(mode = LinesPerRowMode) {
    const video = new Video(false, FbWidth * FbHeight, () => {}, { isAtom: true });
    const ram = new Uint8Array(0x2000).map((_, i) => (i * 37) ^ (i >>> 5));
    const vblanks = [];
    const cpu = { model: { clockMhz: 1 }, videoRead: (addr) => ram[addr & 0x1fff] };
    const ppia = { portapins: mode, portcpins: 0x08, setVBlankInt: (level) => vblanks.push(level) };
    video.reset(cpu, null);
    video.video6847.reset(cpu, ppia);
    return { video, vblanks };
}

describe("Video6847 and the clear between frames", () => {
    it("blacks out everything a part-drawn field drew", () => {
        const { video } = makeAtomVideo();
        const fb = new Uint32Array(video.fb32.buffer, video.fb32.byteOffset, video.fb32.length);
        video.polltime(Math.floor(CpuCyclesPerField * 0.6));
        expect(fb.some((pixel) => pixel !== OPAQUE_BLACK)).toBe(true);

        video.clearPaintBuffer();

        expect(fb.every((pixel) => pixel === OPAQUE_BLACK)).toBe(true);
    });
});

describe("Video6847 snapshot", () => {
    // One CPU cycle at a time, as the CPU drives it, so snow reads can happen.
    function runCpuCycles(video, cycles) {
        for (let i = 0; i < cycles; i++) video.polltime(1);
    }

    function restoreInto(original) {
        const restored = makeAtomVideo();
        restored.video.restoreState(original.video.snapshotState());
        restored.video.fb32.set(original.video.fb32);
        original.vblanks.length = 0;
        return restored;
    }

    function expectSameFrom(original, restored) {
        expect(restored.video.video6847.snapshotState()).toEqual(original.video.video6847.snapshotState());
        expect(restored.vblanks).toEqual(original.vblanks);
        // Counted rather than compared whole, so a failure does not diff a megabyte.
        const fb = original.video.fb32;
        expect(restored.video.fb32.filter((pixel, i) => pixel !== fb[i]).length).toBe(0);
    }

    it("carries on exactly as the original does from any cycle of a row mid-picture", () => {
        const rowStart = Math.floor(CpuCyclesPerField + CpuCyclesPerLine * MidPictureLine);
        const rowCycles = Math.ceil(CpuCyclesPerLine * LinesPerRow);
        for (let at = rowStart; at < rowStart + rowCycles; at++) {
            const original = makeAtomVideo();
            runCpuCycles(original.video, at);
            original.video.video6847.cpuAddrAccess(SnowAddr);

            const restored = restoreInto(original);
            expect(restored.video.video6847).toMatchObject({ cpuAddr: SnowAddr, lastmode: LinesPerRowMode });

            for (const { video } of [original, restored]) runCpuCycles(video, 2 * rowCycles);

            expect(original.vblanks).toEqual([]);
            expectSameFrom(original, restored);
        }
    });

    it("carries on from within field sync into the next field exactly as the original does", () => {
        const original = makeAtomVideo();
        original.video.polltime(Math.floor(CpuCyclesPerField + CpuCyclesPerLine * FieldSyncLine));

        const restored = restoreInto(original);
        expect(restored.video.video6847.inVSync).toBe(true);

        for (const { video } of [original, restored]) video.polltime(Math.floor(CpuCyclesPerField * 0.5));

        expect(original.vblanks).toEqual([false]);
        expectSameFrom(original, restored);
    });

    it("restores a VDG saved before its first poll, which has no mode yet", () => {
        const original = makeAtomVideo();
        const restored = makeAtomVideo();
        restored.video.polltime(Math.floor(CpuCyclesPerField * 0.6));
        restored.video.restoreState(original.video.snapshotState());
        restored.video.fb32.set(original.video.fb32);
        restored.vblanks.length = 0;

        for (const { video } of [original, restored]) video.polltime(Math.floor(CpuCyclesPerField * 1.5));

        expectSameFrom(original, restored);
    });

    it("leaves the VDG where it is when the snapshot predates its state", () => {
        const older = makeAtomVideo().video.snapshotState();
        delete older.video6847;

        const { video } = makeAtomVideo();
        video.polltime(Math.floor(CpuCyclesPerField * 0.6));
        const before = video.video6847.snapshotState();
        video.restoreState(older);
        expect(video.video6847.snapshotState()).toEqual(before);
    });
});
