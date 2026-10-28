import { makeChars } from "./teletext_data.js";
import { BbcDefaultPalette as BbcDefaultCollook } from "./bbc-palette.js";
import { makeFast32 } from "./binary.js";
import {
    TeletextBlack,
    TeletextCellCapacity,
    TeletextDoubled,
    TeletextOffsetShift,
    TeletextPaletteMask,
} from "./video-drain.js";

// A line that ends logs at most 256 entries, one per character clock; this bounds the log when no DISPTMG
// falling edge ends a line, as while R8 disables the display. Every entry can be a cell to paint.
const LogCapacity = TeletextCellCapacity;
const DataBits = 0x7f;
const ClockedEntry = 0x80;
const ShownEntry = 0x100;
const DoubleHeight = 13;
const PipelineLength = 4;
const PipelineLag = PipelineLength - 1;

// What `clockCharacter` reads or changes besides the pipeline and the cell it latches.
class LineState {
    constructor(glyphs) {
        this.wasDbl = false;
        this.reset(glyphs);
    }

    // A DISPTMG falling edge; `setDISPTMG` clears `wasDbl` itself, once the row end has read it.
    reset(glyphs) {
        this.col = 7;
        this.bg = 0;
        this.holdChar = false;
        this.heldChar = 0x20;
        this.nextGlyphs = this.heldGlyphs = glyphs;
        this.flash = false;
        this.sep = false;
        this.gfx = false;
        this.conceal = false;
        this.dbl = false;
    }
}

export class Teletext {
    constructor() {
        this.prevCol = 0;
        this.oldDbl = this.secondHalfOfDouble = false;
        this.flashTime = 0;
        this.cellGlyphIndex = 0;
        this.cellFlash = false;
        this.cellConceal = false;
        this.cellPalette = 0;
        this.dataQueue = new Uint8Array(PipelineLength);
        this.scanlineCounter = 0;
        this.levelDEW = false;
        this.levelDISPTMG = false;
        this.levelRA0 = false;

        // Bytes on the chip's input that it has not run yet, bit 7 set where it was clocked, and the cells to paint
        // where the clocked byte is shown.
        this.log = new Int32Array(LogCapacity);
        this.logLength = 0;
        this.logShows = false;
        this.output = null;
        // The cell `clockCharacter` latches outlives the line reset, and a snapshot saves part of it. So the last
        // line skipped by `skipLine` is kept with the state it started from, until a clocked byte replaces
        // that cell.
        this.skippedLog = new Int32Array(LogCapacity);
        this.skippedLogLength = 0;
        this.skippedQueue = new Uint8Array(PipelineLength);

        this.normalGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.graphicsGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.separatedGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.colour = makeFast32(new Uint32Array(256));

        this.curGlyphs = this.normalGlyphs;
        this.line = new LineState(this.normalGlyphs);
        this.skippedLine = new LineState(this.normalGlyphs);

        this.init();
    }

    init() {
        const charData = makeChars();

        // Build palette from BBC default colours.
        this.rebuildColours(BbcDefaultCollook);

        function getLoResGlyphRow(c, row) {
            if (row < 0 || row >= 20) {
                return 0;
            } else {
                let index = c * 60 + (row >>> 1) * 6;
                let result = 0;
                for (let x = 0; x < 6; ++x) {
                    result |= (charData[index++] * 3) << (x * 2);
                }
                return result;
            }
        }

        function combineRows(a, b) {
            return a | ((a >>> 1) & b & ~(b >>> 1)) | ((a << 1) & b & ~(b << 1));
        }

        function makeHiResGlyphs(dest, graphicsGlyphs) {
            let index = 0;
            for (let c = 0; c < 96; ++c) {
                for (let row = 0; row < 20; ++row) {
                    let data;
                    if (!graphicsGlyphs || !!(c & 32)) {
                        data = combineRows(getLoResGlyphRow(c, row), getLoResGlyphRow(c, row + (row & 1 ? 1 : -1)));
                    } else {
                        data = getLoResGlyphRow(c, row);
                    }
                    dest[index++] =
                        (data & 0x1) * 0x7 +
                        (data & 0x2) * 0x14 +
                        (data & 0x4) * 0x34 +
                        (data & 0x8) * 0xe0 +
                        (data & 0x10) * 0x280 +
                        (data & 0x20) * 0x680 +
                        (data & 0x40) * 0x1c00 +
                        (data & 0x80) * 0x5000 +
                        (data & 0x100) * 0xd000 +
                        (data & 0x200) * 0x38000 +
                        (data & 0x400) * 0xa0000 +
                        (data & 0x800) * 0x1a0000;
                }
            }
        }

        makeHiResGlyphs(this.normalGlyphs, false);

        function setGraphicsBlock(c, x, y, w, h, sep, n) {
            for (let yy = 0; yy < h; ++yy) {
                for (let xx = 0; xx < w; ++xx) {
                    charData[c * 60 + (y + yy) * 6 + (x + xx)] = sep && (xx === 0 || yy === h - 1) ? 0 : n;
                }
            }
        }

        // Build graphics character set
        for (let c = 0; c < 96; ++c) {
            if (!(c & 32)) {
                setGraphicsBlock(c, 0, 0, 3, 3, false, !!(c & 1));
                setGraphicsBlock(c, 3, 0, 3, 3, false, !!(c & 2));
                setGraphicsBlock(c, 0, 3, 3, 4, false, !!(c & 4));
                setGraphicsBlock(c, 3, 3, 3, 4, false, !!(c & 8));
                setGraphicsBlock(c, 0, 7, 3, 3, false, !!(c & 16));
                setGraphicsBlock(c, 3, 7, 3, 3, false, !!(c & 64));
            }
        }

        makeHiResGlyphs(this.graphicsGlyphs, true);

        // Build separated graphics character set
        for (let c = 0; c < 96; ++c) {
            if (!(c & 32)) {
                setGraphicsBlock(c, 0, 0, 3, 3, true, !!(c & 1));
                setGraphicsBlock(c, 3, 0, 3, 3, true, !!(c & 2));
                setGraphicsBlock(c, 0, 3, 3, 4, true, !!(c & 4));
                setGraphicsBlock(c, 3, 3, 3, 4, true, !!(c & 8));
                setGraphicsBlock(c, 0, 7, 3, 3, true, !!(c & 16));
                setGraphicsBlock(c, 3, 7, 3, 3, true, !!(c & 64));
            }
        }

        makeHiResGlyphs(this.separatedGlyphs, true);
    }

    /**
     * Rebuild the 256-entry colour lookup from a 16-entry ABGR collook palette.
     * Each entry encodes: bits 7-5 = background colour index (0-7),
     * bits 4-2 = foreground colour index (0-7), bits 1-0 = blend weight.
     * Reference: b-em mode7_gen_nula_lookup().
     * @param {Uint32Array} collook - 16-entry palette in ABGR format (0xffBBGGRR).
     */
    rebuildColours(collook) {
        const gamma = 1.0 / 2.2;
        for (let i = 0; i < 256; ++i) {
            const weight = (i & 3) / 3.0;
            const fgIndex = (i >> 2) & 7;
            const bgIndex = (i >> 5) & 7;
            const fgColour = collook[fgIndex];
            const bgColour = collook[bgIndex];
            const fgR = (fgColour & 0xff) / 255;
            const fgG = ((fgColour >> 8) & 0xff) / 255;
            const fgB = ((fgColour >> 16) & 0xff) / 255;
            const bgR = (bgColour & 0xff) / 255;
            const bgG = ((bgColour >> 8) & 0xff) / 255;
            const bgB = ((bgColour >> 16) & 0xff) / 255;
            const blendedR = Math.pow(fgR * weight + bgR * (1.0 - weight), gamma) * 240;
            const blendedG = Math.pow(fgG * weight + bgG * (1.0 - weight), gamma) * 240;
            const blendedB = Math.pow(fgB * weight + bgB * (1.0 - weight), gamma) * 240;
            this.colour[i] = blendedR | 0 | ((blendedG | 0) << 8) | ((blendedB | 0) << 16) | (0xff << 24);
        }
    }

    snapshotState() {
        this.catchUp();
        // Encode glyph table references as strings for serialization
        let nextGlyphsName, curGlyphsName, heldGlyphsName;
        for (const [name, table] of [
            ["normal", this.normalGlyphs],
            ["graphics", this.graphicsGlyphs],
            ["separated", this.separatedGlyphs],
        ]) {
            if (this.line.nextGlyphs === table) nextGlyphsName = name;
            if (this.curGlyphs === table) curGlyphsName = name;
            if (this.line.heldGlyphs === table) heldGlyphsName = name;
        }
        return {
            prevCol: this.prevCol,
            col: this.line.col,
            bg: this.line.bg,
            sep: this.line.sep,
            dbl: this.line.dbl,
            oldDbl: this.oldDbl,
            secondHalfOfDouble: this.secondHalfOfDouble,
            wasDbl: this.line.wasDbl,
            gfx: this.line.gfx,
            conceal: this.line.conceal,
            flash: this.line.flash,
            flashTime: this.flashTime,
            heldChar: this.line.heldChar,
            holdChar: this.line.holdChar,
            dataQueue: [...this.dataQueue],
            scanlineCounter: this.scanlineCounter,
            levelDEW: this.levelDEW,
            levelDISPTMG: this.levelDISPTMG,
            levelRA0: this.levelRA0,
            nextGlyphs: nextGlyphsName,
            curGlyphs: curGlyphsName,
            heldGlyphs: heldGlyphsName,
        };
    }

    restoreState(state) {
        this.prevCol = state.prevCol;
        this.line.col = state.col;
        this.line.bg = state.bg;
        this.line.sep = state.sep;
        this.line.dbl = state.dbl;
        this.oldDbl = state.oldDbl;
        this.secondHalfOfDouble = state.secondHalfOfDouble;
        this.line.wasDbl = state.wasDbl;
        this.line.gfx = state.gfx;
        this.line.conceal = state.conceal ?? false;
        this.line.flash = state.flash;
        this.flashTime = state.flashTime;
        this.line.heldChar = state.heldChar;
        this.line.holdChar = state.holdChar;
        this.dataQueue.set(state.dataQueue);
        this.scanlineCounter = state.scanlineCounter;
        this.levelDEW = state.levelDEW;
        this.levelDISPTMG = state.levelDISPTMG;
        this.levelRA0 = state.levelRA0;
        this.logLength = 0;
        this.logShows = false;
        this.skippedLogLength = 0;

        const glyphMap = {
            normal: this.normalGlyphs,
            graphics: this.graphicsGlyphs,
            separated: this.separatedGlyphs,
        };
        this.line.nextGlyphs = glyphMap[state.nextGlyphs] || this.normalGlyphs;
        this.curGlyphs = glyphMap[state.curGlyphs] || this.normalGlyphs;
        this.line.heldGlyphs = glyphMap[state.heldGlyphs] || this.normalGlyphs;
    }

    setNextChars() {
        const line = this.line;
        if (line.gfx) {
            if (line.sep) {
                line.nextGlyphs = this.separatedGlyphs;
            } else {
                line.nextGlyphs = this.graphicsGlyphs;
            }
        } else {
            line.nextGlyphs = this.normalGlyphs;
        }
    }

    handleControlCode(data) {
        const line = this.line;
        const wasGfx = line.gfx;
        const wasHoldChar = line.holdChar;

        switch (data) {
            case 1:
            case 2:
            case 3:
            case 4:
            case 5:
            case 6:
            case 7:
                line.gfx = false;
                line.col = data;
                line.conceal = false;
                this.setNextChars();
                break;
            case 8:
                line.flash = true;
                break;
            case 9:
                line.flash = false;
                break;
            case 12:
            case 13:
                line.dbl = !!(data & 1);
                if (line.dbl) line.wasDbl = true;
                break;
            case 17:
            case 18:
            case 19:
            case 20:
            case 21:
            case 22:
            case 23:
                line.gfx = true;
                line.col = data & 7;
                line.conceal = false;
                this.setNextChars();
                break;
            case 24:
                line.conceal = true;
                break;
            case 25:
                line.sep = false;
                this.setNextChars();
                break;
            case 26:
                line.sep = true;
                this.setNextChars();
                break;
            case 28:
                line.bg = 0;
                break;
            case 29:
                line.bg = line.col;
                break;
            case 30:
                line.holdChar = true;
                break;
            case 31:
                line.holdChar = false;
                break;
        }
        if (wasGfx && (wasHoldChar || line.holdChar) && line.dbl === this.oldDbl) {
            data = line.heldChar;
            this.curGlyphs = line.heldGlyphs;
        } else {
            line.heldChar = 0x20;
            data = 0x20;
        }

        return data;
    }

    fetchData(data) {
        // `copyWithin` over four bytes costs more than the moves it saves.
        this.dataQueue[0] = this.dataQueue[1];
        this.dataQueue[1] = this.dataQueue[2];
        this.dataQueue[2] = this.dataQueue[3];
        this.dataQueue[3] = data & DataBits;
    }

    /** Feeds `data` and clocks the chip with the byte leaving the pipeline, by the time anything reads the chip. */
    logClocked(data) {
        if (this.logLength === LogCapacity) this.catchUp();
        this.log[this.logLength++] = data | ClockedEntry;
    }

    /** Feeds `data` without clocking the chip, as `fetchData` does, by the time anything reads the chip. */
    logFed(data) {
        if (this.logLength === LogCapacity) this.catchUp();
        this.log[this.logLength++] = data & DataBits;
    }

    /**
     * Paints shown cells with `drain`, from now on in its teletextColour, which takes on the colours so far.
     * @param {import("./video-drain.js").VideoDrain} drain
     */
    setOutput(drain) {
        drain.teletextColour.set(this.colour);
        this.colour = drain.teletextColour;
        this.output = drain;
    }

    /**
     * Shows the cell the byte logged last clocks at `offset` in the framebuffer, painted when the log runs.
     * @param {number} offset
     * @param {boolean} doubledLines also paint the row below
     * @param {boolean} black show black, as the "TTX trick" does, rather than the chip's output
     */
    showLatest(offset, doubledLines, black) {
        this.log[this.logLength - 1] |=
            (offset << TeletextOffsetShift) |
            ShownEntry |
            (doubledLines ? TeletextDoubled : 0) |
            (black ? TeletextBlack : 0);
        this.logShows = true;
    }

    /**
     * Runs everything logged, so the chip is as if each byte had been run as it arrived, and paints the cells it
     * shows. Painting the chip, or feeding it directly with `fetchData`, must come after this once anything has been
     * logged.
     */
    catchUp() {
        const length = this.logLength;
        this.logLength = 0;
        this.logShows = false;
        if (this.replayLog(this.log, length)) this.skippedLogLength = 0;
        this.replaySkippedLine();
    }

    /** Runs the log if it holds a cell to paint: before anything that changes how one paints, or reads the picture. */
    catchUpShown() {
        if (this.logShows) this.catchUp();
    }

    // Returns whether any entry clocked the chip.
    replayLog(log, length) {
        const queue = this.dataQueue;
        // Everything a shown cell reads besides the cell catches the log up before it changes.
        const glyphRow = this.glyphRow();
        const doubleHeightGlyphRow = this.doubleHeightGlyphRow();
        const hideFlashing = this.hideFlashing;
        const cells = this.output?.teletextCells;
        let cellWords = 0;
        let clocked = false;
        // The first few clocked entries run bytes still in the pipeline; see skipLine.
        for (let i = 0; i < length; ++i) {
            const entry = log[i];
            if (!(entry & ClockedEntry)) continue;
            clocked = true;
            this.clockCharacter(i < PipelineLag ? queue[i + 1] : log[i - PipelineLag] & DataBits);
            if (!(entry & ShownEntry)) continue;

            // Two bits a pixel, indexing the cell's palette; none set shows only the background.
            let pixels = 0;
            if (!(
                entry & TeletextBlack ||
                this.cellConceal ||
                (this.cellFlash && hideFlashing) ||
                (this.secondHalfOfDouble && !this.line.dbl)
            )) {
                pixels = this.curGlyphs[this.cellGlyphIndex + (this.oldDbl ? doubleHeightGlyphRow : glyphRow)];
            }
            cells[cellWords++] = pixels;
            // A shown entry is a painted cell's second word (see video-drain.js) once its low byte holds the palette.
            cells[cellWords++] = (entry & ~TeletextPaletteMask) | this.cellPalette;
        }
        if (cellWords) this.output.paintTeletext(cellWords >> 1);
        this.feedLast(log, length);
        return clocked;
    }

    // Leaves the pipeline as feeding the log's entries would.
    feedLast(log, length) {
        if (length < PipelineLength) {
            for (let i = 0; i < length; ++i) this.fetchData(log[i]);
        } else {
            for (let i = 0; i < PipelineLength; ++i) this.dataQueue[i] = log[length - PipelineLength + i] & DataBits;
        }
    }

    /**
     * Brings the log to the end of a line without running it, for the DISPTMG reset that follows: that
     * reset leaves the pipeline, whether a double height code reached its head, and the latched cell.
     */
    skipLine() {
        const length = this.logLength;
        if (length === 0) return;
        this.logLength = 0;
        const log = this.log;
        const queue = this.dataQueue;

        let anyClocked = false;
        for (let i = length - 1; i >= 0 && !anyClocked; --i) anyClocked = !!(log[i] & ClockedEntry);
        if (anyClocked) {
            this.skippedQueue.set(queue);
            Object.assign(this.skippedLine, this.line);
            this.log = this.skippedLog;
            this.skippedLog = log;
            this.skippedLogLength = length;
        }

        // Each clocked entry runs the byte fed PipelineLag entries before it.
        for (let i = 0; i < Math.min(PipelineLag, length); ++i) {
            if (log[i] & ClockedEntry && queue[i + 1] === DoubleHeight) this.line.wasDbl = true;
        }
        for (let i = 0; i + PipelineLag < length; ++i) {
            if ((log[i] & DataBits) === DoubleHeight && log[i + PipelineLag] & ClockedEntry) {
                this.line.wasDbl = true;
                break;
            }
        }

        this.feedLast(log, length);
    }

    // Recovers the cell latched by the last line `skipLine` passed over, leaving everything else as it is.
    replaySkippedLine() {
        if (this.skippedLogLength === 0) return;
        const line = this.line;
        this.line = this.skippedLine;
        const queue = this.dataQueue.slice();
        this.dataQueue.set(this.skippedQueue);
        this.replayLog(this.skippedLog, this.skippedLogLength);
        this.skippedLine = this.line;
        this.line = line;
        this.dataQueue.set(queue);
        this.skippedLogLength = 0;
    }

    setDEW(level) {
        // The SAA5050 input pin "DEW" is connected to the 6845 output pin
        // "VSYNC" and it is used to track frames.
        const oldLevel = this.levelDEW;
        this.levelDEW = level;

        // Trigger on high -> low. This appears to be what the hardware does.
        // It needs to be this way for the scanline counter to stay in sync
        // if you set R6>R4.
        if (!oldLevel || level) {
            return;
        }

        this.catchUpShown();
        this.scanlineCounter = 0;
        this.secondHalfOfDouble = false;

        // 3:1 flash ratio.
        if (++this.flashTime === 64) this.flashTime = 0;
    }

    // The phase against the cursor blink depends on how many DEW pulses precede the MOS programming
    // the CRTC. The SAA5050 has no reset and the 6845's registers power up undefined, so real hardware
    // presumably has no fixed phase either.
    get hideFlashing() {
        return this.flashTime < 16;
    }

    setDISPTMG(level) {
        // The SAA5050 input pin "LOSE" is connected to the 6845 output pin
        // "DISPTMG" and it is used to track scanlines.
        const oldLevel = this.levelDISPTMG;
        this.levelDISPTMG = level;

        // Trigger on high -> low. This is probably what the hardware does as
        // we need to increment scanline at the end of the scanline, not the
        // beginning.
        if (!oldLevel || level) {
            return;
        }

        if (this.logShows) {
            this.catchUp();
        } else {
            this.skipLine();
        }
        this.line.reset(this.normalGlyphs);

        this.scanlineCounter++;
        // Check for end of character row.
        if (this.scanlineCounter === 10) {
            this.scanlineCounter = 0;

            if (this.secondHalfOfDouble) {
                this.secondHalfOfDouble = false;
            } else {
                this.secondHalfOfDouble = this.line.wasDbl;
            }
        }

        this.line.wasDbl = false;
    }

    setRA0(level) {
        // The SAA5050 input pin "CRS" is connected to the 6845 output pin
        // "RA0", via a signal inverter, and it is used to select between a
        // normal scanline and a calculated smoothing scanline.
        this.catchUpShown();
        this.levelRA0 = level;
    }

    /** Applies `data`, as the byte leaving the pipeline, to the character state and latches the cell it shows. */
    clockCharacter(data) {
        const line = this.line;
        this.oldDbl = line.dbl;

        this.prevCol = line.col;
        this.curGlyphs = line.nextGlyphs;

        let flashThisCell = line.flash;
        let concealThisCell = line.conceal;
        if (data < 0x20) {
            data = this.handleControlCode(data);
        } else if (line.gfx) {
            if (data & 0x20) {
                line.heldChar = data;
                line.heldGlyphs = this.curGlyphs;
            }
        } else {
            line.heldChar = 32;
        }

        // Flash (code 8) is "Set After" — flashThisCell retains the pre-control-code state.
        // Steady (code 9) is "Set At" — update so this cell stops flashing immediately.
        if (flashThisCell && !line.flash) flashThisCell = false;

        // Conceal (code 24) is "Set At", and a colour code only reveals from the cell after itself.
        if (line.conceal) concealThisCell = true;

        this.cellGlyphIndex = (data - 32) * 20;
        this.cellFlash = flashThisCell;
        this.cellConceal = concealThisCell;
        this.cellPalette = ((line.bg & 7) << 5) | ((this.prevCol & 7) << 2);
    }

    glyphScanline() {
        return this.oldDbl ? this.doubleHeightGlyphRow() : this.glyphRow();
    }

    glyphRow() {
        return (this.scanlineCounter << 1) | (this.levelRA0 ? 1 : 0);
    }

    doubleHeightGlyphRow() {
        return (this.glyphRow() >>> 1) + (this.secondHalfOfDouble ? 10 : 0);
    }

    // The second half of the latched cell, for the ULA's 1MHz repaint.
    emitSecondHalf(buf, offset) {
        const scanline = this.glyphScanline();
        if (this.cellConceal || (this.cellFlash && this.hideFlashing) || (this.secondHalfOfDouble && !this.line.dbl)) {
            const backgroundColour = this.colour[this.cellPalette & 0xe0];
            for (let pixel = 8; pixel < 16; ++pixel) {
                buf[offset + pixel] = backgroundColour;
            }
        } else {
            let chardef = this.curGlyphs[this.cellGlyphIndex + scanline] >>> 16;
            const paletteIndex = this.cellPalette;
            for (let pixel = 8; pixel < 16; ++pixel) {
                buf[offset + pixel] = this.colour[paletteIndex + (chardef & 3)];
                chardef >>>= 2;
            }
        }
    }
}
