"use strict";
import { makeChars } from "./teletext_data.js";
import { makeFast32 } from "./utils.js";

export class Teletext {
    constructor() {
        this.prevCol = 0;
        this.col = 7;
        this.bg = 0;
        this.sep = false;
        this.dbl = this.oldDbl = this.secondHalfOfDouble = this.wasDbl = false;
        this.gfx = false;
        this.flash = this.flashOn = false;
        this.flashTime = 0;
        this.heldChar = 0;
        this.holdChar = false;
        this.dataQueue = [0, 0, 0, 0];
        this.scanlineCounter = 0;
        this.levelDEW = false;
        this.levelDISPTMG = false;
        this.levelRA0 = false;

        this.normalGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.graphicsGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.separatedGlyphs = makeFast32(new Uint32Array(96 * 20));
        this.colour = makeFast32(new Uint32Array(256));

        this.nextGlyphs = this.normalGlyphs;
        this.curGlyphs = this.normalGlyphs;
        this.heldGlyphs = this.normalGlyphs;

        this.init();
    }

    init() {
        const charData = makeChars();

        // Build palette
        const gamma = 1.0 / 2.2;
        for (let i = 0; i < 256; ++i) {
            const alpha = (i & 3) / 3.0;
            const foregroundR = !!(i & 4);
            const foregroundG = !!(i & 8);
            const foregroundB = !!(i & 16);
            const backgroundR = !!(i & 32);
            const backgroundG = !!(i & 64);
            const backgroundB = !!(i & 128);
            // Gamma-corrected blending
            const blendedR = Math.pow(foregroundR * alpha + backgroundR * (1.0 - alpha), gamma) * 240;
            const blendedG = Math.pow(foregroundG * alpha + backgroundG * (1.0 - alpha), gamma) * 240;
            const blendedB = Math.pow(foregroundB * alpha + backgroundB * (1.0 - alpha), gamma) * 240;
            this.colour[i] = blendedR | (blendedG << 8) | (blendedB << 16) | (0xff << 24);
        }

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

    setNextChars() {
        if (this.gfx) {
            if (this.sep) {
                this.nextGlyphs = this.separatedGlyphs;
            } else {
                this.nextGlyphs = this.graphicsGlyphs;
            }
        } else {
            this.nextGlyphs = this.normalGlyphs;
        }
    }

    handleControlCode(data) {
        const wasGfx = this.gfx;
        const wasHoldChar = this.holdChar;

        switch (data) {
            case 1:
            case 2:
            case 3:
            case 4:
            case 5:
            case 6:
            case 7:
                this.gfx = false;
                this.col = data;
                this.setNextChars();
                break;
            case 8:
                this.flash = true;
                break;
            case 9:
                this.flash = false;
                break;
            case 12:
            case 13:
                this.dbl = !!(data & 1);
                if (this.dbl) this.wasDbl = true;
                break;
            case 17:
            case 18:
            case 19:
            case 20:
            case 21:
            case 22:
            case 23:
                this.gfx = true;
                this.col = data & 7;
                this.setNextChars();
                break;
            case 24:
                this.col = this.prevCol = this.bg;
                break;
            case 25:
                this.sep = false;
                this.setNextChars();
                break;
            case 26:
                this.sep = true;
                this.setNextChars();
                break;
            case 28:
                this.bg = 0;
                break;
            case 29:
                this.bg = this.col;
                break;
            case 30:
                this.holdChar = true;
                break;
            case 31:
                this.holdChar = false;
                break;
        }
        if (wasGfx && (wasHoldChar || this.holdChar) && this.dbl === this.oldDbl) {
            data = this.heldChar;
            if (data >= 0x40 && data < 0x60) data = 0x20;
            this.curGlyphs = this.heldGlyphs;
        } else {
            this.heldChar = 0x20;
            data = 0x20;
        }

        return data;
    }

    fetchData(data) {
        this.dataQueue.shift();
        this.dataQueue.push(data & 0x7f);
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

        this.scanlineCounter = 0;
        this.secondHalfOfDouble = false;

        // 3:1 flash ratio.
        if (++this.flashTime === 64) this.flashTime = 0;
        // Flashing text starts off in sync with a slow cursor, extinguished
        // together.  Multiple MODE changes gradually desynchronise the
        // frame counters.
        // TODO: this point is being reached a MOS-dependent number of times
        // before Video.frameCount rises.  The next line achieves initial
        // sync under MOS 1.20 only.
        this.flashOn = this.flashTime < 16;
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

        this.col = 7;
        this.bg = 0;
        this.holdChar = false;
        this.heldChar = 0x20;
        this.nextGlyphs = this.heldGlyphs = this.normalGlyphs;
        this.flash = false;
        this.sep = false;
        this.gfx = false;
        this.dbl = false;

        this.scanlineCounter++;
        // Check for end of character row.
        if (this.scanlineCounter === 10) {
            this.scanlineCounter = 0;

            if (this.secondHalfOfDouble) {
                this.secondHalfOfDouble = false;
            } else {
                this.secondHalfOfDouble = this.wasDbl;
            }
        }

        this.wasDbl = false;
    }

    setRA0(level) {
        // The SAA5050 input pin "CRS" is connected to the 6845 output pin
        // "RA0", via a signal inverter, and it is used to select between a
        // normal scanline and a calculated smoothing scanline.
        this.levelRA0 = level;
    }

    render(buf, offset) {
        let data = this.dataQueue[0];

        let scanline = this.scanlineCounter << 1;
        if (this.levelRA0) {
            scanline++;
        }

        this.oldDbl = this.dbl;

        this.prevCol = this.col;
        this.curGlyphs = this.nextGlyphs;

        const prevFlash = this.flash;
        if (data < 0x20) {
            data = this.handleControlCode(data);
        } else if (this.gfx) {
            if (data & 0x20) {
                this.heldChar = data;
                this.heldGlyphs = this.curGlyphs;
            }
        } else {
            this.heldChar = 32;
        }

        if (this.oldDbl) {
            scanline = scanline >>> 1;
            if (this.secondHalfOfDouble) {
                scanline += 10;
            }
        }
        let chardef = this.curGlyphs[(data - 32) * 20 + scanline];

        if ((prevFlash && this.flashOn) || (this.secondHalfOfDouble && !this.dbl)) {
            const backgroundColour = this.colour[(this.bg & 7) << 5];
            for (let i = 0; i < 16; ++i) {
                buf[offset++] = backgroundColour;
            }
        } else {
            const paletteIndex = ((this.bg & 7) << 5) | ((this.prevCol & 7) << 2);

            for (let pixel = 0; pixel < 16; ++pixel) {
                buf[offset + pixel] = this.colour[paletteIndex + (chardef & 3)];
                chardef >>>= 2;
            }
        }
    }
}
