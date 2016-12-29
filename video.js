define(['./teletext', './utils'], function (Teletext, utils) {
    const VDISPENABLE = 1 << 0,
        HDISPENABLE = 1 << 1,
        SKEWDISPENABLE = 1 << 2,
        SCANLINEDISPENABLE = 1 << 3,
        USERDISPENABLE = 1 << 4,
        EVERYTHINGENABLED = VDISPENABLE | HDISPENABLE | SKEWDISPENABLE | SCANLINEDISPENABLE | USERDISPENABLE;

    function Video(fb32_param, paint_ext_param) {
        "use strict";
        this.fb32 = utils.makeFast32(fb32_param);
        this.collook = utils.makeFast32(new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff,
            0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff]));
        this.screenAddrAdd = new Uint16Array([0x4000, 0x3000, 0x6000, 0x5800]);
        this.cursorTable = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0x40, 0x20, 0x20]);
        this.cursorFlashMask = new Uint8Array([0x00, 0x00, 0x10, 0x20]);
        this.regs = new Uint8Array(32);
        this.bitmapX = 0;
        this.bitmapY = 0;
        this.clocks = 0;
        this.oddClock = false;
        this.frameCount = 0;
        this.inHSync = false;
        this.inVSync = false;
        this.inVertAdjust = false;
        this.hpulseWidth = 0;
        this.vpulseWidth = 0;
        this.hpulseCounter = 0;
        this.vpulseCounter = 0;
        this.dispEnabled = 0;
        this.horizCounter = 0;
        this.vertCounter = 0;
        this.scanlineCounter = 0;
        this.addr = 0;
        this.addrLine = 0;
        this.lineStartAddr = 0;
        this.nextLineStartAddr = 0;
        this.ulactrl = 0;
        this.pixelsPerChar = 8;
        this.halfClock = false;
        this.ulaMode = 0;
        this.teletextMode = false;
        this.displayEnableSkew = 0;
        this.ulaPal = utils.makeFast32(new Uint32Array(16));
        this.actualPal = new Uint8Array(16);
        this.drawHalfScanline = false;
        this.oddFrame = false;
        this.teletext = new Teletext();
        this.cursorOn = this.cursorOff = this.cursorOnThisFrame = false;
        this.cursorDrawIndex = 0;
        this.cursorPos = 0;
        this.interlacedSyncAndVideo = false;
        this.doubledScanlines = true;

        this.topBorder = 12;
        this.bottomBorder = 13;
        this.leftBorder = 5 * 16;
        this.rightBorder = 3 * 16;

        this.paint_ext = paint_ext_param;

        this.reset = function (cpu, via, hard) {
            this.cpu = cpu;
            this.sysvia = via;
            if (hard) {
                this.updateFbTable();
            }
        };

        this.paint = function () {
            this.paint_ext(
                this.leftBorder,
                this.topBorder,
                1024 - this.rightBorder,
                625 - this.bottomBorder
            );
        };

        function copyFb(dest, src) {
            for (var i = 0; i < 1024 * 768; ++i) {
                dest[i] = src[i];
            }
        }

        var debugPrevScreen = null;

        this.debugOffset = function (x, y) {
            if (x < 0 || x >= 1024) return -1;
            if (y < 0 || y >= 768) return -1;
            var renderY = (y << 1) | ((this.oddFrame && (this.interlacedSyncAndVideo || !this.doubledScanlines)) ? 1 : 0);
            return renderY * 1024 + x;
        };

        function lerp1(a, b, alpha) {
            var val = (b - a) * alpha + a;
            if (val < 0) val = 0;
            if (val > 255) val = 255;
            return val;
        }

        function lerp(col1, col2, alpha) {
            if (alpha < 0) alpha = 0;
            if (alpha > 1) alpha = 1;
            var r1 = (col1 >>> 16) & 0xff;
            var g1 = (col1 >>> 8) & 0xff;
            var b1 = (col1 >>> 0) & 0xff;
            var r2 = (col2 >>> 16) & 0xff;
            var g2 = (col2 >>> 8) & 0xff;
            var b2 = (col2 >>> 0) & 0xff;
            var red = lerp1(r1, r2, alpha);
            var green = lerp1(g1, g2, alpha);
            var blue = lerp1(b1, b2, alpha);
            return 0xff000000 | (red << 16) | (green << 8) | blue;
        }

        this.debugPaint = function () {
            if (!debugPrevScreen) {
                debugPrevScreen = new Uint32Array(1024 * 768);
            }
            copyFb(debugPrevScreen, this.fb32);
            var dotSize = 10;
            var x, y;
            for (y = -dotSize; y <= dotSize; y++) {
                for (x = -dotSize; x <= dotSize; ++x) {
                    var dist = Math.sqrt(x * x + y * y) / dotSize;
                    if (dist > 1) continue;
                    var offset = this.debugOffset(this.bitmapX + x, this.bitmapY + y);
                    this.fb32[offset] = lerp(this.fb32[offset], 0xffffff, Math.pow(1 - dist, 2));
                }
            }
            this.paint();
            copyFb(this.fb32, debugPrevScreen);
        };

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

        this.renderBlank = function (offset) {
            this.clearFb(offset, this.pixelsPerChar);
            if (this.doubledScanlines && !this.interlacedSyncAndVideo) {
                this.clearFb(offset + 1024, this.pixelsPerChar);
            }
        };

        this.renderHalfBlank = function (offset) {
            this.clearFb(offset, this.pixelsPerChar >>> 1);
            if (this.doubledScanlines && !this.interlacedSyncAndVideo) {
                this.clearFb(offset + 1024, this.pixelsPerChar >>> 1);
            }
        };

        this.blitFb8 = function (tblOff, destOffset, doubled) {
            tblOff |= 0;
            destOffset |= 0;
            var fb32 = this.fb32;
            var fbTable = this.fbTable;
            if (doubled) {
                fb32[destOffset] = fb32[destOffset + 1024] = fbTable[tblOff];
                fb32[destOffset + 1] = fb32[destOffset + 1025] = fbTable[tblOff + 1];
                fb32[destOffset + 2] = fb32[destOffset + 1026] = fbTable[tblOff + 2];
                fb32[destOffset + 3] = fb32[destOffset + 1027] = fbTable[tblOff + 3];
                fb32[destOffset + 4] = fb32[destOffset + 1028] = fbTable[tblOff + 4];
                fb32[destOffset + 5] = fb32[destOffset + 1029] = fbTable[tblOff + 5];
                fb32[destOffset + 6] = fb32[destOffset + 1030] = fbTable[tblOff + 6];
                fb32[destOffset + 7] = fb32[destOffset + 1031] = fbTable[tblOff + 7];
            } else {
                fb32[destOffset] = fbTable[tblOff];
                fb32[destOffset + 1] = fbTable[tblOff + 1];
                fb32[destOffset + 2] = fbTable[tblOff + 2];
                fb32[destOffset + 3] = fbTable[tblOff + 3];
                fb32[destOffset + 4] = fbTable[tblOff + 4];
                fb32[destOffset + 5] = fbTable[tblOff + 5];
                fb32[destOffset + 6] = fbTable[tblOff + 6];
                fb32[destOffset + 7] = fbTable[tblOff + 7];
            }
        };

        this.blitFb = function (dat, destOffset, numPixels, doubled) {
            var tblOff = dat << 4;
            this.blitFb8(tblOff, destOffset, doubled);
            if (numPixels === 16) {
                this.blitFb8(tblOff + 8, destOffset + 8, doubled);
            }
        };

        this.clearFb = function (destOffset, numPixels) {
            var black = 0xFF000000;
            var fb32 = this.fb32;
            while (numPixels--) {
                fb32[destOffset++] = black;
            }
        };

        this.handleCursor = function (offset) {
            if (this.cursorOnThisFrame && (this.ulactrl & this.cursorTable[this.cursorDrawIndex])) {
                var i;
                for (i = 0; i < this.pixelsPerChar; ++i) {
                    this.fb32[offset + i] ^= 0x00ffffff;
                }
                if (this.doubledScanlines && !this.interlacedSyncAndVideo) {
                    for (i = 0; i < this.pixelsPerChar; ++i) {
                        this.fb32[offset + 1024 + i] ^= 0x00ffffff;
                    }
                }
            }
            if (++this.cursorDrawIndex === 7) this.cursorDrawIndex = 0;
        };

        this.screenAdd = 0;
        this.setScreenAdd = function (viaScreenAdd) {
            this.screenAdd = this.screenAddrAdd[viaScreenAdd];
        };

        this.readVideoMem = function () {
            if (this.addr & 0x2000) {
                // Mode 7 chunky addressing mode if MA13 set; address offset by scanline is ignored
                return this.cpu.videoRead(0x7c00 | (this.addr & 0x3ff));
            } else {
                var addr = (this.addrLine & 0x07) | (this.addr << 3);
                // Perform screen address wrap around if MA12 set
                if (this.addr & 0x1000) addr += this.screenAdd;
                return this.cpu.videoRead(addr & 0x7fff);
            }
        };

        this.renderChar = function (offset, dat) {
            if (this.teletextMode) {
                this.teletext.render(this.fb32, offset, (this.scanlineCounter << 1) | (this.oddFrame ? 1 : 0));
            } else {
                this.blitFb(dat, offset, this.pixelsPerChar, this.doubledScanlines && !this.interlacedSyncAndVideo);
            }
        };

        this.endOfFrame = function () {
            this.vertCounter = 0;
            this.nextLineStartAddr = (this.regs[13] | (this.regs[12] << 8)) & 0x3FFF;
            this.dispEnabled |= VDISPENABLE;
            this.frameCount++;
            var cursorFlash = (this.regs[10] & 0x60) >>> 5;
            this.cursorOnThisFrame = (cursorFlash === 0) || !!(this.frameCount & this.cursorFlashMask[cursorFlash]);
        };

        this.endOfLine = function () {

            var cursorEnd = this.interlacedSyncAndVideo ? (this.regs[11] >>> 1) : this.regs[11];
            if (this.scanlineCounter === cursorEnd) {
                this.cursorOn = false;
                this.cursorOff = true;
            }

            // Handle VSync
            if (this.inVSync) {
                this.vpulseCounter = (this.vpulseCounter + 1) & 0x0F;
                if (this.vpulseCounter === this.vpulseWidth) {
                    this.inVSync = false;
                    if (this.oddFrame) this.drawHalfScanline = !!(this.regs[8] & 1);
                    this.sysvia.setVBlankInt(false);
                }
            }

            var numScanlines = this.inVertAdjust ? (this.regs[5] - 1) : (this.interlacedSyncAndVideo ? (this.regs[9] >>> 1) : this.regs[9]);
            if (this.scanlineCounter === numScanlines) {
                // New screen row
                if (this.inVertAdjust) {
                    // Finished vertical adjust
                    this.endOfFrame();
                    this.inVertAdjust = false;
                } else {
                    // Handle vertical total
                    if (this.vertCounter === this.regs[4]) {
                        if (this.regs[5] === 0) {
                            this.endOfFrame();
                        } else {
                            this.inVertAdjust = true;
                        }
                    } else {
                        // Still updating screen
                        this.vertCounter = (this.vertCounter + 1) & 0x7F;

                        // Initiate vsync
                        if (this.vertCounter === this.regs[7]) {
                            this.inVSync = true;
                            this.vpulseCounter = 0;

                            this.oddFrame = !this.oddFrame;
                            if (this.oddFrame) this.drawHalfScanline = !!(this.regs[8] & 1);
                            if (this.clocks > 2) { // TODO: wat?
                                this.paint();
                            }
                            this.bitmapY = 0;
                            this.sysvia.setVBlankInt(true);
                            this.teletext.vsync();
                            this.clocks = 0;
                        }
                    }
                }

                this.scanlineCounter = 0;
                this.teletext.verticalCharEnd();
                this.lineStartAddr = this.nextLineStartAddr;
                this.addrLine = (this.interlacedSyncAndVideo && this.oddFrame) ? 1 : 0;
                this.dispEnabled |= SCANLINEDISPENABLE;
                this.cursorOn = this.cursorOff = false;

                // Handle vertical displayed
                if (this.vertCounter === this.regs[6]) {
                    this.dispEnabled &= ~VDISPENABLE;
                }
            } else {
                // Move to the next scanline
                this.scanlineCounter = (this.scanlineCounter + 1) & 0x1F;
                if (this.scanlineCounter === 8 && !this.teletextMode) {
                    this.dispEnabled &= ~SCANLINEDISPENABLE;
                }
                this.addrLine += (this.interlacedSyncAndVideo ? 2 : 1);
            }

            this.addr = this.lineStartAddr;
            this.teletext.endline();

            var cursorStartLine = this.regs[10] & 31;
            if (!this.cursorOff && (this.scanlineCounter === cursorStartLine || (this.interlacedSyncAndVideo && this.scanlineCounter === (cursorStartLine >>> 1)))) {
                this.cursorOn = true;
            }
        };


        ////////////////////
        // Main drawing routine
        this.polltime = function (clocks) {
            if (this.fbTableDirty) this.updateFbTable();

            while (clocks--) {
                this.clocks++;
                this.oddClock = !this.oddClock;
                if (!this.halfClock || this.oddClock) {

                    // Handle HSync
                    if (this.inHSync) {
                        this.hpulseCounter = (this.hpulseCounter + 1) & 0x0F;
                        if (this.hpulseCounter === (this.hpulseWidth >>> 1)) {
                            this.bitmapX = 0;

                            // Half-clock horizontal movement
                            if (this.hpulseWidth & 1) {
                                this.bitmapX = -4;
                            }

                            this.bitmapY++;
                            // If no VSync occurs this frame, go back to the top and force a repaint
                            if (this.bitmapY >= 384) {
                                // Arbitrary moment when TV will give up and start flyback in the absence of an explicit VSync signal
                                this.bitmapY = 0;
                                this.paint();
                            }
                        } else if (this.hpulseCounter === (this.regs[3] & 0x0F)) {
                            this.inHSync = false;
                        }
                    }

                    // Handle delayed display enable due to skew
                    if (this.horizCounter === this.displayEnableSkew + (this.teletextMode ? 2 : 0)) {
                        this.dispEnabled |= SKEWDISPENABLE;
                    }

                    // Latch next line screen address in case we are in the last line of a character row
                    if (this.horizCounter === this.regs[1]) {
                        this.nextLineStartAddr = this.addr;
                    }

                    // Handle end of horizontal displayed, accounting for display enable skew
                    if (this.horizCounter === this.regs[1] + this.displayEnableSkew + (this.teletextMode ? 2 : 0)) {
                        this.dispEnabled &= ~(HDISPENABLE | SKEWDISPENABLE);
                    }

                    // Initiate HSync
                    if (this.horizCounter === this.regs[2]) {
                        this.inHSync = true;
                        this.hpulseCounter = 0;
                    }

                    // Handle cursor
                    if (this.horizCounter < this.regs[1] && this.cursorOn && !((this.addr ^ this.cursorPos) & 0x3fff)) {
                        this.cursorDrawIndex = 3 - ((this.regs[8] >>> 6) & 3);
                    }

                    // Read data from address pointer if both horizontal and vertical display enabled
                    var dat;
                    if ((this.dispEnabled & (HDISPENABLE | VDISPENABLE)) === (HDISPENABLE | VDISPENABLE)) {

                        dat = this.readVideoMem();
                        if (this.teletextMode) {
                            this.teletext.fetchData(dat);
                        }

                        this.addr++;
                    }

                    // Render data or border depending on display enable state
//                    var renderY = (this.bitmapY << 1) | ((this.oddFrame && !!(this.regs[8] & 1)) ? 1 : 0);    // emulate 'shaky' interlace
                    var renderY = (this.bitmapY << 1) | ((this.oddFrame && (this.interlacedSyncAndVideo || !this.doubledScanlines)) ? 1 : 0);

                    if (this.bitmapX >= 0 && this.bitmapX < 1024 && renderY < 625) {
                        var offset = renderY * 1024 + this.bitmapX;
                        if ((this.dispEnabled & EVERYTHINGENABLED) === EVERYTHINGENABLED) {
                            this.renderChar(offset, dat);
                        } else {
                            this.renderBlank(offset);
                        }

                        if (this.cursorDrawIndex) {
                            this.handleCursor(offset);
                        }
                    }

                    // Handle horizontal total
                    if (this.drawHalfScanline && this.horizCounter === (this.regs[0] >>> 1)) {
                        // In interlace mode, the odd field is displaced from the even field by rasterizing
                        // half a scanline directly after the VBlank in odd fields and forcing HBlank
                        // immediately (since the vertical speed of the raster beam is constant). This is
                        // then adjusted for even fields by rasterizing a further half a scanline before their
                        // VBlank.
                        this.horizCounter = 0;
                        this.drawHalfScanline = false;
                    } else if (this.horizCounter === this.regs[0]) {
                        // We've hit the end of a line (reg 0 is horiz sync char count)
                        this.endOfLine();
                        this.horizCounter = 0;
                        this.dispEnabled |= HDISPENABLE;
                    } else {
                        this.horizCounter = (this.horizCounter + 1) & 0xff;
                    }
                }

                this.bitmapX += 8;

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
                        this.video.hpulseWidth = val & 0x0F;
                        this.video.vpulseWidth = (val & 0xF0) >>> 4;
                        break;
                    case 8:
                        this.video.interlacedSyncAndVideo = (val & 3) === 3;
                        var skew = (val & 0x30) >>> 4;
                        if (skew < 3) {
                            this.video.displayEnableSkew = skew;
                            this.video.dispEnabled |= USERDISPENABLE;
                        } else {
                            this.video.dispEnabled &= ~USERDISPENABLE;
                        }
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

        for (var y = 0; y < 625; ++y)
            for (var x = 0; x < 1024; ++x)
                this.fb32[y * 1024 + x] = 0;
        this.paint(0, 0, 1024, 625);
    }

    function FakeVideo() {
        "use strict";
        this.reset = function () {
        };
        this.ula = this.crtc = {
            read: function () {
                return 0xff;
            },
            write: utils.noop
        };
        this.polltime = utils.noop;
        this.setScreenAdd = utils.noop;
    }

    return {
        Video: Video,
        FakeVideo: FakeVideo
    };
});
