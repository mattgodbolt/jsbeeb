import { describe, it, expect, beforeEach } from "vitest";
import { Teletext } from "../../src/teletext.js";
import { makeFast32 } from "../../src/utils.js";

const PixelsPerCell = 16;
const PipelineDelay = 3;

const WhiteGraphics = 0x17;
const BlueGraphics = 0x14;
const Conceal = 0x18;
const HoldGraphics = 0x1e;
const BlackBackground = 0x1c;
const NewBackground = 0x1d;
const Space = 0x20;
const SolidBlock = 0x7f;
const Blue = 4;

describe("Teletext", () => {
    let teletext;

    beforeEach(() => {
        teletext = new Teletext();
    });

    function renderCells(bytes) {
        const padded = [...bytes, ...Array(PipelineDelay).fill(Space)];
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

    function endScanline() {
        teletext.setDISPTMG(true);
        teletext.setDISPTMG(false);
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
});
