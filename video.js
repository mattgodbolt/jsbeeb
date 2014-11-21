define(['teletext'], function (Teletext) {
    return function Video(fb32, paint_ext) {
        "use strict";
        var self = this;
        self.fb32 = fb32;
        self.collook = new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff,
            0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff]);
        var screenlen = new Uint16Array([0x4000, 0x5000, 0x2000, 0x2800]);
        var cursorTable = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0x40, 0x20, 0x20]);
        var cursorFlashMask = new Uint8Array([0x00, 0x00, 0x10, 0x20]);

        self.reset = function (cpu, via) {
            self.cpu = cpu;
            self.sysvia = via;
            self.regs = new Uint8Array(32);
            self.scrX = 0;
            self.scrY = 0;
            self.clocks = 0;
            self.oddClock = false;
            self.frameCount = 0;
            self.ulactrl = 0;
            self.pixelsPerChar = 8;
            self.halfClock = false;
            self.ulaMode = 0;
            self.teletextMode = false;
            self.displayEnabled = false;
            self.vDisplayEnabled = false;
            self.horizChars = 0;
            self.vertChars = 0;
            self.memAddress = 0;
            self.startOfLineMemAddr = 0;
            self.charScanLine = 0;
            self.verticalAdjust = 0; // Vertical adjust remaining
            self.vblankLowLineCount = 0;
            self.charsLeft = 0; // chars left hanging off end of mode 7 line (due to delays, TODOs here)
            self.ulaPal = new Uint32Array(16);
            self.actualPal = new Uint8Array(16);
            self.atStartOfInterlaceLine = 0;
            self.inInterlacedLine = 0;
            self.oddFrame = false;
            self.teletext = new Teletext();
            self.cursorOn = self.cursorOff = self.cursorOnThisFrame = false;
            self.cursorDrawIndex = 0;
            self.cursorPos = 0;
            self.ilSyncAndVideo = false;
            self.blanked = false;
            self.vsyncIrqHighLines = 0;
            updateFbTable();
            updateMemAddrLow();
        };

        // from photographic reference, the visible border in mode 1 is
        // top: 9px, bottom 15px, left 23, right 28. These borders are the offset
        // at which we clip the TV picture, so they don't directly correspond to
        // the offsets.
        self.topBorder = 0;
        self.bottomBorder = -5;
        self.leftBorder = 220;
        self.rightBorder = 180;

        function paint() {
            paint_ext(
                self.leftBorder,
                self.topBorder << 1,
                1280 - self.rightBorder,
                ((320 - self.bottomBorder) << 1) + 1);
        }

        self.debugPaint = paint;

        function table4bppOffset(ulamode, byte) {
            return ulamode * 256 * 16 + byte * 16;
        }

        var table4bpp = function () {
            var t = new Uint8Array(4 * 256 * 16);
            var i;
            for (var b = 0; b < 256; ++b) {
                var temp = b;
                for (i = 0; i < 16; ++i) {
                    var left = 0;
                    if (temp & 2) left |= 1;
                    if (temp & 8) left |= 2;
                    if (temp & 32) left |= 4;
                    if (temp & 128) left |= 8;
                    t[table4bppOffset(3, b) + i] = left;
                    temp <<= 1;
                    temp |= 1;
                }
                for (i = 0; i < 16; ++i) {
                    t[table4bppOffset(2, b) + i] = t[table4bppOffset(3, b) + (i >> 1)];
                    t[table4bppOffset(1, b) + i] = t[table4bppOffset(3, b) + (i >> 2)];
                    t[table4bppOffset(0, b) + i] = t[table4bppOffset(3, b) + (i >> 3)];
                }
            }
            return t;
        }();

        var fbTableBuffer = new ArrayBuffer(256 * 16 * 4);
        var fbTable = new Uint32Array(fbTableBuffer);
        var fbTable8 = [];
        var fbTable16 = [];
        for (var fbSet = 0; fbSet < 256; ++fbSet) {
            fbTable8.push(new Uint32Array(fbTableBuffer, fbSet * 16 * 4, 8));
            fbTable16.push(new Uint32Array(fbTableBuffer, fbSet * 16 * 4, 16));
        }
        var fbTableDirty = true;

        function updateFbTable() {
            var offset = table4bppOffset(self.ulaMode, 0);
            for (var i = 0; i < 256 * 16; ++i) {
                fbTable[i] = self.ulaPal[table4bpp[offset + i]];
            }

            fbTableDirty = false;
        }

        var blankBuffer = new ArrayBuffer(16 * 4);
        var blank8 = new Uint32Array(blankBuffer, 0, 8);
        var blank16 = new Uint32Array(blankBuffer);
        for (var b16 = 0; b16 < 16; ++b16)
            blank16[b16] = self.collook[0];

        self.reset(null);

        for (var y = 0; y < 768; ++y)
            for (var x = 0; x < 1280; ++x)
                fb32[y * 1280 + x] = 0;
        paint(0, 0, 1280, 768);

        function renderBlank(x, y) {
            var offset = y * 1280 + x;
            if (self.charsLeft) {
                if (self.charsLeft !== 1) {
                    self.teletext.render(fb32, offset, self.charScanLine, false, 0xff);
                }
                self.charsLeft--;
            } else if (x < 1280) {
                clearFb(offset, self.pixelsPerChar);
                if (self.cursorDrawIndex) {
                    handleCursor(offset);
                }
            }
        }

        function blitFb8(tblOff, destOffset) {
            tblOff |= 0;
            destOffset |= 0;
            var fb32 = self.fb32;
            fb32[destOffset] = fbTable[tblOff];
            fb32[destOffset + 1] = fbTable[tblOff + 1];
            fb32[destOffset + 2] = fbTable[tblOff + 2];
            fb32[destOffset + 3] = fbTable[tblOff + 3];
            fb32[destOffset + 4] = fbTable[tblOff + 4];
            fb32[destOffset + 5] = fbTable[tblOff + 5];
            fb32[destOffset + 6] = fbTable[tblOff + 6];
            fb32[destOffset + 7] = fbTable[tblOff + 7];
        }

        function blitFb_1(dat, destOffset, numPixels) {
            var tblOff = dat << 4;
            blitFb8(tblOff, destOffset);
            if (numPixels === 16) {
                blitFb8(tblOff + 8, destOffset + 8);
            }
        }

        function blitFb_2(dat, destOffset, numPixels) {
            if (numPixels === 8) {
                self.fb32.set(fbTable8[dat], destOffset);
            } else {
                self.fb32.set(fbTable16[dat], destOffset);
            }
        }

        function clearFb_1(destOffset, numPixels) {
            var black = self.collook[0];
            var fb32 = self.fb32;
            while (numPixels--) {
                fb32[destOffset++] = black;
            }
        }

        function clearFb_2(destOffset, numPixels) {
            self.fb32.set(numPixels === 8 ? blank8 : blank16, destOffset);
        }

        var blitFb = blitFb_1;
        var clearFb = clearFb_1;

        function pickBlitters() {
            console.log("Choosing video blit routines");
            function timeBlitters() {
                var start = Date.now();
                for (var i = 0; i < 256 * 256; ++i) {
                    blitFb(i & 0xff, (i >> 8) * 1280, 16);
                }
                for (i = 0; i < 256 * 256; ++i) {
                    clearFb((i >> 8) * 1280, 16);
                }
                return Date.now() - start;
            }

            var wins = [0, 0];
            for (var round = 0; round < 10; ++round) {
                blitFb = blitFb_1;
                clearFb = clearFb_1;
                var fb1Time = timeBlitters();
                blitFb = blitFb_2;
                clearFb = clearFb_2;
                var fb2Time = timeBlitters();
                wins[fb1Time < fb2Time ? 0 : 1]++;
            }
            if (wins[0] > wins[1]) {
                blitFb = blitFb_1;
                clearFb = clearFb_1;
                console.log("Using explicit array copies (" + wins[0] + " to " + wins[1] + ")");
            } else {
                blitFb = blitFb_2;
                clearFb = clearFb_2;
                console.log("Using array.set() methods (" + wins[1] + " to " + wins[0] + ")");
            }
        }

        pickBlitters();

        function handleCursor(offset) {
            if (self.cursorOnThisFrame && (self.ulactrl & cursorTable[self.cursorDrawIndex])) {
                for (var i = 0; i < self.pixelsPerChar; ++i) {
                    fb32[offset + i] ^= 0x00ffffff;
                }
            }
            if (++self.cursorDrawIndex === 7) self.cursorDrawIndex = 0;
        }

        self.memAddrLow = 0;
        function updateMemAddrLow() {
            if (self.ilSyncAndVideo) {
                self.memAddrLow = ((self.charScanLine & 3) << 1) | self.inInterlacedLine;
            } else {
                self.memAddrLow = self.charScanLine & 7;
            }
        }

        self.screenSize = 0;
        self.setScreenSize = function (viaScreenSize) {
            self.screenSize = screenlen[viaScreenSize];
        };

        function readVideoMem() {
            if (self.memAddress & 0x2000) {
                return self.cpu.videoRead(0x7c00 | (self.memAddress & 0x3ff));
            } else {
                var addr = self.memAddrLow | (self.memAddress << 3);
                if (addr & 0x8000) addr -= self.screenSize;
                return self.cpu.videoRead(addr & 0x7fff);
            }
        }

        function renderChar(x, y) {
            if (!((self.memAddress ^ self.cursorPos) & 0x3fff) && self.cursorOn) {
                self.cursorDrawIndex = 3 - ((self.regs[8] >>> 6) & 3);
            }

            if (x < 1280) {
                var offset = y * 1280 + x;
                if (self.blanked || ((self.charScanLine & 8) && !self.teletextMode)) {
                    clearFb(offset, self.pixelsPerChar);
                } else {
                    var dat = readVideoMem();
                    if (self.teletextMode) {
                        self.teletext.render(self.fb32, offset, self.charScanLine, self.oddFrame, dat & 0x7f);
                    } else {
                        blitFb(dat, offset, self.pixelsPerChar);
                    }
                }

                if (self.cursorDrawIndex) {
                    handleCursor(offset);
                }
            }
            self.memAddress++;
        }

        var prevFirstX = -1;

        function updateLeftBorder() {
            var firstX = startX();
            if (firstX === prevFirstX) return;
            prevFirstX = firstX;
            for (var y = 0; y < 768; ++y) {
                for (var x = 0; x < firstX; ++x) {
                    clearFb(y * 1280 + x * 8, 8);
                }
            }
        }

        self.endOfLine = function () {
            self.horizChars = 0;

            var cursorEnd = self.regs[11] & 31;
            if (self.charScanLine === cursorEnd || (self.ilSyncAndVideo && self.charScanLine === (cursorEnd >>> 1))) {
                self.cursorOn = false;
                self.cursorOff = true;
            }

            if (self.verticalAdjust) {
                // Handling top few vertical adjust lines.
                self.charScanLine = (self.charScanLine + 1) & 31;
                self.memAddress = self.startOfLineMemAddr;
                updateMemAddrLow();
                if (--self.verticalAdjust === 0) {
                    self.vDisplayEnabled = self.regs[6] > 0;
                    self.memAddress = self.startOfLineMemAddr = (self.regs[13] | (self.regs[12] << 8)) & 0x3fff;
                    self.charScanLine = 0;
                }
            } else if (self.charScanLine === self.regs[9] || (self.ilSyncAndVideo && self.charScanLine === (self.regs[9] >>> 1))) {
                // end of a vertical character
                self.charScanLine = 0;
                self.startOfLineMemAddr = self.memAddress;
                updateMemAddrLow();
                self.cursorOn = self.cursorOff = false;
                self.teletext.verticalCharEnd();
                var oldVertChars = self.vertChars;
                self.vertChars = (self.vertChars + 1) & 127;
                if (self.vertChars === self.regs[6]) {
                    // hit bottom of displayed screen
                    self.vDisplayEnabled = false;
                }
                if (oldVertChars === self.regs[4]) {
                    // vertical total register count
                    self.vertChars = 0;
                    self.verticalAdjust = self.regs[5]; // load fractional adjustment
                    if (!self.verticalAdjust) {
                        self.vDisplayEnabled = self.regs[6] > 0;
                        self.memAddress = self.startOfLineMemAddr = (self.regs[13] | (self.regs[12] << 8)) & 0x3fff;
                    }
                    self.frameCount++;
                    var cursorFlash = (self.regs[10] & 0x60) >>> 5;
                    self.cursorOnThisFrame = (cursorFlash === 0) || !!(self.frameCount & cursorFlashMask[cursorFlash]);
                }
                if (self.vertChars === self.regs[7]) {
                    // vertical sync position
                    self.oddFrame = !self.oddFrame;
                    self.inInterlacedLine = !!(self.oddFrame && (self.regs[8] & 1));
                    updateMemAddrLow();
                    if (self.oddFrame) self.atStartOfInterlaceLine = !!(self.regs[8] & 1);
                    if (self.clocks > 2) {
                        paint();
                    }
                    self.scrY = 0;
                    self.sysvia.setVBlankInt(true);
                    self.vsyncIrqHighLines = (self.regs[3] >> 4) + 1;
                    if (!(self.regs[3] >> 4)) self.vsyncIrqHighLines = 17;
                    self.teletext.vsync();
                    self.clocks = 0;
                }
            } else {
                self.charScanLine = (self.charScanLine + 1) & 31;
                self.memAddress = self.startOfLineMemAddr;
                updateMemAddrLow();
            }

            self.teletext.endline();

            var cursorStartLine = self.regs[10] & 31;
            if (!self.cursorOff && (self.charScanLine === cursorStartLine || (self.ilSyncAndVideo && self.charScanLine === (cursorStartLine >>> 1)))) {
                self.cursorOn = true;
            }

            if (self.vsyncIrqHighLines) {
                if (--self.vsyncIrqHighLines === 0) {
                    // TODO: is this really necessary? b-em gives a one-cycle delay for the
                    // vsync line going low. Presumably this is for more accurate timing but
                    // I'd love to know why this is needed as it complicates things.
                    self.vblankLowLineCount = 1;
                    if (self.oddFrame) self.atStartOfInterlaceLine = !!(self.regs[8] & 1);
                }
            }
            self.displayEnabled = self.vDisplayEnabled;

            // adc, mouse? seriously?
        };

        function startX() {
            return (128 - ((self.regs[3] & 0xf) * self.pixelsPerChar / 2)) | 0;
        }

        ////////////////////
        // Main drawing routine
        self.polltime = function (clocks) {
            if (fbTableDirty) updateFbTable();
            while (clocks--) {
                self.scrX += 8;
                self.clocks++;
                self.oddClock = !self.oddClock;
                if (self.halfClock && !self.oddClock) continue;

                // Have we reached the end of this displayed line? (i.e. entering hblank)
                if (self.horizChars === self.regs[1]) {
                    if (self.teletextMode && self.displayEnabled) {
                        // Teletext mode delay (TODO: understand and maybe use r8 display delay instead)
                        self.charsLeft = 3;
                    }
                    else self.charsLeft = 0;
                    self.displayEnabled = false;
                }

                // Have we reached the horizontal sync position? (i.e. beginning of next line)
                if (self.horizChars === self.regs[2]) {
                    self.scrX = startX();
                    self.scrY++;
                    // I'm really not sure when and if this can happen; b-em does this, anyway
                    if (self.scrY >= 384) {
                        // End of the screen! (overscan?)
                        self.scrY = 0;
                        paint();
                    }
                }

                var renderY = (self.scrY << 1) | (self.oddFrame ? 1 : 0);
                if (self.displayEnabled) {
                    renderChar(self.scrX, renderY);
                } else {
                    renderBlank(self.scrX, renderY);
                }

                if (self.vblankLowLineCount) {
                    if (--self.vblankLowLineCount === 0) {
                        self.sysvia.setVBlankInt(false);
                    }
                }

                if (self.atStartOfInterlaceLine && self.horizChars === (self.regs[0] >>> 1)) {
                    // TODO: understand this mechanism:
                    // There seems to be a half-line at the top of the screen on alternating
                    // interlace lines. b-em does this, but I've yet to understand why it is
                    // necessary.
                    self.horizChars = 0;
                    self.atStartOfInterlaceLine = false;
                    self.scrX = startX();
                } else if (self.horizChars === self.regs[0]) {
                    // We've hit the end of a line (reg 0 is horiz sync char count)
                    self.endOfLine();
                } else {
                    self.horizChars = (self.horizChars + 1) & 0xff;
                }
            } // matches while
        };
        ////////////////////

        ////////////////////
        // CRTC interface
        // jshint ignore:line
        self.crtc = new (function (video) {
            var curReg = 0;
            var crtcmask = new Uint8Array([
                0xff, 0xff, 0xff, 0xff, 0x7f, 0x1f, 0x7f, 0x7f,
                0xf3, 0x1f, 0x7f, 0x1f, 0x3f, 0xff, 0x3f, 0xff,
                0x3f, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            this.read = function (addr) {
                if (addr & 1) return video.regs[curReg];
                return curReg;
            };
            this.write = function (addr, val) {
                if (addr & 1) {
                    video.regs[curReg] = val & crtcmask[curReg];
                    switch (curReg) {
                        case 3:
                            updateLeftBorder();
                            break;
                        case 8:
                            self.ilSyncAndVideo = (self.regs[8] & 3) === 3;
                            self.blanked = (self.regs[8] & 0x30) === 0x30;
                            updateMemAddrLow();
                            break;
                        case 14:
                        case 15:
                            self.cursorPos = self.regs[15] | (self.regs[14] << 8);
                            break;
                    }
                } else
                    curReg = val & 31;
            };
        })(self);


        ////////////////////
        // ULA interface
        self.ula = {
            read: function (addr) {
                return 0xff;
            },
            write: function (addr, val) {
                addr |= 0;
                val |= 0;
                var index;
                if (addr & 1) {
                    index = (val >>> 4) & 0xf;
                    self.actualPal[index] = val & 0xf;
                    var ulaCol = val & 7;
                    if (!((val & 8) && (self.ulactrl & 1)))
                        ulaCol ^= 7;
                    if (self.ulaPal[index] !== self.collook[ulaCol]) {
                        self.ulaPal[index] = self.collook[ulaCol];
                        fbTableDirty = true;
                    }
                } else {
                    if ((self.ulactrl ^ val) & 1) {
                        // Flash colour has changed.
                        var flashEnabled = !!(val & 1);
                        for (var i = 0; i < 16; ++i) {
                            index = self.actualPal[i] & 7;
                            if (!(flashEnabled && (self.actualPal[i] & 8))) index ^= 7;
                            if (self.ulaPal[i] !== self.collook[index]) {
                                self.ulaPal[i] = self.collook[index];
                                fbTableDirty = true;
                            }
                        }
                    }
                    self.ulactrl = val;
                    self.pixelsPerChar = (val & 0x10) ? 8 : 16;
                    updateLeftBorder();
                    self.halfClock = !(val & 0x10);
                    var newMode = (val >>> 2) & 3;
                    if (newMode !== self.ulaMode) {
                        self.ulaMode = newMode;
                        fbTableDirty = true;
                    }
                    self.teletextMode = !!(val & 2);
                }
            }
        };
    };
});
