import { describe, it, expect, beforeEach } from "vitest";
import { Teletext } from "../../src/teletext.js";
import { makeFast32 } from "../../src/utils.js";

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

describe("Teletext", () => {
    let teletext;

    beforeEach(() => {
        teletext = new Teletext();
    });

    // A space is a blank mosaic in graphics mode, so it becomes the held character: tests that care
    // what is held at the end of a row must flush the pipeline with something else.
    function renderCells(bytes, flushWith = Space) {
        const padded = [...bytes, ...Array(PipelineDelay).fill(flushWith)];
        const buffer = makeFast32(new Uint32Array(padded.length * PixelsPerCell));
        padded.forEach((byte, index) => {
            teletext.fetchData(byte);
            teletext.render(buffer, index * PixelsPerCell);
        });
        return bytes.map((_, index) =>
            buffer.subarray((index + PipelineDelay) * PixelsPerCell, (index + PipelineDelay + 1) * PixelsPerCell),
        );
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

    describe("conceal", () => {
        it("blanks graphics until a colour code reveals them", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, Conceal, SolidBlock, WhiteGraphics, SolidBlock]);

            expect(backgroundOnly(cells[1])).toBe(false);
            expect(backgroundOnly(cells[3])).toBe(true);
            expect(backgroundOnly(cells[5])).toBe(false);
        });

        it("stays concealed when the background changes afterwards", () => {
            const cells = renderCells([BlueGraphics, NewBackground, Conceal, BlackBackground, SolidBlock, SolidBlock]);

            expect(backgroundOnly(cells[4])).toBe(true);
            expect(backgroundOnly(cells[5])).toBe(true);
        });

        it("conceals the cell holding the conceal code, and the one holding the revealing code", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, HoldGraphics, Conceal, WhiteGraphics, SolidBlock]);

            expect(backgroundOnly(cells[2])).toBe(false);
            expect(backgroundOnly(cells[3])).toBe(true);
            expect(backgroundOnly(cells[4])).toBe(true);
            expect(backgroundOnly(cells[5])).toBe(false);
        });

        it("does not survive into the next row", () => {
            const concealed = renderCells([WhiteGraphics, Conceal, SolidBlock]);
            expect(backgroundOnly(concealed[2])).toBe(true);

            endScanline();

            const revealed = renderCells([WhiteGraphics, SolidBlock]);
            expect(backgroundOnly(revealed[1])).toBe(false);
        });

        it("leaves the foreground colour alone", () => {
            const cells = renderCells([BlueGraphics, Conceal, SolidBlock, NewBackground, WhiteGraphics, Space]);

            expect(backgroundOnly(cells[2])).toBe(true);
            expect(backgroundOnly(cells[5], Blue)).toBe(true);
        });

        it("round-trips through a snapshot", () => {
            renderCells([WhiteGraphics, Conceal, SolidBlock]);
            const state = teletext.snapshotState();

            const restored = new Teletext();
            restored.restoreState(state);

            expect(restored.snapshotState()).toEqual(state);
            expect(state.conceal).toBe(true);
        });
    });

    describe("colour", () => {
        it("takes effect from the cell after the code", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, HoldGraphics, RedGraphics, SolidBlock]);

            expect(solidOnly(cells[1], White)).toBe(true);
            expect(solidOnly(cells[3], White)).toBe(true);
            expect(solidOnly(cells[4], Red)).toBe(true);
        });

        it("takes a new background from the cell holding the code", () => {
            const cells = renderCells([RedAlpha, NewBackground, Space, BlackBackground, Space]);

            expect(backgroundOnly(cells[1], Red)).toBe(true);
            expect(backgroundOnly(cells[2], Red)).toBe(true);
            expect(backgroundOnly(cells[3], Black)).toBe(true);
        });
    });

    describe("clocking without painting", () => {
        // The ULA selects whether the chip's output reaches the screen; the chip itself keeps
        // running either way, so codes seen while a bitmap mode is displayed still take effect.
        // See https://github.com/mattgodbolt/jsbeeb/issues/832
        it("applies a colour code clocked in while nothing was painted", () => {
            const buffer = makeFast32(new Uint32Array(PixelsPerCell));
            // The pipeline is three cells deep, so the code is consumed several advances after
            // it is fetched, and every one of those happens with no call to emit.
            const bytes = [RedGraphics, SolidBlock, Space, Space, Space];
            bytes.forEach((byte, index) => {
                teletext.fetchData(byte);
                teletext.advance();
                if (index === bytes.length - 1) teletext.emit(buffer, 0);
            });

            expect(solidOnly(buffer, Red)).toBe(true);
        });
    });

    describe("graphics", () => {
        it("separates the blocks once code 26 is seen", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, SeparatedGraphics, SolidBlock]);

            expect(solidOnly(cells[1], White)).toBe(true);
            expect(solidOnly(cells[3], White)).toBe(false);
            expect(backgroundOnly(cells[3])).toBe(false);
        });

        it("holds the last block through a following control code", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, HoldGraphics, Flash, ReleaseGraphics, Flash]);

            expect(solidOnly(cells[3], White)).toBe(true);
            expect(backgroundOnly(cells[5])).toBe(true);
        });

        // The spec holds "the most recent mosaics character with bit 6 = 1 in its code", so an
        // alphanumeric seen in graphics mode leaves the previous mosaic held.
        it("does not hold an alphanumeric character", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, LetterA, HoldGraphics, Flash]);

            expect(solidOnly(cells[3], White)).toBe(true);
            expect(solidOnly(cells[4], White)).toBe(true);
        });

        it("holds nothing over from the previous row", () => {
            renderCells([WhiteGraphics, SolidBlock, HoldGraphics], Steady);
            endScanline();

            const cells = renderCells([WhiteGraphics, Flash]);

            expect(backgroundOnly(cells[0])).toBe(true);
            expect(backgroundOnly(cells[1])).toBe(true);
        });
    });

    describe("flash", () => {
        it("starts flashing from the cell after the code", () => {
            endFrame();
            const cells = renderCells([WhiteGraphics, SolidBlock, HoldGraphics, Flash, SolidBlock]);

            expect(solidOnly(cells[3], White)).toBe(true);
            expect(backgroundOnly(cells[4])).toBe(true);
        });

        it("stops flashing at the cell holding the steady code", () => {
            endFrame();
            const cells = renderCells([WhiteGraphics, Flash, SolidBlock, HoldGraphics, Steady, SolidBlock]);

            expect(backgroundOnly(cells[2])).toBe(true);
            expect(solidOnly(cells[4], White)).toBe(true);
            expect(solidOnly(cells[5], White)).toBe(true);
        });

        it("shows flashing text during the visible phase", () => {
            for (let frame = 0; frame < 16; ++frame) endFrame();

            const cells = renderCells([WhiteGraphics, Flash, SolidBlock]);

            expect(solidOnly(cells[2], White)).toBe(true);
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

        it("drops the held character when the size changes", () => {
            const cells = renderCells([WhiteGraphics, SolidBlock, HoldGraphics, DoubleHeight, Flash]);

            expect(backgroundOnly(cells[3])).toBe(true);
            expect(backgroundOnly(cells[4])).toBe(true);
        });
    });

    describe("start of row", () => {
        it("returns to white", () => {
            renderCells([RedAlpha, NewBackground, Space]);
            endScanline();

            const cells = renderCells([NewBackground, Space]);

            expect(backgroundOnly(cells[1], White)).toBe(true);
        });

        it("returns to a black background", () => {
            renderCells([RedAlpha, NewBackground, Space]);
            endScanline();

            const cells = renderCells([Space]);

            expect(backgroundOnly(cells[0], Black)).toBe(true);
        });

        it("returns to alphanumerics", () => {
            const graphics = renderCells([WhiteGraphics, Mosaic]);
            endScanline();

            const alpha = renderCells([Mosaic]);

            expect([...alpha[0]]).not.toEqual([...graphics[1]]);
        });
    });

    it("sees only the low seven bits, as the SAA5050 has no eighth data pin", () => {
        const cells = renderCells([0x80 | WhiteGraphics, 0x80 | SolidBlock]);

        expect(solidOnly(cells[1], White)).toBe(true);
    });

    it("shows a byte three cells after it is fetched", () => {
        const bytes = [WhiteGraphics, SolidBlock, Space, Space, Space];
        const buffer = makeFast32(new Uint32Array(bytes.length * PixelsPerCell));
        bytes.forEach((byte, index) => {
            teletext.fetchData(byte);
            teletext.render(buffer, index * PixelsPerCell);
        });
        const cellAt = (index) => buffer.subarray(index * PixelsPerCell, (index + 1) * PixelsPerCell);

        expect(backgroundOnly(cellAt(3))).toBe(true);
        expect(solidOnly(cellAt(4), White)).toBe(true);
    });

    // Codes 0, 16 and 27 are reserved, 10 and 11 drive a boxing output the BBC has nothing wired to,
    // and 14 and 15 select an alternate character set the chip does not carry. Pages rely on this:
    // the Ceefax engineering page reveals its concealed text by rewriting code 24 as code 16.
    describe.each([
        ["alpha black (0)", 0x00],
        ["end box (10)", 0x0a],
        ["start box (11)", 0x0b],
        ["shift out (14)", 0x0e],
        ["shift in (15)", 0x0f],
        ["graphics black (16)", 0x10],
        ["escape (27)", 0x1b],
    ])("%s", (_name, code) => {
        it("is not implemented, and leaves every attribute alone", () => {
            endFrame();
            const cells = renderCells([WhiteGraphics, SolidBlock, code, SolidBlock]);

            expect(solidOnly(cells[1], White)).toBe(true);
            expect(backgroundOnly(cells[2])).toBe(true);
            expect(solidOnly(cells[3], White)).toBe(true);
        });
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

    it("continues identically from a restored snapshot", () => {
        const continuation = [SolidBlock, WhiteGraphics, SolidBlock, NewBackground, Space, SolidBlock];
        renderCells([BlueGraphics, Flash, SeparatedGraphics, SolidBlock, HoldGraphics, Conceal]);
        const state = teletext.snapshotState();
        const expected = renderCells(continuation).map((cell) => [...cell]);

        teletext = new Teletext();
        teletext.restoreState(state);

        expect(renderCells(continuation).map((cell) => [...cell])).toEqual(expected);
    });
});
