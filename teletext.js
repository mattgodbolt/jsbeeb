define(['./teletext_data', './utils'], function (ttData, utils) {
    "use strict";

    function Teletext() {
        this.prevCol = 0;
        this.holdOff = false;
        this.col = 7;
        this.bg = 0;
        this.sep = false;
        this.dbl = this.oldDbl = this.secondHalfOfDouble = this.wasDbl = false;
        this.gfx = false;
        this.flash = this.flashOn = false;
        this.flashTime = 0;
        this.heldChar = false;
        this.holdChar = 0;
        this.dataQueue = [0, 0, 0, 0];
        this.scanlineCounter = 0;
        this.levelDEW = false;
        this.levelDISPTMG = false;
        this.levelRA0 = false;

        this.normalGlyphs = utils.makeFast32(new Uint32Array(96 * 20));
        this.graphicsGlyphs = utils.makeFast32(new Uint32Array(96 * 20));
        this.separatedGlyphs = utils.makeFast32(new Uint32Array(96 * 20));
        this.colour = utils.makeFast32(new Uint32Array(256));

        this.nextGlyphs = this.normalGlyphs;
        this.curGlyphs = this.normalGlyphs;
        this.heldGlyphs = this.normalGlyphs;

        this.init = function () {
            var charData = ttData.makeChars();
            var i, x, x2, stat, offs1, offs2, j, k, y, o, p;

            // Build palette
            var gamma = 1.0 / 2.2;
            for (i = 0; i < 256; ++i) {
                var alpha = (i & 3) / 3.0;
                var foregroundR = !!(i & 4);
                var foregroundG = !!(i & 8);
                var foregroundB = !!(i & 16);
                var backgroundR = !!(i & 32);
                var backgroundG = !!(i & 64);
                var backgroundB = !!(i & 128);
                // Gamma-corrected blending
                var blendedR = Math.pow(foregroundR * alpha + backgroundR * (1.0 - alpha), gamma) * 240;
                var blendedG = Math.pow(foregroundG * alpha + backgroundG * (1.0 - alpha), gamma) * 240;
                var blendedB = Math.pow(foregroundB * alpha + backgroundB * (1.0 - alpha), gamma) * 240;
                this.colour[i] = blendedR | (blendedG << 8) | (blendedB << 16) | (0xFF << 24);
            }

            function getLoResGlyphRow(c, row) {
                if (row < 0 || row >= 20) {
                    return 0;
                } else {
                    var index = c * 60 + (row >>> 1) * 6;
                    var result = 0;
                    for (var x = 0; x < 6; ++x) {
                        result |= ((charData[index++] * 3) << (x * 2));
                    }
                    return result;
                }
            }

            function combineRows(a, b) {
                return a | ((a >>> 1) & b & ~(b >>> 1)) | ((a << 1) & b & ~(b << 1));
            }

            function makeHiResGlyphs(dest, graphicsGlyphs) {
                var index = 0;
                for (var c = 0; c < 96; ++c) {
                    for (var row = 0; row < 20; ++row) {
                        var data;
                        if (!graphicsGlyphs || !!(c & 32)) {
                            data = combineRows(getLoResGlyphRow(c, row), getLoResGlyphRow(c, row + ((row & 1) ? 1 : -1)));
                        } else {
                            data = getLoResGlyphRow(c, row);
                        }
                        dest[index++] = ((data & 0x1) * 0x7) + ((data & 0x2) * 0x14) + ((data & 0x4) * 0x34) + ((data & 0x8) * 0xE0) +
                            ((data & 0x10) * 0x280) + ((data & 0x20) * 0x680) + ((data & 0x40) * 0x1C00) + ((data & 0x80) * 0x5000) +
                            ((data & 0x100) * 0xD000) + ((data & 0x200) * 0x38000) + ((data & 0x400) * 0xA0000) + ((data & 0x800) * 0x1A0000);
                    }
                }
            }

            makeHiResGlyphs(this.normalGlyphs, false);

            function setGraphicsBlock(c, x, y, w, h, sep, n) {
                for (var yy = 0; yy < h; ++yy) {
                    for (var xx = 0; xx < w; ++xx) {
                        charData[c * 60 + (y + yy) * 6 + (x + xx)] = (sep && (xx === 0 || yy === (h - 1))) ? 0 : n;
                    }
                }
            }

            // Build graphics character set
            for (var c = 0; c < 96; ++c) {
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
            for (c = 0; c < 96; ++c) {
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
        };
        this.init();
    }

    Teletext.prototype.setNextChars = function () {
        if (this.gfx) {
            if (this.sep) {
                this.nextGlyphs = this.separatedGlyphs;
            } else {
                this.nextGlyphs = this.graphicsGlyphs;
            }
        } else {
            this.nextGlyphs = this.normalGlyphs;
        }
    };

    Teletext.prototype.handleControlCode = function (data) {
        this.holdOff = false;

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
                this.holdOff = true;
                break;
        }
        if (this.holdChar && this.dbl === this.oldDbl) {
            data = this.heldChar;
            if (data >= 0x40 && data < 0x60) data = 0x20;
            this.curGlyphs = this.heldGlyphs;
        } else {
            this.heldChar = 0x20;
            data = 0x20;
        }
        return data;
    };

    Teletext.prototype.fetchData = function (data) {
        this.dataQueue.shift();
        this.dataQueue.push(data & 0x7F);
    };


    Teletext.prototype.setDEW = function (level) {
        // The SAA5050 input pin "DEW" is connected to the 6845 output pin
        // "VSYNC" and it is used to track frames.
        var oldlevel = this.levelDEW;
        this.levelDEW = level;

        // Trigger on high -> low. This appears to be what the hardware does.
        // It needs to be this way for the scanline counter to stay in sync
        // if you set R6>R4.
        if (!oldlevel || level) {
            return;
        }

        this.scanlineCounter = 0;

        if (++this.flashTime === 48) this.flashTime = 0;
        this.flashOn = this.flashTime < 16;
    };

    Teletext.prototype.setDISPTMG = function (level) {
        // The SAA5050 input pin "LOSE" is connected to the 6845 output pin
        // "DISPTMG" and it is used to track scanlines.
        var oldlevel = this.levelDISPTMG;
        this.levelDISPTMG = level;

        // Trigger on high -> low. This is probably what the hardware does as
        // we need to increment scanline at the end of the scanline, not the
        // beginning.
        if (!oldlevel || level) {
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
    };

    Teletext.prototype.setRA0 = function (level) {
        // The SAA5050 input pin "CRS" is connected to the 6845 output pin
        // "RA0", via a signal inverter, and it is used to select between a
        // normal scanline and a calculated smoothing scanline.
        this.levelRA0 = level;
    };

    Teletext.prototype.render = function (buf, offset) {
        var i;
        var data = this.dataQueue[0];

        var scanline = (this.scanlineCounter << 1);
        if (this.levelRA0) {
            scanline++;
        }

        this.oldDbl = this.dbl;

        this.prevCol = this.col;
        this.curGlyphs = this.nextGlyphs;

        var prevFlash = this.flash;
        if (data < 0x20) {
            data = this.handleControlCode(data);
        } else if (this.gfx) {
            this.heldChar = data;
            this.heldGlyphs = this.curGlyphs;
        }

        if (this.oldDbl) {
            scanline = (scanline >>> 1);
            if (this.secondHalfOfDouble) {
                scanline += 10;
            }
        }
        var chardef = this.curGlyphs[(data - 32) * 20 + scanline];

        if ((prevFlash && this.flashOn) || (this.secondHalfOfDouble && !this.dbl)) {
            var backgroundColour = this.colour[(this.bg & 7) << 5];
            for (i = 0; i < 16; ++i) {
                buf[offset++] = backgroundColour;
            }
        } else {
            var paletteIndex = ((this.bg & 7) << 5) | ((this.prevCol & 7) << 2);

            // TODO: see if we should unroll here (we used to, before it got more complex).
            for (var pixel = 0; pixel < 16; ++pixel) {
                buf[offset + pixel] = this.colour[paletteIndex + (chardef & 3)];
                chardef >>>= 2;
            }
        }

        if (this.holdOff) {
            this.holdChar = false;
            this.heldChar = 32;
        }
    };

    return Teletext;
});
