import { describe, it, expect, beforeEach } from "vitest";
import { Teletext } from "../../src/teletext.js";
import { makeFast32 } from "../../src/binary.js";
import { OPAQUE_BLACK, RowPixels, VideoDrain } from "../../src/video-drain.js";
import { seededRandom } from "../helpers/seeded-random.js";

const PixelsPerCell = 16;
const PipelineDelay = 3;

const RedAlpha = 0x01;
const Flash = 0x08;
const Steady = 0x09;
const DoubleHeight = 0x0d;
const RedGraphics = 0x11;
const BlueGraphics = 0x14;
const WhiteGraphics = 0x17;
const Conceal = 0x18;
const SeparatedGraphics = 0x1a;
const BlackBackground = 0x1c;
const NewBackground = 0x1d;
const HoldGraphics = 0x1e;
const ReleaseGraphics = 0x1f;
const Space = 0x20;
const Mosaic = 0x21;
const LetterA = 0x41;
const SolidBlock = 0x7f;
const Black = 0;
const Red = 1;
const Blue = 4;
const White = 7;

describe.each(["wasm", "js"])("Teletext painted by the %s drain", (drainKind) => {
    let teletext;

    beforeEach(() => {
        teletext = new Teletext();
    });

    // Clocks each byte through the chip, showing the cell it clocks when `shown(index)` says to, and paints the
    // shown cells side by side.
    function paintCells(bytes, shown) {
        const drain = new VideoDrain(bytes.length * PixelsPerCell, drainKind);
        teletext.setOutput(drain);
        bytes.forEach((byte, index) => {
            teletext.logClocked(byte);
            if (shown(index)) teletext.showLatest(index * PixelsPerCell, false, false);
        });
        teletext.catchUp();
        return (index) => drain.fb32.subarray(index * PixelsPerCell, (index + 1) * PixelsPerCell);
    }

    // A space is a blank mosaic in graphics mode, so it becomes the held character: tests that care
    // what is held at the end of a row must flush the pipeline with something else.
    function renderCells(bytes, flushWith = Space) {
        const padded = [...bytes, ...Array(PipelineDelay).fill(flushWith)];
        const cellAt = paintCells(padded, () => true);
        return bytes.map((_, index) => cellAt(index + PipelineDelay));
    }

    function backgroundOnly(cell, backgroundIndex = 0) {
        const background = teletext.colour[(backgroundIndex & 7) << 5];
        return cell.every((pixel) => pixel === background);
    }

    function solidOnly(cell, foregroundIndex, backgroundIndex = 0) {
        const solid = teletext.colour[((backgroundIndex & 7) << 5) | ((foregroundIndex & 7) << 2) | 3];
        return cell.every((pixel) => pixel === solid);
    }

    function endScanline() {
        teletext.setDISPTMG(true);
        teletext.setDISPTMG(false);
    }

    function renderCharacterRow(bytes) {
        const scanlines = [];
        for (let scanline = 0; scanline < 10; ++scanline) {
            scanlines.push(renderCells(bytes));
            endScanline();
        }
        return scanlines;
    }

    function endFrame() {
        teletext.setDEW(true);
        teletext.setDEW(false);
    }

    // Indices into teletext.colour; a cell showing more than one colour is null.
    const plain = (background) => background << 5;
    const solid = (foreground) => (foreground << 2) | 3;
    const Blank = plain(Black);
    const Mixed = null;

    const uniformColour = (cell) => (cell.every((pixel) => pixel === cell[0]) ? cell[0] : null);

    function expectCells(cells, expected) {
        const indices = Object.keys(expected);
        expect(Object.fromEntries(indices.map((i) => [i, uniformColour(cells[i])]))).toEqual(
            Object.fromEntries(indices.map((i) => [i, expected[i] === Mixed ? null : teletext.colour[expected[i]]])),
        );
    }

    // Codes 0, 16 and 27 are reserved, 10 and 11 drive a boxing output the BBC has nothing wired to,
    // and 14 and 15 select an alternate character set the chip does not carry. Pages rely on this:
    // the Ceefax engineering page reveals its concealed text by rewriting code 24 as code 16.
    const unimplementedCodes = [
        ["alpha black (0)", 0x00],
        ["end box (10)", 0x0a],
        ["start box (11)", 0x0b],
        ["shift out (14)", 0x0e],
        ["shift in (15)", 0x0f],
        ["graphics black (16)", 0x10],
        ["escape (27)", 0x1b],
    ];

    // Each starts in flash's hidden phase, so that a flashing cell shows as blank.
    it.each([
        [
            "conceal blanks graphics until a colour code reveals them",
            [WhiteGraphics, SolidBlock, Conceal, SolidBlock, WhiteGraphics, SolidBlock],
            { 1: solid(White), 3: Blank, 5: solid(White) },
        ],
        [
            "conceal stays when the background changes afterwards",
            [BlueGraphics, NewBackground, Conceal, BlackBackground, SolidBlock, SolidBlock],
            { 4: Blank, 5: Blank },
        ],
        [
            "conceal blanks the cell holding its code, and the one holding the revealing code",
            [WhiteGraphics, SolidBlock, HoldGraphics, Conceal, WhiteGraphics, SolidBlock],
            { 2: solid(White), 3: Blank, 4: Blank, 5: solid(White) },
        ],
        [
            "conceal leaves the foreground colour alone",
            [BlueGraphics, Conceal, SolidBlock, NewBackground, WhiteGraphics, Space],
            { 2: Blank, 5: plain(Blue) },
        ],
        [
            "a colour takes effect from the cell after its code",
            [WhiteGraphics, SolidBlock, HoldGraphics, RedGraphics, SolidBlock],
            { 1: solid(White), 3: solid(White), 4: solid(Red) },
        ],
        [
            "a new background takes effect from the cell holding its code",
            [RedAlpha, NewBackground, Space, BlackBackground, Space],
            { 1: plain(Red), 2: plain(Red), 3: plain(Black) },
        ],
        [
            "code 26 separates the blocks after it",
            [WhiteGraphics, SolidBlock, SeparatedGraphics, SolidBlock],
            { 1: solid(White), 3: Mixed },
        ],
        [
            "hold shows the last block through a following control code until released",
            [WhiteGraphics, SolidBlock, HoldGraphics, Steady, ReleaseGraphics, Steady],
            { 3: solid(White), 4: solid(White), 5: Blank },
        ],
        // The spec holds "the most recent mosaics character with bit 6 = 1 in its code", so an
        // alphanumeric seen in graphics mode leaves the previous mosaic held.
        [
            "hold passes over an alphanumeric character",
            [WhiteGraphics, SolidBlock, LetterA, HoldGraphics, Flash],
            { 3: solid(White), 4: solid(White) },
        ],
        [
            "flash takes effect from the cell after its code",
            [WhiteGraphics, SolidBlock, HoldGraphics, Flash, SolidBlock],
            { 3: solid(White), 4: Blank },
        ],
        [
            "steady takes effect from the cell holding its code",
            [WhiteGraphics, Flash, SolidBlock, HoldGraphics, Steady, SolidBlock],
            { 2: Blank, 4: solid(White), 5: solid(White) },
        ],
        [
            "a change of size drops the held character",
            [WhiteGraphics, SolidBlock, HoldGraphics, DoubleHeight, Flash],
            { 3: Blank, 4: Blank },
        ],
        [
            "only the low seven bits count, as the SAA5050 has no eighth data pin",
            [0x80 | WhiteGraphics, 0x80 | SolidBlock],
            { 1: solid(White) },
        ],
        ...unimplementedCodes.map(([name, code]) => [
            `${name} is not implemented, and leaves every attribute alone`,
            [WhiteGraphics, SolidBlock, code, SolidBlock],
            { 1: solid(White), 2: Blank, 3: solid(White) },
        ]),
    ])("%s", (_, bytes, expected) => {
        endFrame();
        expectCells(renderCells(bytes), expected);
    });

    it.each([
        ["conceal", [WhiteGraphics, Conceal, SolidBlock], [LetterA], { 0: Mixed }],
        ["hold", [WhiteGraphics, SolidBlock, HoldGraphics], [WhiteGraphics, SolidBlock, Flash], { 2: Blank }],
        ["graphics", [WhiteGraphics, Mosaic], [Mosaic, HoldGraphics], { 1: Blank }],
        ["the foreground colour", [RedAlpha, NewBackground, Space], [NewBackground, Space], { 1: plain(White) }],
        ["the background colour", [RedAlpha, NewBackground, Space], [Space], { 0: plain(Black) }],
    ])("does not carry %s over into the next row", (_, previousRow, bytes, expected) => {
        renderCells(previousRow);
        endScanline();
        expectCells(renderCells(bytes), expected);
    });

    it("returns to alphanumerics at the start of a row", () => {
        const graphics = renderCells([WhiteGraphics, Mosaic]);
        endScanline();

        const alpha = renderCells([Mosaic]);

        expect([...alpha[0]]).not.toEqual([...graphics[1]]);
    });

    it("round-trips conceal through a snapshot", () => {
        renderCells([WhiteGraphics, Conceal, SolidBlock]);
        const state = teletext.snapshotState();

        const restored = new Teletext();
        restored.restoreState(state);

        expect(restored.snapshotState()).toEqual(state);
        expect(state.conceal).toBe(true);
    });

    describe("clocking without painting", () => {
        // The ULA selects whether the chip's output reaches the screen; the chip itself keeps
        // running either way, so codes seen while a bitmap mode is displayed still take effect.
        // See https://github.com/mattgodbolt/jsbeeb/issues/832
        it("applies a colour code clocked in while nothing was painted", () => {
            // The pipeline is three cells deep, so the code is consumed several clocks after
            // it is fetched, and none of those cells is shown.
            const bytes = [RedGraphics, SolidBlock, Space, Space, Space];
            const cellAt = paintCells(bytes, (index) => index === bytes.length - 1);

            expect(solidOnly(cellAt(bytes.length - 1), Red)).toBe(true);
        });
    });

    describe("double height", () => {
        it("draws a different half of the character on each row", () => {
            const top = renderCharacterRow([DoubleHeight, LetterA]);
            const bottom = renderCharacterRow([DoubleHeight, LetterA]);

            const halfOf = (row) => row.map((cells) => [...cells[1]]);
            expect(halfOf(bottom)).not.toEqual(halfOf(top));
            expect(bottom.every((cells) => backgroundOnly(cells[1]))).toBe(false);
        });

        it("blanks a normal height character on the row carrying the bottom half", () => {
            renderCharacterRow([DoubleHeight, Space]);

            const bottom = renderCharacterRow([WhiteGraphics, SolidBlock]);

            expect(bottom.every((cells) => backgroundOnly(cells[1]))).toBe(true);
        });
    });

    it("shows a byte three cells after it is fetched", () => {
        const bytes = [WhiteGraphics, SolidBlock, Space, Space, Space];
        const cellAt = paintCells(bytes, () => true);

        expect(backgroundOnly(cellAt(3))).toBe(true);
        expect(solidOnly(cellAt(4), White)).toBe(true);
    });

    it("can paint the second half of a cell on its own", () => {
        const [whole] = renderCells([SolidBlock], LetterA);
        const buffer = makeFast32(new Uint32Array(PixelsPerCell)).fill(0x0badf00d);
        teletext.emitSecondHalf(buffer, 0);

        expect(Array.from(buffer.subarray(0, PixelsPerCell / 2))).toEqual(Array(PixelsPerCell / 2).fill(0x0badf00d));
        expect(Array.from(buffer.subarray(PixelsPerCell / 2))).toEqual(Array.from(whole.subarray(PixelsPerCell / 2)));
    });

    describe("scanlines", () => {
        // Rows 0 and 1 of an "A" are both blank, so RA0 has nothing to choose between there.
        it("takes the smoothing row from RA0", () => {
            endScanline();
            const evenRow = renderCells([LetterA]);
            teletext.setRA0(true);
            const oddRow = renderCells([LetterA]);

            expect([...oddRow[0]]).not.toEqual([...evenRow[0]]);
        });

        it("wraps back to the top of the glyph after ten scanlines", () => {
            const first = renderCells([LetterA]);
            for (let scanline = 0; scanline < 10; ++scanline) endScanline();

            expect([...renderCells([LetterA])[0]]).toEqual([...first[0]]);
        });

        it("restarts the glyph when a frame begins", () => {
            const first = renderCells([LetterA]);
            endScanline();
            const second = renderCells([LetterA]);
            endFrame();

            expect([...second[0]]).not.toEqual([...first[0]]);
            expect([...renderCells([LetterA])[0]]).toEqual([...first[0]]);
        });
    });

    it("blanks flashing text for sixteen frames in every sixty-four", () => {
        endFrame();

        let blanked = 0;
        for (let frame = 0; frame < 64; ++frame) {
            if (backgroundOnly(renderCells([WhiteGraphics, Flash, SolidBlock])[2])) ++blanked;
            endFrame();
        }

        expect(blanked).toBe(16);
    });

    // Doubling rounds the line above an odd field down to row -2.
    it.each([
        ["single", -1, false],
        ["doubled", -2, true],
    ])("paints only the spill onto row 0 of a cell above an odd field on %s rows", (_, row, doubled) => {
        const Spill = 8;
        const BlackSpill = 4;
        const drain = new VideoDrain(RowPixels, drainKind);
        teletext.setOutput(drain);
        for (const byte of [WhiteGraphics, ...Array(PipelineDelay + 1).fill(SolidBlock)]) teletext.logClocked(byte);
        teletext.showLatest(row * RowPixels + RowPixels - Spill, doubled, false);
        teletext.catchUp();
        expect(solidOnly(drain.fb32.subarray(0, Spill), White)).toBe(true);
        expect(drain.fb32.subarray(Spill).every((pixel) => pixel === 0)).toBe(true);

        const blackDrain = new VideoDrain(RowPixels, drainKind);
        teletext.setOutput(blackDrain);
        teletext.logClocked(SolidBlock);
        teletext.showLatest(row * RowPixels + RowPixels - BlackSpill, doubled, true);
        teletext.catchUp();
        const pixels = Array.from(blackDrain.fb32, (pixel) => pixel >>> 0);
        expect(pixels.slice(0, BlackSpill)).toEqual(Array(BlackSpill).fill(OPAQUE_BLACK));
        expect(pixels.slice(BlackSpill).every((pixel) => pixel === 0)).toBe(true);
    });

    it("continues identically from a restored snapshot", () => {
        const continuation = [SolidBlock, WhiteGraphics, SolidBlock, NewBackground, Space, SolidBlock];
        renderCells([BlueGraphics, Flash, SeparatedGraphics, SolidBlock, HoldGraphics, Conceal]);
        const state = teletext.snapshotState();
        const expected = renderCells(continuation).map((cell) => [...cell]);

        teletext = new Teletext();
        teletext.restoreState(state);

        expect(renderCells(continuation).map((cell) => [...cell])).toEqual(expected);
    });

    // The video logs the chip's input and runs it only when something reads it; nothing may tell the difference.
    describe("run from its input log", () => {
        const Lines = 400;
        const MaxCellsPerLine = 120;
        const LongLineChance = 0.02;
        // Longer than the log holds, as when R8 keeps DISPTMG low.
        const LongLineCells = 2500;
        const NoResetChance = 0.1;
        const SnapshotChance = 0.01;
        const FrameChance = 0.03;
        // An interlaced field's vsync ends half way along a line.
        const MidLineFrameChance = 0.001;
        const MaxBlankingFeeds = 30;
        // Lines nothing reads, which the log skips, should be common: the bit turns on less readily than off.
        const TeletextOnChance = 0.005;
        const TeletextOffChance = 0.02;
        // Fewer feeds than the pipeline is long leave the line's last bytes for the next line to run.
        const ShortBlankingChance = 0.5;
        const ShortBlankingFeeds = 3;
        const RestoreChance = 0.01;
        const RepaintChance = 0.05;
        const ReadChance = 0.01;
        const BlackChance = 0.05;
        const DoubledChance = 0.3;
        // The line above an odd field, whose cells show only what spills past its end.
        const RowAboveChance = 0.05;
        const FbRows = 8;
        const CellsPerRow = RowPixels / PixelsPerCell;
        const Bit7 = 0x80;
        const FedBit = 0x40;
        const Bytes = [
            ...Array.from({ length: 32 }, (_, code) => code),
            DoubleHeight,
            DoubleHeight,
            Bit7 | DoubleHeight,
            Space,
            Mosaic,
            SolidBlock,
            // Letters differ between a glyph's even and odd rows, so they show RA0 and the scanline counter.
            ...Array.from({ length: 8 }, (_, letter) => LetterA + letter),
        ];

        function logLine(bytes) {
            teletext.setDISPTMG(true);
            for (const byte of bytes) teletext.logClocked(byte);
            teletext.setDISPTMG(false);
        }

        it.each([
            ["blanks the next row", DoubleHeight, true],
            ["leaves the next row alone", Space, false],
        ])("given a double height code still in the pipeline at a row's last line, %s", (_, code, blanked) => {
            const LinesPerRow = 10;
            const line = [Space, Space, Space, Space, Space];
            for (let i = 0; i < LinesPerRow - 2; ++i) logLine(line);
            logLine([...line, code]);
            logLine(line);
            teletext.catchUp();

            const cells = renderCells([WhiteGraphics, SolidBlock]);

            expect(backgroundOnly(cells[1])).toBe(blanked);
        });

        it("counts a double height code that was only fed once a clocked byte runs it", () => {
            const LinesPerRow = 10;
            for (let i = 0; i < LinesPerRow - 1; ++i) logLine([Space, Space, Space, Space]);
            teletext.setDISPTMG(true);
            teletext.logFed(DoubleHeight);
            logLine([Space, Space, Space]);
            teletext.catchUp();

            const cells = renderCells([WhiteGraphics, SolidBlock]);

            expect(backgroundOnly(cells[1])).toBe(true);
        });

        it("forgets what it logged when a snapshot is restored", () => {
            const fresh = new Teletext().snapshotState();
            logLine([RedGraphics, Space, Space, Space]);
            teletext.logClocked(LetterA);
            teletext.restoreState(fresh);

            expect(teletext.snapshotState()).toEqual(fresh);
        });

        it("runs a line longer than the log holds", () => {
            const random = seededRandom(1);
            const eager = new Teletext();
            const logged = new Teletext();
            for (let cell = 0; cell < LongLineCells; ++cell) {
                const byte = Bytes[Math.floor(random() * Bytes.length)];
                eager.logClocked(byte);
                eager.catchUp();
                logged.logClocked(byte);
            }
            expect(logged.snapshotState()).toEqual(eager.snapshotState());
        });

        it.each([1, 2, 3, 4, 5, 6, 7, 8])("draws and snapshots as running each byte at once, seed %i", (seed) => {
            const random = seededRandom(seed);
            const pick = (n) => Math.floor(random() * n);
            const eager = new Teletext();
            const logged = new Teletext();
            const pictures = new Map();
            // The eager chip paints with the JS twin, so the logged one checks this drain's painter against it.
            for (const [chip, kind] of [
                [eager, "js"],
                [logged, drainKind],
            ]) {
                const drain = new VideoDrain(FbRows * RowPixels, kind);
                chip.setOutput(drain);
                pictures.set(chip, { fb: drain.fb32, lineGrid: drain.lineGrid });
            }
            const eagerCell = makeFast32(new Uint32Array(PixelsPerCell));
            const loggedCell = makeFast32(new Uint32Array(PixelsPerCell));
            const both = (action) => {
                action(eager);
                action(logged);
            };
            const expectSameSnapshot = () => expect(logged.snapshotState()).toEqual(eager.snapshotState());
            const expectSamePicture = (line) => {
                logged.catchUpShown();
                const [want, got] = [eager, logged].map((chip) => pictures.get(chip));
                const pixel = want.fb.findIndex((value, i) => value !== got.fb[i]);
                if (pixel >= 0)
                    expect({ line, pixel, value: got.fb[pixel] }).toEqual({ line, pixel, value: want.fb[pixel] });
                expect(got.lineGrid).toEqual(want.lineGrid);
            };

            // As the video does: it logs every byte, and while the ULA's teletext bit is set shows the cell each
            // clocked byte latches. Running each byte at once is catching up after every one.
            let teletextBit = false;
            let doubledLines = false;
            let row = 0;
            const feedClocked = (byte, cell) => {
                const offset = row * RowPixels + (cell % CellsPerRow) * PixelsPerCell;
                const black = random() < BlackChance;
                both((chip) => {
                    chip.logClocked(byte);
                    if (teletextBit) chip.showLatest(offset, doubledLines, black);
                });
                eager.catchUp();
            };
            const feed = (byte) => {
                both((chip) => chip.logFed(byte));
                eager.catchUp();
            };
            const repaintSecondHalf = (line, cell) => {
                both((chip) => {
                    chip.catchUp();
                    chip.emitSecondHalf(chip === eager ? eagerCell : loggedCell, 0);
                });
                if (!eagerCell.every((pixel, i) => pixel === loggedCell[i])) {
                    expect({ line, cell, pixels: [...loggedCell] }).toEqual({ line, cell, pixels: [...eagerCell] });
                }
            };

            const newField = () => {
                both((chip) => chip.setDEW(true));
                both((chip) => chip.setDEW(false));
            };

            for (let line = 0; line < Lines; ++line) {
                const cells = random() < LongLineChance ? LongLineCells : 1 + pick(MaxCellsPerLine);
                doubledLines = random() < DoubledChance;
                row = random() < RowAboveChance ? -1 : 2 * pick(FbRows / 2);
                both((chip) => chip.setDISPTMG(true));
                for (let cell = 0; cell < cells; ++cell) {
                    if (random() < (teletextBit ? TeletextOffChance : TeletextOnChance)) teletextBit = !teletextBit;
                    feedClocked(Bytes[pick(Bytes.length)], cell);
                    if (random() < MidLineFrameChance) newField();
                    if (random() < RepaintChance) repaintSecondHalf(line, cell);
                    if (random() < ReadChance) expectSamePicture(line);
                    if (random() < SnapshotChance) expectSameSnapshot();
                    if (random() < RestoreChance) {
                        const state = eager.snapshotState();
                        logged.catchUpShown();
                        both((chip) => chip.restoreState(structuredClone(state)));
                    }
                }
                if (random() >= NoResetChance) both((chip) => chip.setDISPTMG(false));
                if (random() < SnapshotChance * 10) expectSameSnapshot();
                const ra0 = !!pick(2);
                both((chip) => chip.setRA0(ra0));
                if (random() < FrameChance) newField();
                const maxFeeds = random() < ShortBlankingChance ? ShortBlankingFeeds : MaxBlankingFeeds;
                for (let feeds = pick(maxFeeds); feeds > 0; --feeds) feed(Bytes[pick(Bytes.length)] | FedBit);
                if (random() < ReadChance * 10) expectSamePicture(line);
            }
            expectSamePicture(Lines);
            expectSameSnapshot();
        });
    });
});
