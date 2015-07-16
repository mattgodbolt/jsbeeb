define(['teletext', 'utils'], function (Teletext, utils) {
    "use strict";
    return function Video(fb32_param, paint_ext_param) {
        this.fb32 = utils.makeFast32(fb32_param);
        this.collook = utils.makeFast32(new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff,
            0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff]));
        this.screenLen = new Uint16Array([0x4000, 0x5000, 0x2000, 0x2800]);
        this.cursorTable = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0x40, 0x20, 0x20]);
        this.cursorFlashMask = new Uint8Array([0x00, 0x00, 0x10, 0x20]);
        this.prevFirstX = -1;

        // from photographic reference, the visible border in mode 1 is
        // top: 9px, bottom 15px, left 23, right 28. These borders are the offset
        // at which we clip the TV picture, so they don't directly correspond to
        // the offsets.
        this.topBorder = 0;
        this.bottomBorder = -5;
        this.leftBorder = 220;
        this.rightBorder = 180;

        this.paint_ext = paint_ext_param;

        this.reset = function (cpu, via) {
            this.cpu = cpu;
            this.sysvia = via;
            this.regs = new Uint8Array(32);
            this.scrX = 0;
            this.scrY = 0;
            this.clocks = 0;
            this.oddClock = false;
            this.frameCount = 0;
            this.ulactrl = 0;
            this.pixelsPerChar = 8;
            this.halfClock = false;
            this.ulaMode = 0;
            this.teletextMode = false;
            this.displayEnabled = false;
            this.vDisplayEnabled = false;
            this.horizChars = 0;
            this.vertChars = 0;
            this.memAddress = 0;
            this.startOfLineMemAddr = 0;
            this.charScanLine = 0;
            this.verticalAdjust = 0; // Vertical adjust remaining
            this.vblankLowLineCount = 0;
            this.charsLeft = 0; // chars left hanging off end of mode 7 line (due to delays)
            this.ulaPal = utils.makeFast32(new Uint32Array(16));
            this.actualPal = new Uint8Array(16);
            this.atStartOfInterlaceLine = 0;
            this.inInterlacedLine = 0;
            this.oddFrame = false;
            this.teletext = new Teletext();
            this.cursorOn = this.cursorOff = this.cursorOnThisFrame = false;
            this.cursorDrawIndex = 0;
            this.cursorPos = 0;
            this.ilSyncAndVideo = false;
            this.blanked = false;
            this.vsyncIrqHighLines = 0;
            this.updateFbTable();
            this.updateMemAddrLow();
        };

        this.paint = function () {
            this.paint_ext(
                this.leftBorder,
                this.topBorder << 1,
                1280 - this.rightBorder,
                ((320 - this.bottomBorder) << 1) + 1
            );
        };

        this.debugPaint = this.paint;

        this.table4bppOffset = function (ulamode, byte) {
            return ulamode * 256 * 16 + byte * 16;
        };

        this.table4bpp = function (o) {
            var t = new Uint8Array(4 * 256 * 16);
            var i, b, temp, left;
            for (b = 0; b < 256; ++b) {
                temp = b;
                for (i = 0; i < 16; ++i) {
                    left = 0;
                    if (temp & 2) left |= 1;
                    if (temp & 8) left |= 2;
                    if (temp & 32) left |= 4;
                    if (temp & 128) left |= 8;
                    t[o.table4bppOffset(3, b) + i] = left;
                    temp <<= 1;
                    temp |= 1;
                }
                for (i = 0; i < 16; ++i) {
                    t[o.table4bppOffset(2, b) + i] = t[o.table4bppOffset(3, b) + (i >> 1)];
                    t[o.table4bppOffset(1, b) + i] = t[o.table4bppOffset(3, b) + (i >> 2)];
                    t[o.table4bppOffset(0, b) + i] = t[o.table4bppOffset(3, b) + (i >> 3)];
                }
            }
            return t;
        }(this);

        this.fbTableBuffer = new ArrayBuffer(256 * 16 * 4);
        this.fbTable = utils.makeFast32(new Uint32Array(this.fbTableBuffer));
        this.fbTableDirty = true;

        this.updateFbTable = function () {
            var offset = this.table4bppOffset(this.ulaMode, 0);
            for (var i = 0; i < 256 * 16; ++i) {
                this.fbTable[i] = this.ulaPal[this.table4bpp[offset + i]];
            }

            this.fbTableDirty = false;
        };

        this.renderBlank = function (x, y) {
            var offset = y * 1280 + x;
            if (this.charsLeft) {
                if (this.charsLeft !== 1) {
                    this.teletext.render(this.fb32, offset, this.charScanLine, false, 0xff);
                }
                this.charsLeft--;
            } else if (x < 1280) {
                this.clearFb(offset, this.pixelsPerChar);
                if (this.cursorDrawIndex) {
                    this.handleCursor(offset);
                }
            }
        };

        this.blitFb8 = function (tblOff, destOffset) {
            tblOff |= 0;
            destOffset |= 0;
            var fb32 = this.fb32;
            var fbTable = this.fbTable;
            fb32[destOffset] = fbTable[tblOff];
            fb32[destOffset + 1] = fbTable[tblOff + 1];
            fb32[destOffset + 2] = fbTable[tblOff + 2];
            fb32[destOffset + 3] = fbTable[tblOff + 3];
            fb32[destOffset + 4] = fbTable[tblOff + 4];
            fb32[destOffset + 5] = fbTable[tblOff + 5];
            fb32[destOffset + 6] = fbTable[tblOff + 6];
            fb32[destOffset + 7] = fbTable[tblOff + 7];
        };

        this.blitFb = function (dat, destOffset, numPixels) {
            var tblOff = dat << 4;
            this.blitFb8(tblOff, destOffset);
            if (numPixels === 16) {
                this.blitFb8(tblOff + 8, destOffset + 8);
            }
        };

        this.clearFb = function (destOffset, numPixels) {
            var black = this.collook[0];
            var fb32 = this.fb32;
            while (numPixels--) {
                fb32[destOffset++] = black;
            }
        };

        this.handleCursor = function (offset) {
            if (this.cursorOnThisFrame && (this.ulactrl & this.cursorTable[this.cursorDrawIndex])) {
                for (var i = 0; i < this.pixelsPerChar; ++i) {
                    this.fb32[offset + i] ^= 0x00ffffff;
                }
            }
            if (++this.cursorDrawIndex === 7) this.cursorDrawIndex = 0;
        };

        this.memAddrLow = 0;
        this.updateMemAddrLow = function () {
            if (this.ilSyncAndVideo) {
                this.memAddrLow = ((this.charScanLine & 3) << 1) | this.inInterlacedLine;
            } else {
                this.memAddrLow = this.charScanLine & 7;
            }
        };

        this.screenSize = 0;
        this.setScreenSize = function (viaScreenSize) {
            this.screenSize = this.screenLen[viaScreenSize];
        };

        this.readVideoMem = function () {
            if (this.memAddress & 0x2000) {
                return this.cpu.videoRead(0x7c00 | (this.memAddress & 0x3ff));
            } else {
                var addr = this.memAddrLow | (this.memAddress << 3);
                if (addr & 0x8000) addr -= this.screenSize;
                return this.cpu.videoRead(addr & 0x7fff);
            }
        };

        this.renderChar = function (x, y) {
            if (this.cursorOn && !((this.memAddress ^ this.cursorPos) & 0x3fff)) {
                this.cursorDrawIndex = 3 - ((this.regs[8] >>> 6) & 3);
            }

            if (x < 1280) {
                var offset = y * 1280 + x;
                if (this.blanked || ((this.charScanLine & 8) && !this.teletextMode)) {
                    this.clearFb(offset, this.pixelsPerChar);
                } else {
                    var dat = this.readVideoMem();
                    if (this.teletextMode) {
                        this.teletext.render(this.fb32, offset, this.charScanLine, this.oddFrame, dat & 0x7f);
                    } else {
                        this.blitFb(dat, offset, this.pixelsPerChar);
                    }
                }

                if (this.cursorDrawIndex) {
                    this.handleCursor(offset);
                }
            }
            this.memAddress++;
        };

        this.updateLeftBorder = function () {
            var firstX = this.startX();
            if (firstX === this.prevFirstX) return;
            this.prevFirstX = firstX;
            for (var y = 0; y < 768; ++y) {
                for (var x = 0; x < firstX; ++x) {
                    this.clearFb(y * 1280 + x * 8, 8);
                }
            }
        };

        this.endOfLine = function () {
            this.horizChars = 0;

            var cursorEnd = this.regs[11] & 31;
            if (this.charScanLine === cursorEnd || (this.ilSyncAndVideo && this.charScanLine === (cursorEnd >>> 1))) {
                this.cursorOn = false;
                this.cursorOff = true;
            }

            if (this.verticalAdjust) {
                // Handling top few vertical adjust lines.
                this.charScanLine = (this.charScanLine + 1) & 31;
                this.memAddress = this.startOfLineMemAddr;
                this.updateMemAddrLow();
                if (--this.verticalAdjust === 0) {
                    this.vDisplayEnabled = this.regs[6] > 0;
                    this.memAddress = this.startOfLineMemAddr = (this.regs[13] | (this.regs[12] << 8)) & 0x3fff;
                    this.charScanLine = 0;
                }
            } else if (this.charScanLine === this.regs[9] || (this.ilSyncAndVideo && this.charScanLine === (this.regs[9] >>> 1))) {
                // end of a vertical character
                this.charScanLine = 0;
                this.startOfLineMemAddr = this.memAddress;
                this.updateMemAddrLow();
                this.cursorOn = this.cursorOff = false;
                this.teletext.verticalCharEnd();
                var oldVertChars = this.vertChars;
                this.vertChars = (this.vertChars + 1) & 127;
                if (this.vertChars === this.regs[6]) {
                    // hit bottom of displayed screen
                    this.vDisplayEnabled = false;
                }
                if (oldVertChars === this.regs[4]) {
                    // vertical total register count
                    this.vertChars = 0;
                    this.verticalAdjust = this.regs[5]; // load fractional adjustment
                    if (!this.verticalAdjust) {
                        this.vDisplayEnabled = this.regs[6] > 0;
                        this.memAddress = this.startOfLineMemAddr = (this.regs[13] | (this.regs[12] << 8)) & 0x3fff;
                    }
                    this.frameCount++;
                    var cursorFlash = (this.regs[10] & 0x60) >>> 5;
                    this.cursorOnThisFrame = (cursorFlash === 0) || !!(this.frameCount & this.cursorFlashMask[cursorFlash]);
                }
                if (this.vertChars === this.regs[7]) {
                    // vertical sync position
                    this.oddFrame = !this.oddFrame;
                    this.inInterlacedLine = !!(this.oddFrame && (this.regs[8] & 1));
                    this.updateMemAddrLow();
                    if (this.oddFrame) this.atStartOfInterlaceLine = !!(this.regs[8] & 1);
                    if (this.clocks > 2) {
                        this.paint();
                    }
                    this.scrY = 0;
                    this.sysvia.setVBlankInt(true);
                    this.vsyncIrqHighLines = (this.regs[3] >> 4) + 1;
                    if (!(this.regs[3] >> 4)) this.vsyncIrqHighLines = 17;
                    this.teletext.vsync();
                    this.clocks = 0;
                }
            } else {
                this.charScanLine = (this.charScanLine + 1) & 31;
                this.memAddress = this.startOfLineMemAddr;
                this.updateMemAddrLow();
            }

            this.teletext.endline();

            var cursorStartLine = this.regs[10] & 31;
            if (!this.cursorOff && (this.charScanLine === cursorStartLine || (this.ilSyncAndVideo && this.charScanLine === (cursorStartLine >>> 1)))) {
                this.cursorOn = true;
            }

            if (this.vsyncIrqHighLines) {
                if (--this.vsyncIrqHighLines === 0) {
                    // TODO: is this really necessary? b-em gives a one-cycle delay for the
                    // vsync line going low. Presumably this is for more accurate timing but
                    // I'd love to know why this is needed as it complicates things.
                    this.vblankLowLineCount = 1;
                    if (this.oddFrame) this.atStartOfInterlaceLine = !!(this.regs[8] & 1);
                }
            }
            this.displayEnabled = this.vDisplayEnabled;

            // adc, mouse? seriously?
        };

        this.startX = function () {
            return (128 - ((this.regs[3] & 0xf) * this.pixelsPerChar / 2)) | 0;
        };

        ////////////////////
        // Main drawing routine
        this.polltime = function (clocks) {
            if (this.fbTableDirty) this.updateFbTable();
            while (clocks--) {
                this.scrX += 8;
                this.clocks++;
                this.oddClock = !this.oddClock;
                if (this.halfClock && !this.oddClock) continue;

                // Have we reached the end of this displayed line? (i.e. entering hblank)
                if (this.horizChars === this.regs[1]) {
                    if (this.teletextMode && this.displayEnabled) {
                        // Teletext mode delay (TODO: understand and maybe use r8 display delay instead)
                        this.charsLeft = 3;
                    }
                    else this.charsLeft = 0;
                    this.displayEnabled = false;
                }

                // Have we reached the horizontal sync position? (i.e. beginning of next line)
                if (this.horizChars === this.regs[2]) {
                    this.scrX = this.startX();
                    this.scrY++;
                    // I'm really not sure when and if this can happen; b-em does this, anyway
                    if (this.scrY >= 384) {
                        // End of the screen! (overscan?)
                        this.scrY = 0;
                        this.paint();
                    }
                }

                var renderY = (this.scrY << 1) | (this.oddFrame ? 1 : 0);
                if (this.displayEnabled) {
                    this.renderChar(this.scrX, renderY);
                } else {
                    this.renderBlank(this.scrX, renderY);
                }

                if (this.vblankLowLineCount) {
                    if (--this.vblankLowLineCount === 0) {
                        this.sysvia.setVBlankInt(false);
                    }
                }

                if (this.atStartOfInterlaceLine && this.horizChars === (this.regs[0] >>> 1)) {
                    // TODO: understand this mechanism:
                    // There seems to be a half-line at the top of the screen on alternating
                    // interlace lines. b-em does this, but I've yet to understand why it is
                    // necessary.
                    this.horizChars = 0;
                    this.atStartOfInterlaceLine = false;
                    this.scrX = this.startX();
                } else if (this.horizChars === this.regs[0]) {
                    // We've hit the end of a line (reg 0 is horiz sync char count)
                    this.endOfLine();
                } else {
                    this.horizChars = (this.horizChars + 1) & 0xff;
                }
            } // matches while
        };
        ////////////////////

        ////////////////////
        // CRTC interface
        function Crtc(video) {
            this.video = video;
            this.curReg = 0;
            this.crtcmask = new Uint8Array([
                0xff, 0xff, 0xff, 0xff, 0x7f, 0x1f, 0x7f, 0x7f,
                0xf3, 0x1f, 0x7f, 0x1f, 0x3f, 0xff, 0x3f, 0xff,
                0x3f, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        }

        Crtc.prototype.read = function (addr) {
            if (addr & 1) return this.video.regs[this.curReg];
            return this.curReg;
        };
        Crtc.prototype.write = function (addr, val) {
            if (addr & 1) {
                this.video.regs[this.curReg] = val & this.crtcmask[this.curReg];
                switch (this.curReg) {
                    case 3:
                        this.video.updateLeftBorder();
                        break;
                    case 8:
                        this.video.ilSyncAndVideo = (this.video.regs[8] & 3) === 3;
                        this.video.blanked = (this.video.regs[8] & 0x30) === 0x30;
                        this.video.updateMemAddrLow();
                        break;
                    case 14:
                    case 15:
                        this.video.cursorPos = this.video.regs[15] | (this.video.regs[14] << 8);
                        break;
                }
            } else
                this.curReg = val & 31;
        };
        this.crtc = new Crtc(this);

        ////////////////////
        // ULA interface
        function Ula(video) {
            this.video = video;
        }

        Ula.prototype.read = function () {
            return 0xff;
        };
        Ula.prototype.write = function (addr, val) {
            addr |= 0;
            val |= 0;
            var index;
            if (addr & 1) {
                index = (val >>> 4) & 0xf;
                this.video.actualPal[index] = val & 0xf;
                var ulaCol = val & 7;
                if (!((val & 8) && (this.video.ulactrl & 1)))
                    ulaCol ^= 7;
                if (this.video.ulaPal[index] !== this.video.collook[ulaCol]) {
                    this.video.ulaPal[index] = this.video.collook[ulaCol];
                    this.video.fbTableDirty = true;
                }
            } else {
                if ((this.video.ulactrl ^ val) & 1) {
                    // Flash colour has changed.
                    var flashEnabled = !!(val & 1);
                    for (var i = 0; i < 16; ++i) {
                        index = this.video.actualPal[i] & 7;
                        if (!(flashEnabled && (this.video.actualPal[i] & 8))) index ^= 7;
                        if (this.video.ulaPal[i] !== this.video.collook[index]) {
                            this.video.ulaPal[i] = this.video.collook[index];
                            this.video.fbTableDirty = true;
                        }
                    }
                }
                this.video.ulactrl = val;
                this.video.pixelsPerChar = (val & 0x10) ? 8 : 16;
                this.video.updateLeftBorder();
                this.video.halfClock = !(val & 0x10);
                var newMode = (val >>> 2) & 3;
                if (newMode !== this.video.ulaMode) {
                    this.video.ulaMode = newMode;
                    this.video.fbTableDirty = true;
                }
                this.video.teletextMode = !!(val & 2);
            }
        };
        this.ula = new Ula(this);

        this.reset(null);

        for (var y = 0; y < 768; ++y)
            for (var x = 0; x < 1280; ++x)
                this.fb32[y * 1280 + x] = 0;
        this.paint(0, 0, 1280, 768);
    };
});
