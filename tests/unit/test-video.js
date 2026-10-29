import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    FakeAtomVideo,
    FakeVideo,
    Video,
    VDISPENABLE,
    EVERYTHINGENABLED,
    HDISPENABLE,
    OPAQUE_BLACK,
    LineCountPeriod,
    PalPhasePerLine,
    MinPaintedFrameRows,
} from "../../src/video.js";
import { texelsPerPixel } from "../../src/video-filters/pixel-grid.js";
import { decodeLineGrid } from "../helpers/line-grid.js";
import { shortestRun } from "../helpers/pixel-runs.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { checkDrainsAgainstJs } from "../helpers/compare-drains.js";
import { seededRandom } from "../helpers/seeded-random.js";

const NulaPaletteModeOn = 0x11;
const NulaPaletteModeOff = 0x10;
const NulaDisable = 0x50;
const NulaHorizontalOffsetOne = 0x21;
const NulaLeftBlankOne = 0x31;
const NulaAttributeModeOne = 0x61;
const NulaAttributeTextOn = 0x71;
const NulaFlashOffColours8To11 = 0x80;
const LogicalZeroAsPhysicalZero = 0x07;
const TwoMhzClock = 0x10;
const NulaColourZeroFullRed = [0x0f, 0x00];

const FbWidth = 1024;
const FbHeight = 768;
// A freshly constructed Video runs a 2MHz character clock, so with R0=127 a scanline is 128 characters of one
// video clock each.
const ClocksPerScanline = 128;
const ScanlinesPerFrame = 312;
const ClocksPerFrame = ClocksPerScanline * ScanlinesPerFrame;
const ClocksPerSecond = 2 * 1000 * 1000;

/**
 * A Video on a framebuffer of its own. Its CPU serves `cpu.data` and keeps only the last address read, as the
 * frame-driving tests read millions of times. `onPaint` sees the video the way main.js's paint callback does.
 */
function makeVideo({ isMaster = false, onPaint = () => {}, onVBlank = () => {}, ...options } = {}) {
    let paintCount = 0;
    let lastPaint;
    const video = new Video(
        isMaster,
        FbWidth * FbHeight,
        function (...extent) {
            paintCount++;
            lastPaint = extent;
            onPaint(this);
        },
        options,
    );
    const cpu = {
        interrupt: 0,
        data: 0,
        lastRead: undefined,
        videoRead(addr) {
            this.lastRead = addr;
            return this.data;
        },
    };
    video.reset(cpu, { cb2changecallback: null, setVBlankInt: onVBlank });
    const fb = new Uint32Array(video.fb32.buffer, video.fb32.byteOffset, video.fb32.length);
    const rig = {
        video,
        fb,
        cpu,
        paints: () => paintCount,
        lastPaint: () => lastPaint,
        resetPaints: () => (paintCount = 0),
        run: (clocks) => video.polltime(clocks),
        writeCrtc: (reg, val) => {
            video.crtc.write(0, reg);
            video.crtc.write(1, val);
        },
        // Aim R7 at the current row for a scanline, the way a program driving vsync from a VIA timer does.
        forceVSync: () => {
            rig.writeCrtc(7, 0);
            rig.run(ClocksPerScanline);
            rig.writeCrtc(7, 0x7f);
        },
    };
    return rig;
}

function programCommonTiming(v) {
    v.writeCrtc(0, 127); // Horizontal total
    v.writeCrtc(1, 80); // Horizontal displayed
    v.writeCrtc(2, 98); // Hsync position
    v.writeCrtc(3, 0x24); // Sync widths
    v.writeCrtc(5, 0); // Vertical adjust
    v.writeCrtc(6, 32); // Vertical displayed
    v.writeCrtc(8, 0); // No interlace
}

function programStandardFrame(v) {
    programCommonTiming(v);
    v.writeCrtc(4, 38); // Vertical total
    v.writeCrtc(7, 34); // Vsync position
    v.writeCrtc(9, 7); // Scanlines per character row
}

// R4=0 gives no CRTC-generated vertical structure, so vsync only happens when the program asks for it.
function programExternallySyncedTiming(v) {
    programCommonTiming(v);
    v.writeCrtc(4, 0); // Vertical total
    v.writeCrtc(9, 0); // One scanline per character row
    v.writeCrtc(7, 0x7f); // Out of reach, so the CRTC never syncs itself
}

const Mode4 = 0x88;
const Mode4Teletext = 0x8a;
const inverted = (colour) => (colour ^ 0x00ffffff) >>> 0;

function programNulaColour(v, index, red, green, blue) {
    v.video.ula.write(3, (index << 4) | red);
    v.video.ula.write(3, (green << 4) | blue);
}

// Draws one cell of `byte` at the framebuffer's origin, in the ULA's mode and palette.
function drawCellAtOrigin(v, byte) {
    const { video } = v;
    video.dispEnabled = EVERYTHINGENABLED;
    video.regs[7] = 30; // keep vsync, and the flyback it brings, away from the cell
    video.horizCounter = 10;
    video.bitmapX = -8;
    video.bitmapY = 0;
    video.oddClock = false;
    v.cpu.data = byte;
    v.run(1);
    video.renderPending();
}

// A framebuffer's worth of toEqual diff takes minutes to print.
const firstDifferentPixel = (actual, expected) => actual.findIndex((pixel, i) => pixel !== expected[i]);

function clearBothFields(video) {
    for (const frameCount of [0, 1]) {
        video.frameCount = frameCount;
        video.clearPaintBuffer();
    }
}

// MODE 7's vertical timing: with interlace sync and video the scanline
// counter steps by two, so R9 must be even for rows to end at all.
function programInterlaceSyncAndVideoFrame(v) {
    programCommonTiming(v);
    v.writeCrtc(4, 30); // Vertical total
    v.writeCrtc(5, 2); // Vertical adjust
    v.writeCrtc(6, 25); // Vertical displayed
    v.writeCrtc(7, 27); // Vsync position
    v.writeCrtc(8, 3); // Interlace sync and video
    v.writeCrtc(9, 18); // Scanlines per character row
}

// R6 above R4 stops the frame counter, so every field is drawn doubled onto both rows.
function programStuckInterlaceSyncAndVideoFrame(v) {
    programInterlaceSyncAndVideoFrame(v);
    v.writeCrtc(6, 40);
}

describe("Video", () => {
    let rig;
    let video;
    let fb;
    let cpu;

    beforeEach(() => {
        rig = makeVideo();
        ({ video, fb, cpu } = rig);
    });

    describe("ULA control register", () => {
        it.each([
            [0x00, { teletextMode: false, ulaMode: 0, pixelsPerChar: 16, halfClock: true }],
            [0x02, { teletextMode: true }],
            [0x04, { ulaMode: 1 }],
            [0x08, { ulaMode: 2 }],
            [0x0c, { ulaMode: 3 }],
            [0x10, { pixelsPerChar: 8, halfClock: false }],
        ])("decodes %#x", (value, expected) => {
            video.ula.write(0, value);
            expect(video).toMatchObject(expected);
        });

        it.each([
            [0x10, 8],
            [0x14, 4],
            [0x18, 2],
            [0x1c, 1],
        ])("gives display filters the texels per pixel %#x selects", (value, texelsWide) => {
            video.ula.write(0, value);
            expect(decodeLineGrid(video.lineGridUla).texelsWide).toBe(texelsWide);
        });

        it("records the width a cell is actually drawn at", () => {
            const r = makeVideo({ hasVideoNula: true });
            for (let colour = 0; colour < 16; ++colour) programNulaColour(r, colour, colour, colour, colour);
            r.video.ula.write(2, NulaPaletteModeOn);
            for (let ulaMode = 0; ulaMode <= 3; ++ulaMode) {
                for (const [pixelsPerChar, clockBit] of [
                    [8, TwoMhzClock],
                    [16, 0],
                ]) {
                    r.video.ula.write(0, (ulaMode << 2) | clockBit);
                    r.fb.fill(0);
                    drawCellAtOrigin(r, 0b01010101);

                    expect(shortestRun(r.fb, 0, pixelsPerChar)).toBe(texelsPerPixel(ulaMode));
                }
            }
        });
    });

    describe("the address it reads", () => {
        const Mode7 = 0x02;
        const Bitmap = 0x00;
        const InterlaceSyncAndVideo = 3;
        const ScrollModes0To2 = 2;
        const ScrollMode3 = 0;

        it.each([
            ["Mode 7's chunky address on a Master", { isMaster: true, ctrl: Mode7, addr: 0x2000 }, 0x7c00],
            ["Mode 7's from &3C00 on a Model B, with MA11 clear", { ctrl: Mode7, addr: 0x2000 }, 0x3c00],
            ["a bitmap mode's row and scanline", { addr: 0x1234, scanline: 5 }, ((0x1234 << 3) | 5) & 0x7fff],
            [
                "the even field's own scanline with interlace sync and video",
                { addr: 0x1234, scanline: 4, r8: InterlaceSyncAndVideo, field: 0 },
                ((0x1234 << 3) | 4) & 0x7fff,
            ],
            [
                "the odd field's own scanline with interlace sync and video",
                { addr: 0x1234, scanline: 4, r8: InterlaceSyncAndVideo, field: 1 },
                ((0x1234 << 3) | 5) & 0x7fff,
            ],
            // An R8 write part way through a row can leave an odd scanline count.
            [
                "the odd field's RA0 without carrying into RA1",
                { addr: 0x1234, scanline: 3, r8: InterlaceSyncAndVideo, field: 1 },
                ((0x1234 << 3) | 3) & 0x7fff,
            ],
            // beebjit: (0x1000 * 8) - 0x5000.
            ["a hardware scrolled address in modes 0-2", { addr: 0x1000, scroll: ScrollModes0To2 }, 0x3000],
            ["an address with MA12 clear, unscrolled", { addr: 0x0500, scroll: ScrollModes0To2 }, 0x2800],
            // beebjit: (0x1000 * 8) - 0x4000 + 5.
            [
                "a hardware scrolled address in mode 3, with its scanline",
                { addr: 0x1000, scanline: 5, scroll: ScrollMode3 },
                0x4005,
            ],
        ])("is %s", (_, { isMaster = false, ctrl = Bitmap, addr, scanline = 0, r8, field = 0, scroll }, expected) => {
            ({ video, cpu } = makeVideo({ isMaster }));
            video.ula.write(0, ctrl);
            if (r8 !== undefined) {
                video.crtc.write(0, 8);
                video.crtc.write(1, r8);
            }
            if (scroll !== undefined) video.setScreenHwScroll(scroll);
            video.addr = addr;
            video.scanlineCounter = scanline;
            video.frameCount = field;
            cpu.data = 0x42;

            expect(video.readVideoMem()).toBe(0x42);
            expect(cpu.lastRead).toBe(expected);
        });
    });

    describe("feeding the SAA5050", () => {
        const newestFed = () => video.teletext.snapshotState().dataQueue.at(-1);

        beforeEach(() => {
            video.dispEnabled = EVERYTHINGENABLED;
            video.bitmapX = 100;
            video.bitmapY = 100;
            video.horizCounter = 10;
            cpu.data = 0x42;
        });

        // See https://github.com/mattgodbolt/jsbeeb/issues/546 and https://github.com/mattgodbolt/jsbeeb/issues/832
        it("feeds the chip in a bitmap mode too", () => {
            video.ula.write(0, 0x00);

            video.polltime(1);

            expect(newestFed()).toBe(0x42);
        });

        // IC37/IC36 force bit 6 high during H blanking, so the chip sees a graphics character, not a control code.
        it("forces bit 6 high during H blanking", () => {
            cpu.data = 0x05;
            video.dispEnabled = VDISPENABLE;

            video.polltime(1);

            expect(newestFed()).toBe(0x45);
        });

        it("feeds it nothing outside the vertical display", () => {
            video.dispEnabled = 0;
            video.polltime(1);
            expect(newestFed()).toBe(0);
        });

        // The "TTX trick": with the teletext bit set in a 2MHz mode the SAA5050 outputs black.
        it("draws black instead of characters with the teletext bit set at 2MHz", () => {
            const WhiteGraphics = 0x17;
            const SolidBlock = 0x7f;
            const PipelineCells = 3;
            const TwoMhzCellPixels = 8;
            video.ula.write(0, 0x12);
            video.regs[7] = 30; // keep vsync, and the flyback that clears the framebuffer, away from the cell
            fb.fill(0xffffffff);

            cpu.data = WhiteGraphics;
            video.polltime(1);
            cpu.data = SolidBlock;
            video.polltime(PipelineCells + 1);
            video.renderPending();

            const cell = fb.subarray(100 * FbWidth + video.bitmapX, 100 * FbWidth + video.bitmapX + TwoMhzCellPixels);
            expect([...cell]).toEqual(Array(TwoMhzCellPixels).fill(OPAQUE_BLACK));
        });

        describe("a cell above an odd field", () => {
            const White = 0xffffffff;
            const WhiteGraphics = 0x17;
            const SolidBlock = 0x7f;
            const Teletext = 0x02;
            const TeletextAt2MHz = 0x12;
            const Spill = 8;

            // Paints a solid white graphics block with the beam at (x, y), over a white frame.
            const paintCell = (ulaControl, r8, x, y) => {
                const FeedTicks = 8;
                rig.writeCrtc(8, r8);
                rig.writeCrtc(7, 30);
                video.ula.write(0, ulaControl);
                cpu.data = WhiteGraphics;
                video.polltime(1);
                cpu.data = SolidBlock;
                video.polltime(FeedTicks);
                video.renderPending();
                fb.fill(White);
                Object.assign(video, { bitmapX: x, bitmapY: y, oddClock: false });
                video.polltime(1);
                video.renderPending();
            };
            const pixelsAt = (offset, count) => Array.from(fb.subarray(offset, offset + count));

            it.each([
                ["single", 3],
                ["doubled", 0],
            ])("paints the spill on %s rows", (_, r8) => {
                paintCell(Teletext, r8, 100, 100);
                const glyph = pixelsAt(100 * FbWidth + 108, Spill);
                expect(glyph).not.toContain(White);

                paintCell(Teletext, r8, 1008, -1);
                expect(pixelsAt(0, Spill)).toEqual(glyph);
                expect(fb[Spill]).toBe(White);
            });

            it.each([
                ["single", 3],
                ["doubled", 0],
            ])("blackens only the spill with the teletext bit set at 2MHz on %s rows", (_, r8) => {
                const HalfSpill = Spill / 2;
                paintCell(TeletextAt2MHz, r8, 1012, -1);
                expect(pixelsAt(0, HalfSpill)).toEqual(Array(HalfSpill).fill(OPAQUE_BLACK));
                expect(fb.subarray(HalfSpill).every((pixel) => pixel === White)).toBe(true);
            });
        });
    });

    // The chip runs whatever the ULA shows, so what a line shows in teletext depends on the bytes it
    // saw while the ULA showed a bitmap. See https://github.com/mattgodbolt/jsbeeb/issues/832
    describe.each(["wasm", "js"])("the SAA5050 across a frame on the %s drain", (drainKind) => {
        const RedAlpha = 0x01;
        const DoubleHeight = 0x0d;
        const LetterA = 0x41;
        const CodeColumn = 2;
        const TeletextFromColumn = 16;
        const TeletextToColumn = 32;
        const SnapshotRow = 5;
        const BlankingColumn = 50;
        const DisplayedRows = 25;
        const PaintsToRun = 3;

        // A MODE 7 shaped frame without interlace: ten scanline rows line the CRTC's rows up with the chip's.
        function programTeletextRows(r) {
            r.writeCrtc(0, 63); // Horizontal total
            r.writeCrtc(1, 40); // Horizontal displayed
            r.writeCrtc(2, 51); // Hsync position
            r.writeCrtc(3, 0x24); // Sync widths
            r.writeCrtc(4, 30); // Vertical total
            r.writeCrtc(5, 2); // Vertical adjust
            r.writeCrtc(6, DisplayedRows); // Vertical displayed
            r.writeCrtc(7, 27); // Vsync position
            r.writeCrtc(8, 0); // No interlace
            r.writeCrtc(9, 9); // Scanlines per character row
        }

        /**
         * A Video running teletext rows, fetching `byteAt(row, column)` with the ULA in `ulaAt(row, column)`, and
         * calling `afterStep` (if given) after each character clock. Its paints collect the painted framebuffer and the
         * framebuffer rows each character row reached, and `checked` compares each drain and teletext paint with
         * the JS ones.
         */
        function teletextRig({ byteAt, ulaAt, afterStep }, videoOptions) {
            const paints = [];
            let rows = new Map();
            const r = makeVideo({
                ...videoOptions,
                drainKind,
                onPaint: (v) => {
                    paints.push({ fb: v.fb32.slice(), rows });
                    rows = new Map();
                },
            });
            programTeletextRows(r);
            const checked = checkDrainsAgainstJs(r.video.drain);
            r.cpu.videoRead = () => byteAt(r.video.vertCounter, r.video.horizCounter);
            let ulaWritten;
            const step = () => {
                const { video: v } = r;
                const ula = ulaAt(v.vertCounter, v.horizCounter);
                if (ula !== ulaWritten) v.ula.write(0, ula);
                ulaWritten = ula;
                if (!rows.has(v.vertCounter)) rows.set(v.vertCounter, new Set());
                rows.get(v.vertCounter).add(v.bitmapY & ~1);
                r.run(1);
                afterStep?.(v);
            };
            return { ...r, paints, step, checked };
        }

        function runUntilPaints(rig, count) {
            while (rig.paints.length < count) rig.step();
        }

        function coloursOnRow({ fb, rows }, row) {
            const colours = new Set();
            for (const fbRow of rows.get(row) ?? []) {
                if (fbRow >= 0)
                    for (const pixel of fb.subarray(fbRow * FbWidth, (fbRow + 1) * FbWidth)) colours.add(pixel);
            }
            return colours;
        }

        const teletextColour = (v, foreground) => v.video.teletext.colour[(foreground << 2) | 3];
        const RedForeground = 1;
        const WhiteForeground = 7;

        const switchedMidLine = (code) => ({
            byteAt: (row, column) => (column === CodeColumn ? code : LetterA),
            ulaAt: (row, column) => (column >= TeletextFromColumn && column < TeletextToColumn ? Mode4Teletext : Mode4),
        });

        it.each([
            ["red text after a red code early in the line", RedAlpha, RedForeground, WhiteForeground],
            ["white text without one", LetterA, WhiteForeground, RedForeground],
        ])("shows %s when the line turns to teletext part way along", (_, code, shown, absent) => {
            const rig = teletextRig(switchedMidLine(code));
            runUntilPaints(rig, PaintsToRun);
            const colours = coloursOnRow(rig.paints.at(-1), SnapshotRow);
            expect(colours.has(teletextColour(rig, shown))).toBe(true);
            expect(colours.has(teletextColour(rig, absent))).toBe(false);
        });

        it.each([
            ["blanks the next row's normal height text", DoubleHeight, false],
            ["leaves the next row alone", LetterA, true],
        ])("given a double height code on a bitmap row, %s", (_, code, nextRowShown) => {
            const BitmapRow = 0;
            const rig = teletextRig({
                byteAt: (row, column) => (row === BitmapRow && column === CodeColumn ? code : LetterA),
                ulaAt: (row) => (row === BitmapRow ? Mode4 : Mode4Teletext),
            });
            runUntilPaints(rig, PaintsToRun);
            const white = teletextColour(rig, WhiteForeground);
            const paint = rig.paints.at(-1);
            expect(coloursOnRow(paint, BitmapRow).has(white)).toBe(false);
            expect(coloursOnRow(paint, BitmapRow + 1).has(white)).toBe(nextRowShown);
            expect(coloursOnRow(paint, BitmapRow + 2).has(white)).toBe(true);
        });

        it.each([
            ["part way along a line", TeletextFromColumn - 1],
            ["part way along the line's teletext", (TeletextFromColumn + TeletextToColumn) / 2],
            ["in the blanking after a line", BlankingColumn],
        ])("continues identically from a snapshot taken %s", (_, column) => {
            const driver = switchedMidLine(RedAlpha);
            const straight = teletextRig(driver);
            runUntilPaints(straight, PaintsToRun);

            const snapshotted = teletextRig(driver);
            runUntilPaints(snapshotted, PaintsToRun - 1);
            const { video: v } = snapshotted;
            while (v.vertCounter !== SnapshotRow || v.horizCounter !== column) snapshotted.step();
            const restored = teletextRig(driver);
            restored.video.restoreState(v.snapshotState());
            const paintsAtRestore = restored.paints.length;
            runUntilPaints(restored, paintsAtRestore + 1);
            const continued = restored.paints.at(-1);

            for (let row = SnapshotRow + 1; row < DisplayedRows; ++row) {
                expect(coloursOnRow(continued, row)).toEqual(coloursOnRow(straight.paints.at(-1), row));
            }
            expect(coloursOnRow(continued, SnapshotRow + 1).has(teletextColour(restored, RedForeground))).toBe(true);
        });

        describe("painted from the chip's log", () => {
            const BitmapRow = 6;
            const TwoMhzRow = 8;
            const CursorRow = 10;
            const CursorColumn = 12;
            const NulaRow = 14;
            const NulaColumn = 20;
            const DoubleHeightRow = 3;
            const DisplayedColumns = 40;
            const Mode7TwoMhz = Mode4Teletext | TwoMhzClock;
            const ScanlinesPerRow = 10;

            // Random bytes, control codes included, with a double height pair and teletext throughout bar a bitmap
            // stretch, a 2MHz stretch and the line ends.
            function mixedScreen(seed) {
                const random = seededRandom(seed);
                const bytes = Array.from({ length: DisplayedRows * DisplayedColumns }, () => (random() * 128) | 0);
                for (const row of [DoubleHeightRow, DoubleHeightRow + 1]) bytes[row * DisplayedColumns] = DoubleHeight;
                for (const row of [NulaRow - 1, NulaRow]) {
                    for (let column = 0; column < DisplayedColumns; ++column)
                        bytes[row * DisplayedColumns + column] = LetterA + (column % 26);
                }
                return {
                    byteAt: (row, column) => bytes[(row * DisplayedColumns + column) % bytes.length],
                    ulaAt: (row, column) => {
                        if (row === BitmapRow && column >= TeletextFromColumn && column < TeletextToColumn)
                            return Mode4;
                        if (row === TwoMhzRow && column >= TeletextFromColumn && column < TeletextToColumn)
                            return Mode7TwoMhz;
                        return Mode4Teletext;
                    },
                };
            }

            function programCursor(r, row, column) {
                r.writeCrtc(10, 0); // a steady cursor from the top scanline
                r.writeCrtc(11, ScanlinesPerRow - 1);
                const address = row * DisplayedColumns + column;
                r.writeCrtc(14, address >> 8);
                r.writeCrtc(15, address & 0xff);
            }

            const writeNulaRed = (v) => {
                if (v.vertCounter === NulaRow && v.horizCounter === NulaColumn) {
                    v.ula.write(3, (1 << 4) | 0x0f);
                    v.ula.write(3, 0x80);
                }
            };

            const InterlaceSyncAndVideo = (r) => {
                r.writeCrtc(8, 3);
                r.writeCrtc(9, 2 * ScanlinesPerRow - 2);
            };
            // An interlaced field's vsync starts and ends half way along a line.
            const InterlacedVSyncPartWayDown = (r) => {
                InterlaceSyncAndVideo(r);
                r.writeCrtc(7, NulaRow);
            };
            // Without the end of a displayed line no DISPTMG edge ends a scanline, so RA0 changes with cells unpainted.
            const NoBlankingFrom = { row: 8, scanline: 4 };
            const NoBlankingTo = { row: 12, scanline: 0 };
            const lineOf = ({ row, scanline }) => row * ScanlinesPerRow + scanline;
            const noBlankingPartWayDown = (v) => {
                if (v.horizCounter !== 0) return;
                const line = v.vertCounter * ScanlinesPerRow + v.scanlineCounter;
                const noBlanking = line >= lineOf(NoBlankingFrom) && line < lineOf(NoBlankingTo);
                v.crtc.write(0, 1);
                v.crtc.write(1, noBlanking ? 70 : DisplayedColumns);
            };
            const FramesCompared = 5;

            const differingPixels = (a, b) => a.reduce((count, pixel, i) => count + (pixel !== b[i] ? 1 : 0), 0);

            it.each([
                ["with doubled lines", () => {}, () => {}],
                ["with interlace sync and video", InterlaceSyncAndVideo, () => {}],
                ["with an interlaced vsync part way down the picture", InterlacedVSyncPartWayDown, () => {}],
                ["with no horizontal blanking on some lines", () => {}, noBlankingPartWayDown],
            ])("paints what a catch-up after every character paints, %s", (_, programTiming, retime) => {
                const screen = mixedScreen(1);
                const driven = (afterStep) => {
                    const r = teletextRig({ ...screen, afterStep }, { hasVideoNula: true });
                    programTiming(r);
                    programCursor(r, CursorRow, CursorColumn);
                    return r;
                };
                const lazy = driven((v) => {
                    retime(v);
                    writeNulaRed(v);
                });
                const eager = driven((v) => {
                    retime(v);
                    writeNulaRed(v);
                    v.teletext.catchUp();
                });

                runUntilPaints(lazy, FramesCompared);
                runUntilPaints(eager, FramesCompared);
                for (let paint = 0; paint < FramesCompared; ++paint) {
                    expect(differingPixels(lazy.paints[paint].fb, eager.paints[paint].fb)).toBe(0);
                }
                expect(lazy.checked.teletextPaints).toBeGreaterThan(0);
                expect(lazy.checked.differences).toEqual([]);

                while (lazy.video.vertCounter !== NulaRow || lazy.video.horizCounter !== NulaColumn + 4) lazy.step();
                while (eager.video.vertCounter !== NulaRow || eager.video.horizCounter !== NulaColumn + 4) eager.step();
                expect(lazy.video.snapshotState()).toEqual(eager.video.snapshotState());
                expect(differingPixels(lazy.fb, eager.fb)).toBe(0);
            });

            it("inverts the cursor over the teletext cell it painted", () => {
                const screen = { byteAt: () => LetterA, ulaAt: () => Mode4Teletext };
                const withCursor = teletextRig(screen);
                programCursor(withCursor, CursorRow, CursorColumn);
                const without = teletextRig(screen);
                programCursor(without, DisplayedRows + 1, 0);
                runUntilPaints(withCursor, PaintsToRun);
                runUntilPaints(without, PaintsToRun);

                const shown = without.paints.at(-1).fb;
                const inverts = withCursor.paints.at(-1).fb.reduce((at, pixel, i) => {
                    if (pixel !== shown[i]) at.push([i, pixel >>> 0 === inverted(shown[i])]);
                    return at;
                }, []);
                expect(inverts.length).toBeGreaterThan(0);
                expect(inverts.every(([, invertedPixel]) => invertedPixel)).toBe(true);
            });

            it("shows a VideoNuLA colour change only from where it was made", () => {
                const screen = {
                    byteAt: (row, column) => (column === 0 ? RedAlpha : LetterA),
                    ulaAt: () => Mode4Teletext,
                };
                let armed = false;
                let beam;
                const r = teletextRig(
                    {
                        ...screen,
                        afterStep: (v) => {
                            const inGlyph = v.scanlineCounter === ScanlinesPerRow / 2;
                            if (
                                v.vertCounter === NulaRow &&
                                v.horizCounter === NulaColumn &&
                                inGlyph &&
                                armed &&
                                !beam
                            ) {
                                beam = { x: v.bitmapX, y: v.bitmapY & ~1, paint: r.paints.length };
                                writeNulaRed(v);
                            }
                        },
                    },
                    { hasVideoNula: true },
                );
                const oldRed = teletextColour(r, RedForeground);
                runUntilPaints(r, PaintsToRun - 1);
                armed = true;
                while (!beam) r.step();
                runUntilPaints(r, beam.paint + 1);
                const newRed = teletextColour(r, RedForeground);
                expect(newRed).not.toBe(oldRed);

                const coloursAlong = (from, to) => new Set(r.paints[beam.paint].fb.subarray(from, to));
                const rowStart = beam.y * FbWidth;
                expect(coloursAlong(rowStart, rowStart + beam.x)).toContain(oldRed);
                expect(coloursAlong(rowStart, rowStart + beam.x)).not.toContain(newRed);
                expect(coloursAlong(rowStart + beam.x + 16, rowStart + FbWidth)).toContain(newRed);
                expect(coloursAlong(rowStart + beam.x + 16, rowStart + FbWidth)).not.toContain(oldRed);
            });

            it("draws a double height row's halves from the top and bottom of its glyphs", () => {
                const r = teletextRig({
                    byteAt: (row, column) => {
                        if (column === 0 && (row === DoubleHeightRow || row === DoubleHeightRow + 1))
                            return DoubleHeight;
                        return LetterA;
                    },
                    ulaAt: () => Mode4Teletext,
                });
                runUntilPaints(r, PaintsToRun);
                const paint = r.paints.at(-1);
                const rowPixels = (row) =>
                    [...paint.rows.get(row)].map((fbRow) => [
                        ...paint.fb.subarray(fbRow * FbWidth, (fbRow + 1) * FbWidth),
                    ]);
                const [top, bottom, normal] = [DoubleHeightRow, DoubleHeightRow + 1, DoubleHeightRow + 2].map(
                    rowPixels,
                );
                expect(top).not.toEqual(bottom);
                expect(top).not.toEqual(normal);
                expect(bottom).not.toEqual(normal);
                for (const half of [top, bottom])
                    expect(new Set(half.flat())).toContain(teletextColour(r, WhiteForeground));
            });
        });
    });

    // See Video.repaintSecondHalfOfCell.
    describe("ULA writes half way through a 1MHz cell", () => {
        const Mode0 = 0x9c;
        const Red = 0xff0000ff;
        const PhysicalRed = 1;
        const Green = 0xff00ff00;
        const AllPixelsSet = 0xff;
        const CellWidth = 16;
        const HalfCell = 8;
        // A set pixel in a two colour mode is logical colour 15.
        const SetPixelsGreen = 0xf0 | (7 ^ 2);
        const offset = 100 * FbWidth + 100;

        // Leaves the beam at the start of a cell with the body about to run on the next tick.
        const aimAtCell = () => {
            video.dispEnabled = EVERYTHINGENABLED;
            video.regs[7] = 30; // keep vsync, and the flyback it brings, away from the cell under test
            video.horizCounter = 10;
            video.bitmapX = 92;
            video.bitmapY = 100;
            video.oddClock = false;
            cpu.data = AllPixelsSet;
            for (let logical = 0; logical < 16; ++logical) video.ula.write(1, (logical << 4) | (PhysicalRed ^ 7));
        };
        beforeEach(aimAtCell);

        const cell = (at = offset) => {
            video.renderPending();
            return Array.from(fb.subarray(at, at + CellWidth));
        };
        const firstHalf = () => cell().slice(0, HalfCell);
        const secondHalf = () => cell().slice(HalfCell);

        it("repaints the second half as teletext when the teletext bit is set", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);
            expect(cell()).toEqual(Array(CellWidth).fill(Red));

            video.ula.write(0, Mode4Teletext);

            expect(firstHalf()).toEqual(Array(HalfCell).fill(Red));
            expect(secondHalf()).not.toEqual(Array(HalfCell).fill(Red));
        });

        it("repaints the second half as bitmap when the teletext bit is cleared", () => {
            video.ula.write(0, Mode4Teletext);
            video.polltime(1);
            const teletextHalf = firstHalf();
            expect(teletextHalf).not.toContain(Red);

            video.ula.write(0, Mode4);

            expect(firstHalf()).toEqual(teletextHalf);
            expect(secondHalf()).toEqual(Array(HalfCell).fill(Red));
        });

        it("applies a palette write to the second half only", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);

            video.ula.write(1, SetPixelsGreen);

            expect(video.ulaPal[15] >>> 0).toBe(Green);
            expect(firstHalf()).toEqual(Array(HalfCell).fill(Red));
            expect(secondHalf()).toEqual(Array(HalfCell).fill(Green));
        });

        it("leaves the cell alone when the write lands at the start of the next cell", () => {
            video.ula.write(0, Mode4);
            video.polltime(2);
            const before = cell();

            video.ula.write(0, Mode4Teletext);

            expect(cell()).toEqual(before);
        });

        it("leaves the frame alone while the beam is above it", () => {
            video.ula.write(0, Mode4);
            video.polltime(1);
            video.bitmapY = -1;
            video.renderPending();
            const before = fb.slice();

            video.ula.write(0, Mode4Teletext);

            expect(fb.every((pixel, i) => pixel === before[i])).toBe(true);
        });

        it.each(["wasm", "js"])(
            "leaves the clear nothing to miss when a switch to 1MHz repaints a half the %s drain never drew",
            (drainKind) => {
                ({ video, fb, cpu } = makeVideo({ drainKind }));
                aimAtCell();
                video.ula.write(0, Mode0);
                video.polltime(1);

                video.ula.write(0, Mode4);

                expect(secondHalf()).toEqual(Array(HalfCell).fill(Red));
                clearBothFields(video);
                expect(fb.every((pixel) => pixel === OPAQUE_BLACK)).toBe(true);
            },
        );

        it("leaves a 2MHz mode alone, where every tick already paints", () => {
            video.ula.write(0, Mode0);
            video.polltime(1);
            const before = cell();

            video.ula.write(1, SetPixelsGreen);

            expect(cell()).toEqual(before);
        });

        it("repaints the doubled scanline too", () => {
            video.doubledScanlines = true;
            video.interlacedSyncAndVideo = false;
            video.ula.write(0, Mode4);
            video.polltime(1);
            expect(cell(offset + FbWidth)).toEqual(Array(CellWidth).fill(Red));

            video.ula.write(1, SetPixelsGreen);

            expect(cell(offset + FbWidth).slice(HalfCell)).toEqual(Array(HalfCell).fill(Green));
        });

        it("keeps the cursor inverted over the repainted half", () => {
            video.ula.write(0, Mode4 | 0x60); // cursor on both halves of the master cursor table
            video.cursorOnThisFrame = true;
            video.cursorDrawIndex = 3;
            video.polltime(1);
            expect(cell()).toEqual(Array(CellWidth).fill(inverted(Red)));

            video.ula.write(1, SetPixelsGreen);

            expect(firstHalf()).toEqual(Array(HalfCell).fill(inverted(Red)));
            expect(secondHalf()).toEqual(Array(HalfCell).fill(inverted(Green)));
        });

        it("keeps the cursor inverted over the repainted half of a field stuck doubling its rows", () => {
            video.interlacedSyncAndVideo = true;
            video.lastRenderWasEven = video.isEvenRender;
            video.ula.write(0, Mode4 | 0x60); // cursor on both halves of the master cursor table
            video.cursorOnThisFrame = true;
            video.cursorDrawIndex = 3;
            video.polltime(1);

            video.ula.write(1, SetPixelsGreen);

            const cursorCell = [...Array(HalfCell).fill(inverted(Red)), ...Array(HalfCell).fill(inverted(Green))];
            expect(cell()).toEqual(cursorCell);
            expect(cell(offset + FbWidth)).toEqual(cursorCell);
        });
    });

    describe("cells the beam has passed", () => {
        const White = 0xffffffff;
        const AllPixelsSet = 0xff;
        const offset = 100 * FbWidth + 100;

        const passCell = (r) => {
            Object.assign(r.video, {
                dispEnabled: EVERYTHINGENABLED,
                horizCounter: 10,
                bitmapX: 92,
                bitmapY: 100,
                oddClock: false,
            });
            r.video.regs[7] = 30;
            r.cpu.data = AllPixelsSet;
            r.run(1);
        };

        it.each([
            ["an R8 write", (r) => r.writeCrtc(8, 0)],
            ["a snapshot", (r) => r.video.snapshotState()],
            [
                "a flyback too early in the field to paint",
                (r) => {
                    r.video.bitmapY = MinPaintedFrameRows - 2;
                    r.video.flyback();
                },
            ],
        ])("are drawn by %s", (_, event) => {
            passCell(rig);
            expect(fb[offset]).toBe(OPAQUE_BLACK);
            event(rig);
            expect(fb[offset]).toBe(White);
        });

        it.each([
            ["paint", (r) => r.video.paint()],
            [
                "debugPaint",
                (r) => {
                    r.video.bitmapY = 400; // keep the beam's dot off the cell
                    r.video.debugPaint();
                },
            ],
        ])("are handed over by %s", (_, event) => {
            let seen;
            const r = makeVideo({ onPaint: (v) => (seen = v.fb32[offset] >>> 0) });
            passCell(r);
            event(r);
            expect(seen).toBe(White);
        });

        it("are drawn in the palette they were passed in when a power-on reset changes it", () => {
            const Red = 0xff0000ff;
            const r = makeVideo({ hasVideoNula: true });
            programNulaColour(r, 15, 0xf, 0x0, 0x0);
            r.video.ula.write(2, NulaPaletteModeOn);
            passCell(r);
            r.video.reset(r.cpu, { cb2changecallback: null, setVBlankInt: () => {} }, true);
            expect(r.fb[offset]).toBe(Red);
        });

        it("are drawn in the palette they were passed in when a restore changes it", () => {
            const Red = 0xff0000ff;
            const PhysicalRed = 1;
            const saved = video.snapshotState();
            video.ula.write(1, 0xf0 | (PhysicalRed ^ 7));
            passCell(rig);
            video.restoreState(saved);
            expect(fb[offset]).toBe(Red);
        });

        // A 1MHz cell at the right edge of the line above an odd field spills onto row 0.
        it.each([
            ["single", 3],
            ["doubled", 0],
        ])("spill onto row 0 from above an odd field on %s rows", (_, r8) => {
            rig.writeCrtc(8, r8);
            video.ula.write(0, 0x00);
            passCell(rig);
            Object.assign(video, { bitmapX: 1008, bitmapY: -1, oddClock: false });
            rig.run(1);
            video.renderPending();
            expect(Array.from(fb.subarray(0, 8))).toEqual(Array(8).fill(White));
            expect(fb[8]).toBe(OPAQUE_BLACK);
        });

        it.each([
            ["single", 3],
            ["doubled", 0],
        ])("invert their spill onto row 0 under the cursor on %s rows", (_, r8) => {
            const CursorOnFirstCell = 0x80;
            rig.writeCrtc(8, r8);
            video.ula.write(0, CursorOnFirstCell);
            passCell(rig);
            Object.assign(video, {
                bitmapX: 1008,
                bitmapY: -1,
                oddClock: false,
                cursorOnThisFrame: true,
                cursorDrawIndex: 3,
            });
            rig.run(1);
            video.renderPending();
            expect(Array.from(fb.subarray(0, 8))).toEqual(Array(8).fill(OPAQUE_BLACK));
            expect(fb[8]).toBe(OPAQUE_BLACK);
        });
    });

    describe.each(["wasm", "js"])("the clear between frames on the %s drain", (drainKind) => {
        const AllPixelsSet = 0xff;
        const CursorOnFirstCell = 0x80;
        const InBorder = EVERYTHINGENABLED & ~HDISPENABLE;
        const Mode0 = 0x9c;
        const WideR1 = 80;
        const NarrowR1 = 20;

        describe.each([
            ["single", 3],
            ["doubled", 0],
        ])("on %s rows", (_, r8) => {
            beforeEach(() => {
                rig = makeVideo({ drainKind });
                ({ video, fb, cpu } = rig);
                rig.writeCrtc(8, r8);
            });

            // A cursor shows by inverting a black cell.
            it.each([
                ["a cell running past the end of its row", 100, 0x00, AllPixelsSet, EVERYTHINGENABLED],
                ["a cursor running past the end of its row", 100, CursorOnFirstCell, 0, EVERYTHINGENABLED],
                ["a cell above an odd field", -1, 0x00, AllPixelsSet, EVERYTHINGENABLED],
                ["a teletext cursor in the border", 100, Mode4Teletext | CursorOnFirstCell, 0, InBorder],
            ])("blacks out %s", (_, bitmapY, ulaControl, byte, dispEnabled) => {
                video.ula.write(0, ulaControl);
                video.ula.write(1, LogicalZeroAsPhysicalZero);
                Object.assign(video, {
                    dispEnabled,
                    horizCounter: 10,
                    bitmapX: 1008,
                    bitmapY,
                    oddClock: false,
                    cursorOnThisFrame: true,
                    cursorDrawIndex: 3,
                });
                video.regs[7] = 30;
                cpu.data = byte;
                rig.run(1);
                video.renderPending();
                expect(fb.some((pixel) => pixel !== OPAQUE_BLACK)).toBe(true);
                clearBothFields(video);
                expect(fb.every((pixel) => pixel === OPAQUE_BLACK)).toBe(true);
            });
        });

        // A video that only ever drew the second picture paints the same frame, so the first left nothing behind.
        describe.each([
            ["doubled rows", programStandardFrame],
            ["interlace sync and video", programInterlaceSyncAndVideoFrame],
        ])("on %s", (_, program) => {
            const lastPaintedFrame = (steps) => {
                let painted;
                const r = makeVideo({ drainKind, onPaint: (v) => (painted = v.fb32.slice()) });
                program(r);
                r.cpu.data = AllPixelsSet;
                for (const [ulaControl, r1, frames] of steps) {
                    r.video.ula.write(0, ulaControl);
                    r.writeCrtc(1, r1);
                    r.run(frames * ClocksPerFrame);
                }
                return painted;
            };

            it.each([
                ["a bitmap frame after a wider bitmap one", Mode0, Mode0],
                ["a bitmap frame after a wider teletext one", Mode4Teletext, Mode0],
                ["a teletext frame after a wider bitmap one", Mode0, Mode4Teletext],
                ["a teletext frame after a wider teletext one", Mode4Teletext, Mode4Teletext],
            ])("leaves no pixels of the first frame in %s", (_, before, after) => {
                const expected = lastPaintedFrame([[after, NarrowR1, 6]]);
                const actual = lastPaintedFrame([
                    [before, WideR1, 2],
                    [after, NarrowR1, 4],
                ]);
                expect(firstDifferentPixel(actual, expected)).toBe(-1);
            });
        });
    });

    // The hashes were recorded from the renderer that drew each cell into the framebuffer as the beam reached it.
    describe("raster effects", () => {
        const RasterFrames = 6;
        const MaxClocksBetweenWrites = 40;
        const CursorBits = [0x00, 0x20, 0x40, 0x60, 0x80, 0xe0];
        const NulaControls = [NulaPaletteModeOn, NulaPaletteModeOff, 0x80, 0x90];
        const FnvOffsetBasis = 0x811c9dc5;
        const FnvPrime = 0x01000193;

        function frameHash(v) {
            let hash = FnvOffsetBasis;
            for (const word of v.fb32) hash = Math.imul(hash ^ word, FnvPrime);
            for (const row of v.lineGrid) hash = Math.imul(hash ^ row, FnvPrime);
            return hash >>> 0;
        }

        function paintedHashes(program, { seed, hasVideoNula }, drainKind) {
            const hashes = [];
            const r = makeVideo({ hasVideoNula, drainKind, onPaint: (v) => hashes.push(frameHash(v)) });
            const checked = checkDrainsAgainstJs(r.video.drain);
            const random = seededRandom(seed);
            const pick = (n) => Math.floor(random() * n);
            r.cpu.videoRead = (addr) => Math.imul(addr ^ 0x5bd1e995, 0x27d4eb2d) >>> 24;
            program(r);
            r.writeCrtc(10, 0); // a steady cursor from the top scanline
            r.writeCrtc(11, 7);
            const writes = [
                () => r.video.ula.write(1, pick(256)),
                () =>
                    r.video.ula.write(
                        0,
                        CursorBits[pick(CursorBits.length)] |
                            (pick(2) << 4) |
                            (pick(4) << 2) |
                            (pick(16) ? 0 : 0x02) |
                            pick(2),
                    ),
                () => {
                    r.writeCrtc(14, pick(0x0a));
                    r.writeCrtc(15, pick(256));
                },
                () => r.video.ula.write(2, NulaControls[pick(NulaControls.length)] | pick(16)),
                () => r.video.ula.write(3, pick(256)),
            ];
            const choices = hasVideoNula ? writes.length : writes.length - 2;
            for (let clocks = 0; clocks < RasterFrames * ClocksPerFrame;) {
                const gap = 1 + pick(MaxClocksBetweenWrites);
                r.run(gap);
                clocks += gap;
                writes[pick(choices)]();
            }
            return { hashes, checked };
        }

        it("runs the Wasm drain in Node", () => {
            expect(video.drain.kind).toBe("wasm");
        });

        describe.each(["wasm", "js"])("on the %s drain", (drainKind) => {
            it.each([
                [
                    "with interlace sync on a stock ULA",
                    (v) => {
                        programStandardFrame(v);
                        v.writeCrtc(8, 1);
                    },
                    { seed: 1, hasVideoNula: false },
                    [2206297541, 2206297541, 3715053517, 1469768717, 3659289193],
                ],
                [
                    "on doubled rows with a VideoNuLA",
                    programStandardFrame,
                    { seed: 2, hasVideoNula: true },
                    [2206297541, 2206297541, 2165725467, 508035057, 977855931],
                ],
                [
                    "with interlace sync and video",
                    programInterlaceSyncAndVideoFrame,
                    { seed: 3, hasVideoNula: true },
                    [2206297541, 2206297541, 2897231635, 595029415, 4284534895],
                ],
                [
                    "with interlace sync and video stuck on one field",
                    (v) => {
                        programInterlaceSyncAndVideoFrame(v);
                        v.writeCrtc(6, 40);
                    },
                    { seed: 4, hasVideoNula: true },
                    [2206297541, 2206297541, 2410138283, 180526969, 4265788461],
                ],
            ])("paints ULA writes every few clocks %s as the beam saw them", (_, program, options, expected) => {
                const { hashes, checked } = paintedHashes(program, options, drainKind);
                expect(hashes).toEqual(expected);
                expect(checked.drains).toBeGreaterThan(0);
                expect(checked.differences).toEqual([]);
            });
        });
    });

    describe("the VideoNuLA fitting", () => {
        it.each([
            ["a mode to &FE22 as a control write", 2, 0x08, (v) => [v.ulactrl, v.ulaMode], [0x08, 2]],
            ["a colour to &FE23 as a palette write", 3, 0x17, (v) => v.actualPal[1], 7],
            [
                "a NULA palette mode command as a control write",
                2,
                NulaPaletteModeOn,
                (v) => [v.ulactrl, v.ula.paletteMode],
                [NulaPaletteModeOn, 0],
            ],
            [
                "a NULA offset command as a control write",
                2,
                NulaHorizontalOffsetOne,
                (v) => [v.ulactrl, v.ula.horizontalOffset],
                [NulaHorizontalOffsetOne, 0],
            ],
        ])("takes %s on a stock ULA", (_, reg, value, read, expected) => {
            video.ula.write(reg, value);
            expect(read(video)).toEqual(expected);
        });

        it("tells whoever asked, once, when software first writes to the missing NuLA", () => {
            const onMissingVideoNula = vi.fn();
            ({ video } = makeVideo({ onMissingVideoNula }));
            video.ula.write(0, 0x08);
            video.ula.write(1, 0x17);
            expect(onMissingVideoNula).not.toHaveBeenCalled();
            video.ula.write(3, 0x17);
            video.ula.write(2, NulaPaletteModeOn);
            expect(onMissingVideoNula).toHaveBeenCalledTimes(1);
        });

        it("tells nobody of a write to the B's mirrors above &FE23, where a Master disc probe lands", () => {
            const onMissingVideoNula = vi.fn();
            ({ video } = makeVideo({ onMissingVideoNula }));
            for (const addr of [0xfe26, 0xfe27, 0xfe2a, 0xfe2b, 0xfe2e, 0xfe2f]) video.ula.write(addr, 0x08);
            expect(onMissingVideoNula).not.toHaveBeenCalled();
            video.ula.write(0xfe22, 0x08);
            expect(onMissingVideoNula).toHaveBeenCalledTimes(1);
        });

        it("tells nobody when a fitted NULA that software disabled is written to", () => {
            const onMissingVideoNula = vi.fn();
            ({ video } = makeVideo({ hasVideoNula: true, onMissingVideoNula }));
            video.ula.write(2, NulaDisable);
            video.ula.write(2, NulaPaletteModeOn);
            expect(onMissingVideoNula).not.toHaveBeenCalled();
        });

        it("starts a fitted NULA enabled, taking &FE22 as its own until disabled", () => {
            ({ video } = makeVideo({ hasVideoNula: true }));
            video.ula.write(0, 0x08);
            video.ula.write(2, NulaPaletteModeOn);
            expect(video.ula.paletteMode).toBe(1);
            expect(video.ulactrl).toBe(0x08);
            video.ula.write(2, NulaDisable);
            video.ula.write(2, 0x1c);
            expect(video.ulactrl).toBe(0x1c);
        });

        it("comes back enabled and in its power-on state after a power-on reset", () => {
            const fresh = makeVideo({ hasVideoNula: true }).video;
            ({ video, cpu } = makeVideo({ hasVideoNula: true }));
            for (const v of [fresh, video]) v.ula.write(1, LogicalZeroAsPhysicalZero);
            for (const write of [
                NulaPaletteModeOn,
                NulaHorizontalOffsetOne,
                NulaLeftBlankOne,
                NulaAttributeModeOne,
                NulaAttributeTextOn,
                NulaFlashOffColours8To11,
            ])
                video.ula.write(2, write);
            for (const byte of NulaColourZeroFullRed) video.ula.write(3, byte);
            video.ula.write(2, NulaDisable);

            video.reset(cpu, video.sysvia, true);

            expect(video.ula.snapshotState()).toEqual(fresh.ula.snapshotState());
            expect(video.ulaPal).toEqual(fresh.ulaPal);
        });

        it("stays disabled through BREAK", () => {
            ({ video, cpu } = makeVideo({ hasVideoNula: true }));
            video.ula.write(2, NulaDisable);

            video.reset(cpu, video.sysvia, false);

            video.ula.write(2, 0x1c);
            expect(video.ulactrl).toBe(0x1c);
        });

        it("still folds &FE22 onto &FE20 on a stock ULA after a power-on reset", () => {
            video.reset(cpu, video.sysvia, true);

            video.ula.write(2, NulaPaletteModeOn);
            expect(video.ulactrl).toBe(NulaPaletteModeOn);
        });
    });

    describe("NULA palette mode", () => {
        const UlaColour = 0xffaa0000;
        const UlaColourIndex = 3;
        const NulaColour = 0xff0000bb;
        const AllPixelsColour15 = 0xff;

        it.each([
            ["the ULA palette, through its XOR 7 mapping, by default", 0x1c, 8, [], UlaColour],
            ["NULA's colours directly in palette mode", 0x1c, 8, [NulaPaletteModeOn], NulaColour],
            ["NULA's colours in a 16 pixel mode too", 0x08, 16, [NulaPaletteModeOn], NulaColour],
            [
                "the ULA palette again once palette mode is off",
                0x1c,
                8,
                [NulaPaletteModeOn, NulaPaletteModeOff],
                UlaColour,
            ],
        ])("draws with %s", (_, ctrl, pixels, nulaWrites, expected) => {
            const r = makeVideo({ hasVideoNula: true });
            r.video.ula.write(0, ctrl);
            programNulaColour(r, UlaColourIndex, 0x0, 0x0, 0xa);
            programNulaColour(r, 15, 0xb, 0x0, 0x0);
            r.video.ula.write(1, 0xf0 | (UlaColourIndex ^ 7));
            for (const write of nulaWrites) r.video.ula.write(2, write);

            drawCellAtOrigin(r, AllPixelsColour15);

            expect(Array.from(r.fb.subarray(0, pixels))).toEqual(Array(pixels).fill(expected));
        });
    });

    describe("Painting short frames", () => {
        it("should paint once per frame for a normally programmed display", () => {
            const v = makeVideo();
            programStandardFrame(v);
            v.resetPaints();

            v.run(10 * ClocksPerFrame);

            expect(v.paints()).toBe(10);
        });

        it("should paint once per frame for an R4=0 display synced externally", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);

            const paintsPerFrame = [];
            for (let frame = 0; frame < 10; ++frame) {
                v.run(ClocksPerFrame - ClocksPerScanline);
                // Count only the paints the vsync itself produces.
                v.resetPaints();
                v.forceVSync();
                paintsPerFrame.push(v.paints());
            }

            expect(paintsPerFrame).toEqual(Array(10).fill(1));
        });

        it("should not paint frames too short to hold a picture", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);
            v.resetPaints();

            // A vsync every few scanlines, as the boot-up register values give.
            for (let frame = 0; frame < 1000; ++frame) {
                v.run(4 * ClocksPerScanline);
                v.forceVSync();
            }

            expect(v.paints()).toBe(0);
        });

        it("should paint when the beam runs off the bottom without a vsync", () => {
            const v = makeVideo();
            programExternallySyncedTiming(v);
            v.resetPaints();

            v.run(ClocksPerSecond);

            // The beam gives up and flies back every 384 scanlines.
            expect(v.paints()).toBe(Math.floor(ClocksPerSecond / (384 * ClocksPerScanline)));
        });
    });

    // tests/hardware/crtc-interlace runs this same chain on a real machine.
    describe("Interlace sync across CRTC frame restarts", () => {
        const ChainR4 = 3;
        const ChainFrameLines = 32;
        const FieldRows = 39;
        const FirstWriteLines = 46;
        const SettleFields = 8;
        const MeasuredFields = 8;
        const Sentinel = 0x12345678;

        // Each field is `chainFrames` short frames, then one holding R6, R7 and the
        // vsync, sized so the field is 312 lines. R4 is rewritten a row into windows
        // four rows wide, timed from the vsync as a program timed from its interrupt.
        // Returns each measured field's length in lines, vsync rise to vsync rise.
        function runChain({
            chainFrames,
            r6Gap,
            interlaceSyncAndVideo = false,
            onScanline = () => {},
            onSettled = () => {},
            onVsync = () => {},
        }) {
            let vsyncRose;
            const v = makeVideo({
                onVBlank: (level) => {
                    if (level) vsyncRose = true;
                },
            });
            const qr4 = FieldRows - 1 - 4 * chainFrames;
            programCommonTiming(v);
            v.writeCrtc(4, qr4);
            v.writeCrtc(6, ChainR4 + r6Gap);
            v.writeCrtc(7, qr4 - 4);
            // Interlace sync and video steps the scanline counter by two, so R9=14
            // keeps eight lines a row.
            v.writeCrtc(8, interlaceSyncAndVideo ? 3 : 1);
            v.writeCrtc(9, interlaceSyncAndVideo ? 14 : 7);

            let clocks = 0;
            const tick = () => {
                v.run(1);
                clocks++;
                if (clocks % ClocksPerScanline === 0) onScanline(v.video);
            };
            const runLines = (lines) => {
                for (let i = 0; i < lines * ClocksPerScanline; i++) tick();
            };
            const vsyncs = [];
            while (vsyncs.length <= SettleFields + MeasuredFields) {
                vsyncRose = false;
                for (let waited = 0; !vsyncRose; waited++) {
                    if (waited > 2 * ClocksPerFrame)
                        throw new Error(`No vsync within two frames of field ${vsyncs.length}`);
                    tick();
                }
                vsyncs.push(clocks);
                if (vsyncs.length === SettleFields + 1) onSettled(v.video);
                onVsync(v.video, vsyncs.length - SettleFields - 1);
                if (!chainFrames) continue;
                runLines(FirstWriteLines);
                v.writeCrtc(4, ChainR4);
                runLines(ChainFrameLines * chainFrames + 4);
                v.writeCrtc(4, qr4);
            }
            const measured = vsyncs.slice(SettleFields);
            return measured.slice(1).map((at, i) => (at - measured[i]) / ClocksPerScanline);
        }

        const pairs = (fields) => fields.filter((_, i) => i % 2 === 0).map((field, i) => [field, fields[2 * i + 1]]);

        it("should give a single frame per field half a line more than 312 in every field", () => {
            expect(runChain({ chainFrames: 0, r6Gap: 2 })).toEqual(Array(MeasuredFields).fill(312.5));
        });

        it("should add the dummy raster to every frame that ends on the even field", () => {
            for (const chainFrames of [1, 2, 4]) {
                for (const pair of pairs(runChain({ chainFrames, r6Gap: 2 }))) {
                    expect(pair.toSorted()).toEqual([312.5, 312.5 + chainFrames]);
                }
            }
        });

        // The dummy raster counts as row R4+1, so there it is an R6 hit, which counts a
        // frame and flips the parity for the rest of the field: MODE7-75's shape.
        it("should count an R6 hit in the dummy raster as a frame", () => {
            for (const chainFrames of [1, 2, 4]) {
                expect(runChain({ chainFrames, r6Gap: 1 })).toEqual(Array(MeasuredFields).fill(314));
            }
        });

        function doublingThroughMeasuredFields(r6Gap) {
            const seen = new Set();
            let settled = false;
            runChain({
                chainFrames: 2,
                r6Gap,
                interlaceSyncAndVideo: true,
                onSettled: () => (settled = true),
                onScanline: (video) => settled && seen.add(video.doublesLines()),
            });
            return [...seen];
        }

        it("should keep interlaced rows for a whole field while fields alternate", () => {
            expect(doublingThroughMeasuredFields(2)).toEqual([false]);
        });

        it("should double every row of a field when fields stop alternating", () => {
            expect(doublingThroughMeasuredFields(1)).toEqual([true]);
        });

        // Fills the framebuffer just after the settling flyback, and reports for each
        // parity whether any of its rows still hold the fill after the next flyback,
        // along with the parity the field after that flyback draws.
        function rowsKeptFromEarlierField(r6Gap) {
            const kept = [];
            let nextFieldParity = null;
            runChain({
                chainFrames: 2,
                r6Gap,
                interlaceSyncAndVideo: true,
                onSettled: (video) => {
                    video.fb32.fill(Sentinel);
                    video.drain.markAllDrawn();
                },
                onVsync: (video, field) => {
                    if (field !== 1) return;
                    nextFieldParity = video.frameCount & 1;
                    for (const parity of [0, 1]) {
                        let found = false;
                        for (let row = parity; row < 625 && !found; row += 2) {
                            found = video.fb32.subarray(row * 1024, (row + 1) * 1024).includes(Sentinel);
                        }
                        kept.push(found);
                    }
                },
            });
            return { kept, nextFieldParity };
        }

        it("should clear only the next field's rows while fields alternate", () => {
            const { kept, nextFieldParity } = rowsKeptFromEarlierField(2);
            expect(kept[nextFieldParity]).toBe(false);
            expect(kept[1 - nextFieldParity]).toBe(true);
        });

        it("should leave no rows from an earlier field when fields stop alternating", () => {
            expect(rowsKeptFromEarlierField(1).kept).toEqual([false, false]);
        });
    });

    // The field detection loop of beebjit's isv_gfx_mode test.
    describe("Interlace sync turned on during a vsync", () => {
        const ClocksIntoVsync = 16;
        const HalfLineClocks = ClocksPerScanline / 2;
        const SettleFrames = 2;
        const MeasuredFrames = 8;
        const InterlacedFramePairClocks = 625 * ClocksPerScanline;

        // Per frame, the vsync edges in the half line after turning interlace sync on
        // just after the vsync rises.
        function vsyncEdgesAfterInterlaceOn() {
            const edges = [];
            const v = makeVideo({ onVBlank: (level) => edges.push(level) });
            programStandardFrame(v);
            const perFrame = [];
            for (let frame = 0; frame < SettleFrames + MeasuredFrames; frame++) {
                edges.length = 0;
                for (let waited = 0; !edges.includes(true); waited++) {
                    if (waited > 2 * ClocksPerFrame) throw new Error(`No vsync in frame ${frame}`);
                    v.run(1);
                }
                v.run(ClocksIntoVsync);
                edges.length = 0;
                v.writeCrtc(8, 1);
                v.run(HalfLineClocks);
                perFrame.push([...edges]);
                v.writeCrtc(8, 0);
            }
            return perFrame.slice(SettleFrames);
        }

        it("should give isv_gfx_mode's loop a second vsync half a line late on alternate fields", () => {
            const perFrame = vsyncEdgesAfterInterlaceOn();
            const second = perFrame.filter((edges) => edges.length);
            expect(second).toEqual(Array(MeasuredFrames / 2).fill([false, true]));
            perFrame.slice(1).forEach((edges, i) => expect(edges.length).not.toBe(perFrame[i].length));
        });

        it("should raise the vsync once a field when interlace sync stays on", () => {
            let rises = 0;
            const v = makeVideo({
                onVBlank: (level) => {
                    if (level) rises++;
                },
            });
            programStandardFrame(v);
            v.writeCrtc(8, 1);
            v.run(SettleFrames * ClocksPerFrame);
            rises = 0;

            v.run((MeasuredFrames / 2) * InterlacedFramePairClocks);

            expect(rises).toBe(MeasuredFrames);
        });

        // R7 written after half R0 starts only the line-start vsync, here timed to end on
        // the first character of the next frame, as the field changes to select it.
        it("should not pulse the vsync when a field change selects a line-start vsync as it ends", () => {
            const R7Row = 16;
            const Frames = 6;
            const pulses = [];
            let clocks = 0;
            let roseAt = null;
            const v = makeVideo({
                onVBlank: (level) => {
                    if (level) roseAt = clocks;
                    else pulses.push(clocks - roseAt);
                },
            });
            programCommonTiming(v);
            v.writeCrtc(3, 0x64);
            v.writeCrtc(4, 20);
            v.writeCrtc(6, 10);
            v.writeCrtc(7, 0x7f);
            v.writeCrtc(8, 1);
            v.writeCrtc(9, 0);
            const runUntil = (condition) => {
                for (let waited = 0; !condition(); waited++) {
                    if (waited > 2 * ClocksPerFrame) throw new Error("Never reached the row");
                    v.run(1);
                    clocks++;
                }
            };
            const { video } = v;
            for (let frame = 0; frame < Frames; frame++) {
                runUntil(() => video.vertCounter === R7Row && video.horizCounter > HalfLineClocks);
                v.writeCrtc(7, R7Row);
                runUntil(() => video.vertCounter === R7Row + 2);
                v.writeCrtc(7, 0x7f);
            }

            expect(pulses.length).toBeGreaterThan(0);
            expect(Math.min(...pulses)).toBeGreaterThan(ClocksPerScanline);
        });
    });

    describe("PAL line phase", () => {
        // The field parity bookkeeping takes a frame or two to settle after
        // the registers change, as it does on a mode change.
        const SettleFrames = 4;

        const programNonInterlacedFrame = (v) => programStandardFrame(v);

        function programInterlaceSyncFrame(v) {
            programStandardFrame(v);
            v.writeCrtc(8, 1);
        }

        // The line and phase bases of each painted frame, read as main.js reads them.
        function paintedBases(program, frames) {
            const painted = [];
            const v = makeVideo({
                onPaint: (video) =>
                    painted.push({
                        lineEven: video.lineBaseEven,
                        lineOdd: video.lineBaseOdd,
                        phaseEven: video.phaseBaseEven,
                        phaseOdd: video.phaseBaseOdd,
                    }),
            });
            program(v);
            v.run(SettleFrames * ClocksPerFrame);
            painted.length = 0;
            v.run(frames * ClocksPerFrame);
            return painted;
        }

        function advances(values) {
            return values.slice(1).map((value, i) => (value - values[i] + LineCountPeriod) % LineCountPeriod);
        }

        const phaseStep = (lines) => (((lines * PalPhasePerLine) % 1) + 1) % 1;
        const phaseAdvance = (from, to) => (to - from + 1) % 1;
        const circularDistance = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

        // Line counts come back modulo LineCountPeriod, which the phase is not periodic in,
        // so the lines really elapsed may be a period more, or a period fewer when the
        // later base was recorded first.
        function expectPhaseAdvanceOver(lines, from, to) {
            const advance = phaseAdvance(from, to);
            const candidates = [-1, 0, 1].map((periods) => phaseStep(lines + periods * LineCountPeriod));
            expect(Math.min(...candidates.map((c) => circularDistance(advance, c)))).toBeLessThan(1e-6);
        }

        function expectPhasesFollowLines(painted, line, phase) {
            advances(painted.map((p) => p[line])).forEach((lines, i) =>
                expectPhaseAdvanceOver(lines, painted[i][phase], painted[i + 1][phase]),
            );
        }

        const oddFieldBases = (painted) => painted.map((p) => [p.lineOdd, p.phaseOdd]);
        const evenFieldBases = (painted) => painted.map((p) => [p.lineEven, p.phaseEven]);

        it("should not advance the phase by half a cycle over a 312-line frame", () => {
            expect(Math.abs(((ScanlinesPerFrame * PalPhasePerLine) % 1) - 0.5)).toBeGreaterThan(0.1);
        });

        it("should advance both bases by a whole frame of lines without interlace", () => {
            const painted = paintedBases(programNonInterlacedFrame, 10);
            expect(oddFieldBases(painted)).toEqual(evenFieldBases(painted));
            expect(advances(painted.map((p) => p.lineEven))).toEqual(Array(9).fill(ScanlinesPerFrame));
            for (const { lineEven } of painted) expect(lineEven).toBeLessThan(LineCountPeriod);
            expectPhasesFollowLines(painted, "lineEven", "phaseEven");
        });

        it("should advance by alternate 312 and 313 line fields with interlace sync", () => {
            const painted = paintedBases(programInterlaceSyncFrame, 8);
            expect(oddFieldBases(painted)).toEqual(evenFieldBases(painted));
            const steps = advances(painted.map((p) => p.lineEven));
            expect(steps.length).toBeGreaterThanOrEqual(6);
            for (let i = 1; i < steps.length; ++i) expect(steps[i - 1] + steps[i]).toBe(625);
            expect(new Set(steps)).toEqual(new Set([312, 313]));
            expectPhasesFollowLines(painted, "lineEven", "phaseEven");
        });

        it("should keep a base per field with interlace sync and video", () => {
            const painted = paintedBases(programInterlaceSyncAndVideoFrame, 8);
            // Each field updates only its own rows' base, so each base changes
            // every other frame and by two fields' worth of lines when it does.
            for (const [line, phase] of [
                ["lineEven", "phaseEven"],
                ["lineOdd", "phaseOdd"],
            ]) {
                const steps = advances(painted.map((p) => p[line]));
                expect(steps.length).toBeGreaterThanOrEqual(6);
                for (let i = 1; i < steps.length; ++i) expect([steps[i - 1], steps[i]].sort()).toEqual([0, 625]);
                expectPhasesFollowLines(painted, line, phase);
            }
            // The odd field's first row is one more line of phase on from the even field's.
            const last = painted.at(-1);
            const [between] = advances([last.lineEven, last.lineOdd]);
            expect(between).not.toBe(0);
            expectPhaseAdvanceOver(between, last.phaseEven, last.phaseOdd);
        });

        // Every painted row must decode to the hsync count it was drawn under,
        // in whichever rows the mode puts a scanline.
        it.each([
            ["without interlace", programNonInterlacedFrame],
            ["with interlace sync", programInterlaceSyncFrame],
            ["with interlace sync and video", programInterlaceSyncAndVideoFrame],
            ["with interlace sync and video stuck on one field", programStuckInterlaceSyncAndVideoFrame],
        ])("should decode every row to the line it was drawn under %s", (_, program) => {
            // Each cell shows the low byte of the hsync count it was fetched under, as two pixels of
            // NuLA colour: the high nibble, then the low one.
            const TwoPixelsPerCell = 0x14;
            const LineBits = 0xff;
            const PixelsPerNibble = 4;
            const colourOfNibble = (nibble) =>
                (0xff000000 | (0x55 << 16) | (((15 - nibble) * 0x11) << 8) | (nibble * 0x11)) >>> 0;
            const nibbleOfColour = new Map(Array.from({ length: 16 }, (_, nibble) => [colourOfNibble(nibble), nibble]));
            const spread = (nibble) =>
                ((nibble & 1) << 1) | ((nibble & 2) << 2) | ((nibble & 4) << 3) | ((nibble & 8) << 4);
            const cellOfLineBits = (bits) => spread(bits >> 4) | (spread(bits & 0xf) >> 1);

            const mismatches = [];
            let checking = false;
            let paints = 0;
            let rowsChecked = 0;
            const v = makeVideo({
                hasVideoNula: true,
                onPaint: (video) => {
                    if (!checking) return;
                    paints++;
                    for (let row = 0; row < 625; ++row) {
                        const rowPixels = v.fb.subarray(row * FbWidth, (row + 1) * FbWidth);
                        const x = rowPixels.findIndex((colour) => colour !== OPAQUE_BLACK);
                        if (x < 0) continue;
                        rowsChecked++;
                        const base = row & 1 ? video.lineBaseOdd : video.lineBaseEven;
                        const decoded = ((base + (row >> 1)) % LineCountPeriod) & LineBits;
                        const line =
                            (nibbleOfColour.get(rowPixels[x]) << 4) |
                            nibbleOfColour.get(rowPixels[x + PixelsPerNibble]);
                        if (decoded !== line) mismatches.push({ row, line, decoded });
                    }
                },
            });
            for (let nibble = 0; nibble < 16; ++nibble) programNulaColour(v, nibble, nibble, 15 - nibble, 5);
            v.video.ula.write(2, NulaPaletteModeOn);
            v.video.ula.write(0, TwoPixelsPerCell);
            v.cpu.videoRead = () => cellOfLineBits(v.video.hsyncCount & LineBits);
            program(v);
            v.run(SettleFrames * ClocksPerFrame);
            checking = true;
            v.run(6 * ClocksPerFrame);

            expect(paints).toBeGreaterThan(2);
            expect(rowsChecked).toBeGreaterThan(200 * paints);
            expect(mismatches).toEqual([]);
        });
    });

    describe("the cursor with interlace sync and video", () => {
        const SetPixelsRed = 0xf0 | (7 ^ 1);
        const Red = 0xff0000ff;
        const Sentinel = 0xff123456;
        const InvertedRed = inverted(Red);

        // The last few painted frames of a cursor on the first cell of a red screen. Each paint
        // refills the framebuffer with a sentinel, so a frame shows which rows its field drew.
        function paintedFrames(program) {
            const frames = [];
            const v = makeVideo({
                onPaint: (video) => {
                    frames.push(new Uint32Array(video.fb32));
                    video.fb32.fill(Sentinel);
                },
            });
            program(v);
            v.writeCrtc(10, 0); // Cursor from scanline 0, steady
            v.writeCrtc(11, 31); // Cursor to the end of the row
            for (const reg of [12, 13, 14, 15]) v.writeCrtc(reg, 0); // Screen and cursor at address 0
            v.video.ula.write(0, Mode4);
            v.video.ula.write(1, SetPixelsRed);
            v.cpu.data = 0xff;
            v.run(16 * ClocksPerFrame);
            expect(frames.length).toBeGreaterThan(3);
            return frames.slice(-3);
        }

        const pixelsOf = (frame, colour) => frame.reduce((at, pixel, i) => (pixel === colour ? [...at, i] : at), []);
        const otherRowOfPair = (i) => (Math.floor(i / FbWidth) ^ 1) * FbWidth + (i % FbWidth);

        it("doubles the cursor with the cells under it when stuck on one field", () => {
            for (const frame of paintedFrames(programStuckInterlaceSyncAndVideoFrame)) {
                const cursor = pixelsOf(frame, InvertedRed);
                expect(cursor).not.toEqual([]);
                expect(cursor.filter((i) => frame[otherRowOfPair(i)] !== InvertedRed)).toEqual([]);
            }
        });

        it("inverts only its own field's rows when the fields alternate", () => {
            for (const frame of paintedFrames(programInterlaceSyncAndVideoFrame)) {
                expect(frame).toContain(InvertedRed);
                expect(frame).toContain(Sentinel);
                expect(frame).not.toContain(inverted(Sentinel));
            }
        });
    });

    describe("the beam's position", () => {
        const toVSyncStart = () => {
            while (video.inVSync) rig.run(1);
            while (!video.inVSync) rig.run(1);
        };

        beforeEach(() => {
            programStandardFrame(rig);
            toVSyncStart();
        });

        it("counts the lines and clocks since vsync began, through lines of any length", () => {
            expect(video.beamPosition()).toEqual({
                line: 0,
                frameCycle: 1,
                inVSync: true,
                crtc: { row: 34, scanline: 0, column: 1 },
            });
            rig.run(10 * ClocksPerScanline);
            expect(video.beamPosition()).toMatchObject({ line: 10, frameCycle: 10 * ClocksPerScanline + 1 });
            const shortLine = 112;
            rig.writeCrtc(0, shortLine - 1);
            rig.run(5 * shortLine);
            expect(video.beamPosition()).toMatchObject({
                line: 15,
                frameCycle: 10 * ClocksPerScanline + 5 * shortLine + 1,
            });
            const restored = makeVideo().video;
            restored.restoreState(video.snapshotState());
            expect(restored.beamPosition()).toEqual(video.beamPosition());
            rig.writeCrtc(0, 127);
            toVSyncStart();
            expect(video.beamPosition()).toMatchObject({ line: 0, frameCycle: 1 });
        });

        it("counts the odd interlace field's lines from 0 too", () => {
            rig.writeCrtc(8, 1);
            for (let field = 0; field < 2; field++) {
                toVSyncStart();
                rig.run(ClocksPerScanline);
                expect(video.beamPosition().line).toBe(1);
            }
        });
    });

    describe("debugPaint", () => {
        beforeEach(() => rig.resetPaints());

        const painted = () => {
            const [, top, , bottom, paintedTo] = rig.lastPaint();
            return { top, bottom, paintedTo };
        };

        // The beam dot is drawn ten rows either side of the beam.
        const DotRadius = 10;

        it("hands over the whole picture's extent but only the rows down to the beam's dot", () => {
            video.bitmapY = 200;
            expect(video.doublesLines()).toBe(true);
            video.debugPaint();
            expect(rig.paints()).toBe(1);
            const { top, bottom, paintedTo } = painted();
            expect(top).toBe(video.topBorder);
            expect(bottom).toBe(625 - video.bottomBorder);
            expect(paintedTo).toBe(200 + 2 + DotRadius);
        });

        it("counts the beam as one row when scanlines are not doubled", () => {
            video.crtc.write(0, 8);
            video.crtc.write(1, 3);
            video.bitmapY = 200;
            expect(video.doublesLines()).toBe(false);
            video.debugPaint();
            expect(painted().paintedTo).toBe(200 + 1 + DotRadius);
        });

        it("hands over every row once the beam is below the picture", () => {
            video.bitmapY = 700;
            video.debugPaint();
            const { bottom, paintedTo } = painted();
            expect(paintedTo).toBe(bottom);
        });

        it("hands over no rows with the beam above the picture", () => {
            video.bitmapY = -1;
            video.debugPaint();
            const { top, paintedTo } = painted();
            expect(paintedTo).toBe(top);
        });

        it("takes the beam from the 6847 on an Atom, whose position reaches the wrapper only at flyback", () => {
            video.bitmapY = 700;
            video.video6847 = { bitmapX: 100, bitmapY: 300 };
            video.debugPaint();
            expect(painted().paintedTo).toBe(300 + 2 + DotRadius);
        });

        it("leaves the framebuffer as it was", () => {
            video.fb32.fill(0x12345678);
            video.bitmapX = 500;
            video.bitmapY = 300;
            video.debugPaint();
            expect(video.fb32.every((pixel) => pixel === 0x12345678)).toBe(true);
        });
    });

    describe("snapshotState / restoreState", () => {
        const fresh = (options) => makeVideo(options).video;

        it.each(["wasm", "js"])(
            "clears the teletext a restore into MODE 7 paints, on a %s drain that was showing a bitmap",
            (drainKind) => {
                // Both modes run the CRTC at 1MHz.
                const FrameClocks = 2 * ClocksPerFrame;
                const WideR1 = 40;
                const NarrowR1 = 10;
                const startVideo = (ulaControl, r1) => {
                    const r = makeVideo({ drainKind });
                    programStandardFrame(r);
                    r.cpu.data = 0xff;
                    r.video.ula.write(0, ulaControl);
                    r.writeCrtc(1, r1);
                    return r;
                };
                // The frame after narrowing shows the wide frame's rows only if the clear before it missed them.
                const frameAfterNarrowing = (r) => {
                    let painted;
                    r.video.paint_ext = () => (painted = r.video.fb32.slice());
                    r.run(FrameClocks);
                    r.writeCrtc(1, NarrowR1);
                    r.run(FrameClocks);
                    return painted;
                };
                const saved = startVideo(Mode4Teletext, WideR1);
                saved.run(2 * FrameClocks + FrameClocks / 2);
                const restored = startVideo(Mode4, NarrowR1);
                restored.run(2 * FrameClocks);

                restored.video.restoreState(saved.video.snapshotState());

                expect(firstDifferentPixel(frameAfterNarrowing(restored), frameAfterNarrowing(saved))).toBe(-1);
            },
        );

        it.each([
            ["a stock ULA", {}],
            ["a VideoNuLA", { hasVideoNula: true }],
        ])("restores a picture part way down a field on %s as it was saved", (_, options) =>
            expectSnapshotRoundTrips(
                () => {
                    const r = makeVideo(options);
                    return Object.assign(r, {
                        snapshotState: () => r.video.snapshotState(),
                        restoreState: (state) => r.video.restoreState(state),
                    });
                },
                (r) => {
                    programStandardFrame(r);
                    r.cpu.data = 0x91;
                    r.video.ula.write(0, 0x02);
                    r.run(ClocksPerFrame);
                    r.video.ula.write(0, 0xf4);
                    r.video.ula.write(1, 0x0a);
                    r.video.ula.write(2, NulaPaletteModeOn);
                    r.video.ula.write(2, NulaHorizontalOffsetOne);
                    for (const byte of NulaColourZeroFullRed) r.video.ula.write(3, byte);
                    r.video.setScreenHwScroll(2);
                    r.run(ClocksPerFrame / 2 + 17);
                },
            ),
        );

        it("should carry on from a half-line vsync the way the original does", () => {
            const SnapshotDelayClocks = (7 * ClocksPerScanline) / 4;
            const ComparedClocks = ClocksPerFrame / 2;
            function recording() {
                const run = { clocks: 0, edges: [] };
                run.v = makeVideo({ onVBlank: (level) => run.edges.push([level, run.clocks]) });
                run.tick = (count) => {
                    for (let i = 0; i < count; i++) {
                        run.v.run(1);
                        run.clocks++;
                    }
                };
                return run;
            }

            const original = recording();
            programStandardFrame(original.v);
            original.v.writeCrtc(8, 1);
            original.tick(2 * ClocksPerFrame);

            const sourcesAtSnapshot = [];
            for (let field = 0; field < 2; field++) {
                original.edges = [];
                while (!original.edges.some(([level]) => level)) original.tick(1);
                original.tick(SnapshotDelayClocks);
                const snapshot = original.v.video.snapshotState();
                sourcesAtSnapshot.push([snapshot.inLineVSync, snapshot.inHalfLineVSync]);

                const restored = recording();
                restored.v.video.restoreState(snapshot);
                original.edges = [];
                original.clocks = 0;
                original.tick(ComparedClocks);
                restored.tick(ComparedClocks);

                expect(original.edges.length).toBeGreaterThan(0);
                expect(restored.edges).toEqual(original.edges);
            }
            expect(sourcesAtSnapshot).toContainEqual([false, true]);
        });

        it("should take both vsync sources from the output for a snapshot without them", () => {
            const v = fresh();
            v.inVSync = true;
            v.hadVSyncThisRow = true;
            const { inLineVSync, inHalfLineVSync, hadHalfLineVSyncThisRow, ...older } = v.snapshotState();
            expect([inLineVSync, inHalfLineVSync, hadHalfLineVSyncThisRow]).toEqual([false, false, false]);

            const v2 = fresh();
            v2.restoreState(older);

            expect([v2.inVSync, v2.inLineVSync, v2.inHalfLineVSync]).toEqual([true, true, true]);
            expect([v2.hadVSyncThisRow, v2.hadHalfLineVSyncThisRow]).toEqual([true, true]);
        });

        it("should paint afresh after a restore", () => {
            const v = fresh();
            expect(v.paintsAfresh).toBe(false);
            v.restoreState(fresh().snapshotState());
            expect(v.paintsAfresh).toBe(true);
        });

        it("should restart the PAL line phase from zero for a snapshot without it", () => {
            const v = fresh();
            const { hsyncCount, lineBaseEven, lineBaseOdd, subcarrierPhase, phaseBaseEven, phaseBaseOdd, ...older } =
                v.snapshotState();
            expect([hsyncCount, lineBaseEven, lineBaseOdd, subcarrierPhase, phaseBaseEven, phaseBaseOdd]).toEqual([
                0, 0, 0, 0, 0, 0,
            ]);

            const v2 = fresh();
            v2.hsyncCount = 99;
            v2.lineBaseEven = 98;
            v2.lineBaseOdd = 97;
            v2.subcarrierPhase = 0.5;
            v2.phaseBaseEven = 0.25;
            v2.phaseBaseOdd = 0.75;
            v2.restoreState(older);

            expect([v2.hsyncCount, v2.lineBaseEven, v2.lineBaseOdd]).toEqual([0, 0, 0]);
            expect([v2.subcarrierPhase, v2.phaseBaseEven, v2.phaseBaseOdd]).toEqual([0, 0, 0]);
        });

        it("should rebuild the line grid descriptor on restore", () => {
            // It is derived from ulaMode and teletextMode rather than saved, so
            // a restored machine must not keep the destination's old value.
            const v = fresh();
            v.ulaMode = 1; // four texels per pixel, as MODE 2 selects
            v.teletextMode = false;

            const v2 = fresh();
            v2.ulaMode = 3;
            v2.updateLineGridUla();
            v2.restoreState(v.snapshotState());

            expect(decodeLineGrid(v2.lineGridUla).texelsWide).toBe(4);
        });

        it("restores the saved palette as it is onto a VideoNuLA", () => {
            const v = fresh({ hasVideoNula: true });
            const snapshot = v.snapshotState();
            snapshot.ulaPal[3] = 0xff123456;

            const v2 = fresh({ hasVideoNula: true });
            v2.restoreState(snapshot);

            expect(v2.ulaPal[3] >>> 0).toBe(0xff123456);
        });

        it("restores a state saved without a VideoNuLA onto one as a disabled NULA", () => {
            const stock = fresh();
            const fitted = fresh({ hasVideoNula: true });

            fitted.restoreState(stock.snapshotState());

            expect(fitted.ula.disabled).toBe(true);
            fitted.ula.write(2, 0x1c);
            expect(fitted.ulactrl).toBe(0x1c);
        });

        it("keeps a stock ULA stock when restoring a state saved with a NULA fitted", () => {
            const fitted = fresh({ hasVideoNula: true });
            fitted.ula.write(0, 0x08);
            fitted.ula.write(1, LogicalZeroAsPhysicalZero);
            fitted.ula.write(2, NulaPaletteModeOn);
            fitted.ula.write(2, NulaHorizontalOffsetOne);
            for (const byte of NulaColourZeroFullRed) fitted.ula.write(3, byte);
            const stock = fresh();
            const stockBlack = stock.ula.collook[0];

            stock.restoreState(fitted.snapshotState());

            expect(stock.ula.disabled).toBe(true);
            expect(stock.ula.paletteMode).toBe(0);
            expect(stock.ula.horizontalOffset).toBe(0);
            expect(stock.ula.collook[0]).toBe(stockBlack);
            expect(stock.ulaPal[0] >>> 0).toBe(stockBlack);
            stock.ula.write(2, 0x1c);
            expect(stock.ulactrl).toBe(0x1c);
        });
    });
});

const runAField = (video, target, field, step) => {
    const edges = [];
    let polled = 0;
    target.setVBlankInt.mockImplementation((level) => edges.push({ level, at: polled }));
    for (; polled < field; polled += step) video.polltime(step);
    return edges;
};

describe("FakeVideo and FakeAtomVideo", () => {
    const Field = 40000;
    const VSyncStart = Field - 2 * 128;
    const Step = 7;
    const AtomField = 16667;
    const AtomFlybackStart = AtomField - (AtomField * 32) / 262;

    it.each([
        ["the System VIA's vsync", FakeVideo, Field, VSyncStart, (via, ppia) => [{ atomppia: ppia }, via]],
        [
            "the Atom PPIA's field sync",
            FakeAtomVideo,
            AtomField,
            AtomFlybackStart,
            (ppia, via) => [{ atomppia: ppia }, via],
        ],
    ])("pulses %s once a field, for its sync lines", (_, Fake, field, syncStart, wire) => {
        const target = { setVBlankInt: vi.fn() };
        const other = { setVBlankInt: vi.fn() };
        const video = new Fake();
        video.reset(...wire(target, other));
        const [start, end] = runAField(video, target, field, Step);
        expect(other.setVBlankInt).not.toHaveBeenCalled();
        expect(start.level).toBe(true);
        expect(start.at).toBeGreaterThanOrEqual(syncStart - Step);
        expect(start.at).toBeLessThanOrEqual(syncStart);
        expect(end.level).toBe(false);
        expect(end.at).toBeGreaterThanOrEqual(field - Step);
        expect(end.at).toBeLessThanOrEqual(field);
    });

    it.each([
        ["mid-field", Field / 2],
        ["mid-pulse", VSyncStart + Step * 3],
    ])("stays in step with the machine it was snapshotted from, %s", (_, runFirst) => {
        const original = { video: new FakeVideo(), sysvia: { setVBlankInt: vi.fn() } };
        original.video.reset({}, original.sysvia);
        runAField(original.video, original.sysvia, runFirst, Step);
        const restored = { video: new FakeVideo(), sysvia: { setVBlankInt: vi.fn() } };
        restored.video.reset({}, restored.sysvia);
        restored.video.restoreState(original.video.snapshotState());
        const expected = runAField(original.video, original.sysvia, 2 * Field, Step);
        expect(expected).toHaveLength(4);
        expect(runAField(restored.video, restored.sysvia, 2 * Field, Step)).toEqual(expected);
    });

    it("keeps its field through a reset, so a reset mid-pulse still ends that pulse", () => {
        const sysvia = { setVBlankInt: vi.fn() };
        const video = new FakeVideo();
        video.reset({}, sysvia);
        const before = runAField(video, sysvia, VSyncStart + Step * 3, Step);
        video.reset({}, sysvia);
        const after = runAField(video, sysvia, Field, Step);
        expect([...before, ...after].map(({ level }) => level)).toEqual([true, false, true]);
        expect(after[0].at).toBeLessThanOrEqual(Field - VSyncStart);
    });

    it("catches up every field it was given at once, leaving no backlog", () => {
        const fields = 3;
        const sysvia = { setVBlankInt: vi.fn() };
        const video = new FakeVideo();
        video.reset({}, sysvia);
        video.polltime(fields * Field + Step);
        expect(sysvia.setVBlankInt.mock.calls.map(([level]) => level)).toEqual(
            Array(fields).fill([true, false]).flat(),
        );
        const [start, end] = runAField(video, sysvia, Field, Step);
        expect(start.at).toBeGreaterThanOrEqual(VSyncStart - 2 * Step);
        expect(end.at).toBeGreaterThanOrEqual(Field - 2 * Step);
    });

    it("carries on pulsing after restoring a snapshot that predates its field position", () => {
        const sysvia = { setVBlankInt: vi.fn() };
        const video = new FakeVideo();
        video.reset({}, sysvia);
        video.restoreState({});
        const [start, end] = runAField(video, sysvia, Field, Step);
        expect([start.level, end.level]).toEqual([true, false]);
    });
});
