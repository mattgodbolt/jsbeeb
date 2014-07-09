define(['teletext'], function (Teletext) {
    return function Video(fb32, paint_ext) {
        "use strict";
        var self = this;
        self.fb32 = fb32;
        self.paint = paint;
        // TODO: on Chrome 35 making this a Uint32Array seems to push ula.write into a deopt party.
        self.collook = /*new Uint32Array(*/[
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff,
            0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff];//);
        var screenlen = new Uint16Array([0x4000, 0x5000, 0x2000, 0x2800]);
        var cursorTable = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0x40, 0x20, 0x20]);
        var cursorFlashMask = new Uint8Array([0x00, 0x00, 0x10, 0x20]);

        self.reset = function (cpu, via) {
            self.cpu = cpu;
            self.sysvia = via;
            self.regs = new Uint8Array(32);
            self.scrx = 0;
            self.scry = 0;
            self.vidclocks = 0;
            self.oddclock = false;
            self.frameCount = 0;
            self.ulactrl = 0;
            self.pixelsPerChar = 8;
            self.halfClock = false;
            self.ulamode = 0;
            self.crtcmode = 0;
            self.dispen = false;
            self.vdispen = false;
            self.hc = 0; // horiz chars
            self.vc = 0; // vert chars
            self.ma = 0; // memory address?
            self.maback = 0; // copy of mem address; used to re-read same memory within a vert char
            self.sc = 0; // scanline within frame
            self.vadj = 0; // Vertical adjust remaining
            self.vidbytes = 0;
            self.hvblcount = 0;
            self.charsleft = 0; // chars left hanging off end of mode 7 line
            self.ulapal = new Uint32Array(16);
            self.bakpal = new Uint8Array(16);
            self.interline = 0;// maybe can delete? don't support interlace
            self.interlline = 0; // maybe delete?
            self.oldr8 = 0;
            self.frameodd = false;
            self.teletext = new Teletext();
            self.minx = self.miny = 65535;
            self.maxx = self.maxy = 0;
            self.con = self.coff = self.cursoron = false; // on this line, off, on due to flash
            self.cdraw = 0;
            self.lastMinX = self.lastMaxX = self.lastMinY = self.lastMaxY = 0;
            updateFbTable();
        };

        function paint() {
            if (self.minx >= self.maxx || self.miny >= self.maxy) {
                paint_ext(0, 0, 1280, 768);
            } else {
                paint_ext(self.minx, self.miny, self.maxx, self.maxy);
            }
            self.lastMinX = self.minx;
            self.lastMaxX = self.maxx;
            self.lastMinY = self.miny;
            self.lastMaxY = self.maxy;
            self.minx = self.miny = 65535;
            self.maxx = self.maxy = 0;
        }

        self.debugPaint = function () {
            paint_ext(self.lastMinX, self.lastMinY, self.lastMaxX, self.lastMaxY);
        };

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

        function fbTableOffset(byte) {
            return ((byte | 0) * 16) | 0;
        }

        var fbTable = new Uint32Array(256 * 16);
        var fbTableDirty = true;

        function updateFbTable() {
            var offset = table4bppOffset(self.ulamode, 0);
            for (var i = 0; i < 256 * 16; ++i) {
                fbTable[i] = self.ulapal[table4bpp[offset + i]];
            }

            fbTableDirty = false;
        }

        self.reset(null);

        for (var y = 0; y < 768; ++y)
            for (var x = 0; x < 1280; ++x)
                fb32[y * 1280 + x] = 0;
        paint(0, 0, 1280, 768);

        function renderblank() {
            if (self.charsleft) {
                if (self.charsleft != 1) {
                    self.teletext.render(fb32, self.scry * 1280 + self.scrx, self.sc, 0xff);
                }
                self.charsleft--;
            } else if (self.scrx < 1280) {
                clearFb(self.scry * 1280 + self.scrx, self.pixelsPerChar);
            }
            // TODO: cursor, if cdraw and scrx<1280..
        }

        function blitFb8(tblOff, destOffset) {
            tblOff |= 0; destOffset |= 0;
            var fb32 = self.fb32;
            fb32[destOffset]   = fbTable[tblOff];
            fb32[destOffset+1] = fbTable[tblOff+1];
            fb32[destOffset+2] = fbTable[tblOff+2];
            fb32[destOffset+3] = fbTable[tblOff+3];
            fb32[destOffset+4] = fbTable[tblOff+4];
            fb32[destOffset+5] = fbTable[tblOff+5];
            fb32[destOffset+6] = fbTable[tblOff+6];
            fb32[destOffset+7] = fbTable[tblOff+7];
        }

        function blitFb(dat, destOffset, numPixels) {
            var tblOff = fbTableOffset(dat);
            blitFb8(tblOff, destOffset);
            if (numPixels === 16) {
                blitFb8(tblOff + 8, destOffset + 8);
            }
        }

        function clearFb(destOffset, numPixels) {
            var black = self.collook[0];
            var fb32 = self.fb32;
            while (numPixels--) {
                fb32[destOffset++] = black;
            }
        }

        function renderchar() {
            var vidbank = 0; // TODO: vid bank support

            var cursorPos = self.regs[15] | (self.regs[14] << 8);
            if (!((self.ma ^ cursorPos) & 0x3fff) && self.con) {
                self.cdraw = 3 - ((self.regs[8] >>> 6) & 3);
                // TODO - hack to get mode7 cursor lined up - fix
                if (self.crtcmode === 0) self.cdraw = 3;
            }

            var dat = 0;
            if (self.ma & 0x2000) {
                dat = self.cpu.readmem(0x7c00 | (self.ma & 0x3ff) | vidbank);
            } else {
                var ilSyncAndVideo = (self.regs[8] & 3) === 3;
                var addr = ilSyncAndVideo ? ((self.ma << 3) | ((self.sc & 3) << 1) | self.interlline)
                    : ((self.ma << 3) | (self.sc & 7));
                if (addr & 0x8000) addr -= screenlen[self.sysvia.getScrSize()];
                dat = self.cpu.readmem((addr & 0x7fff) | vidbank) | 0;
            }
            if (self.scrx < 1280) {
                var offset = (self.scry * 1280 + self.scrx) | 0;
                var pixels = self.pixelsPerChar;
                var fb32 = self.fb32;
                var fbOffset = offset;
                var i;
                if ((self.regs[8] & 0x30) === 0x30 || ((self.sc & 8) && !(self.ulactrl & 2))) {
                    clearFb(fbOffset, pixels);
                } else {
                    var lastx;
                    if (self.crtcmode === 0) {
                        self.teletext.render(fb32, offset, self.sc, dat & 0x7f);
                        var firstx = self.scrx + 16;
                        if (firstx < self.minx) self.minx = firstx;
                        lastx = self.scrx + 32;
                        if (lastx > self.maxx) self.maxx = lastx;
                    } else {
                        blitFb(dat, fbOffset, pixels);
                        if (self.scrx < self.minx) self.minx = self.scrx;
                        lastx = self.scrx + pixels;
                        if (lastx > self.maxx) self.maxx = lastx;
                    }
                }

                // TODO: move to common rendering code so handles case of being blank
                if (self.cdraw) {
                    if (self.cursoron && (self.ulactrl & cursorTable[self.cdraw])) {
                        for (i = 0; i < pixels; ++i) {
                            fb32[offset + i] = self.fb32[offset + i] ^ 0x00ffffff;
                        }
                    }
                    if (++self.cdraw === 7) self.cdraw = 0;
                }
            }
            self.ma++;
            self.vidbytes++;
        }

        self.endofline = function () {
            var interlaced = (self.regs[8] & 3) === 3; // todo rename ilSyncAndVideo as above?
            self.hc = 0;

            var cursorEnd = self.regs[11] & 31;
            if (self.sc === cursorEnd || (interlaced && self.sc === (cursorEnd >>> 1))) {
                self.con = false;
                self.coff = true;
            }

            if (self.vadj) {
                // Handling top few vertical adjust lines.
                self.sc = (self.sc + 1) & 31;
                self.ma = self.maback;
                if (--self.vadj === 0) {
                    self.vdispen = true;
                    self.ma = self.maback = (self.regs[13] | (self.regs[12] << 8)) & 0x3fff;
                    self.sc = 0;
                }
            } else if (self.sc === self.regs[9] || (interlaced && self.sc === (self.regs[9] >>> 1))) {
                // end of a vertical character
                self.maback = self.ma;
                self.sc = 0;
                self.con = self.coff = false;
                self.teletext.verticalCharEnd();
                var oldvc = self.vc;
                self.vc = (self.vc + 1) & 127;
                if (self.vc === self.regs[6]) {
                    // hit bottom of displayed screen
                    self.vdispen = false;
                }
                if (oldvc === self.regs[4]) {
                    // vertical total register count
                    self.vc = 0;
                    self.vadj = self.regs[5]; // load fractional adjustment
                    if (!self.vadj) {
                        self.vdispen = true;
                        self.ma = self.maback = (self.regs[13] | (self.regs[12] << 8)) & 0x3fff;
                    }
                    self.frameCount++;
                    var cursorFlash = (self.regs[10] & 0x60) >>> 5;
                    self.cursoron = (cursorFlash === 0) || !!(self.frameCount & cursorFlashMask[cursorFlash]);
                }
                if (self.vc === self.regs[7]) {
                    // vertical sync position
                    //if (!(self.regs[8] & 1) && self.oldr8) clearToColour(); TODO: this!
                    self.frameodd = !self.frameodd;
                    if (self.frameodd) self.interline = !!(self.regs[8] & 1);
                    self.interlline = self.frameodd && (self.regs[8] & 1);
                    self.oldr8 = self.regs[8] & 1;
                    if (self.vidclocks > 2) {
                        paint();
                    }
                    self.scry = 0;
                    self.sysvia.vblankint();
                    self.vsynctime = (self.regs[3] >> 4) + 1;
                    if (!(self.regs[3] >> 4)) self.vsynctime = 17;
                    self.teletext.vsync();
                    self.vidclocks = self.vidbytes = 0;
                }
            } else {
                self.sc = (self.sc + 1) & 31;
                self.ma = self.maback;
            }

            self.teletext.endline();

            var cursorStartLine = self.regs[10] & 31;
            if (!self.coff && (self.sc === cursorStartLine || (interlaced && self.sc === (cursorStartLine >>> 1)))) {
                self.con = true;
            }

            if (self.vsynctime) {
                self.vsynctime--;
                if (!self.vsynctime) {
                    self.hvblcount = 1;
                    if (self.frameodd) self.interline = self.regs[8] & 1;
                }
            }
            self.dispen = self.vdispen;
            if (self.dispen || self.vadj) {
                if (self.scry < self.miny) self.miny = self.scry;
                var nextY = self.scry + 1;
                if (nextY > self.maxy) self.maxy = nextY;
            }

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
                self.scrx += 8;
                self.vidclocks++;
                self.oddclock = !self.oddclock;
                if (self.halfClock && !self.oddclock) continue;

                // Have we reached the end of this displayed line? (i.e. entering hblank)
                if (self.hc === self.regs[1]) {
                    if ((self.ulactrl & 2) && self.dispen) self.charsleft = 3; // Teletext mode?
                    else self.charsleft = 0;
                    self.dispen = false;
                }

                // Have we reached the horizontal sync position? (i.e. beginning of next line)
                if (self.hc === self.regs[2]) {
                    self.scrx = startX();
                    self.scry++;
                    // I'm really not sure when and if this can happen; b-em does this, anyway
                    if (self.scry >= 384) {
                        // End of the screen! (overscan?)
                        self.scry = 0;
                        paint();
                    }
                }

                if (self.dispen) {
                    renderchar();
                } else {
                    renderblank();
                }

                if (self.hvblcount) {
                    if (--self.hvblcount === 0) {
                        self.sysvia.vblankintlow();
                    }
                }

                if (self.interline && self.hc === (self.regs[0] >>> 1)) {
                    // hit end of interlaced line
                    self.hc = self.interline = 0;
                    self.scrx = startX();
                } else if (self.hc === self.regs[0]) {
                    // We've hit the end of a line (reg 0 is horiz sync char count)
                    self.endofline();
                } else {
                    self.hc = (self.hc + 1) & 0xff;
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
                if (addr & 1)
                    video.regs[curReg] = val & crtcmask[curReg];
                else
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
                    self.bakpal[index] = val & 0xf;
                    var ulaCol = val & 7;
                    if (!((val & 8) && (self.ulactrl & 1)))
                        ulaCol ^= 7;
                    if (self.ulapal[index] !== self.collook[ulaCol]) {
                        self.ulapal[index] = self.collook[ulaCol];
                        fbTableDirty = true;
                    }
                } else {
                    if ((self.ulactrl ^ val) & 1) {
                        // Flash colour has changed.
                        var flashEnabled = !!(val & 1);
                        for (var i = 0; i < 16; ++i) {
                            index = self.bakpal[i] & 7;
                            if (!(flashEnabled && (self.bakpal[i] & 8))) index ^= 7;
                            if (self.ulapal[i] !== self.collook[index]) {
                                self.ulapal[i] = self.collook[index];
                                fbTableDirty = true;
                            }
                        }
                    }
                    self.ulactrl = val;
                    self.pixelsPerChar = (val & 0x10) ? 8 : 16;
                    self.halfClock = !(val & 0x10);
                    var newMode = (val >>> 2) & 3;
                    if (newMode !== self.ulamode) {
                        self.ulamode = newMode;
                        fbTableDirty = true;
                    }
                    if (val & 2) self.crtcmode = 0;
                    else if (val & 0x10) self.crtcmode = 1;
                    else self.crtcmode = 2;
                }
            }
        };
    };
});
