define(['teletext_data', 'utils'], function (ttData, utils) {
    "use strict";

    function Teletext() {
        this.chars = new Uint8Array(96 * 160);
        this.charsi = new Uint8Array(96 * 160);
        this.graph = new Uint8Array(96 * 160);
        this.graphi = new Uint8Array(96 * 160);
        this.sepgraph = new Uint8Array(96 * 160);
        this.sepgraphi = new Uint8Array(96 * 160);
        this.prevCol = 0;
        this.holdClear = false;
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
        this.nextChars = [this.chars, this.charsi];
        this.curChars = [this.chars, this.charsi];
        this.heldChars = [this.chars, this.charsi];
        this.delayBuf = [0xff, 0xff];

        this.init = function () {
            var Data = ttData.makeChars();
            var i, x, x2, stat, offs1, offs2, j, y, o, p;
            // turn the 1s into 15s (?)
            for (i = 0; i < 96 * 60; ++i) {
                Data.normal[i] *= 15;
                Data.graphics[i] *= 15;
                Data.separated[i] *= 15;
            }
            // Double width for antialiasing.
            var tempi2 = new Uint8Array(96 * 120);
            for (i = 0; i < 96 * 120; ++i)
                tempi2[i] = Data.normal[i >>> 1];
            var tempi = new Uint8Array(96 * 120);

            function lerp(a, b, x) {
                return a * (1 - x) + b * x;
            }

            offs1 = offs2 = 0;
            for (i = 0; i < 960; ++i) {
                x = x2 = 0;
                for (j = 0; j < 16; ++j) {
                    o = offs2 + j;
                    if (!j) {
                        this.graph[o] = this.graphi[o] = Data.graphics[offs1];
                        this.sepgraph[o] = this.sepgraphi[o] = Data.separated[offs1];
                    } else if (j === 15) {
                        this.graph[o] = this.graphi[o] = Data.graphics[offs1 + 5];
                        this.sepgraph[o] = this.sepgraphi[o] = Data.separated[offs1 + 5];
                    } else {
                        this.graph[o] = this.graphi[o] = Data.graphics[offs1 + x2];
                        this.sepgraph[o] = this.sepgraphi[o] = Data.separated[offs1 + x2];
                    }
                    x += 5 / 15;
                    if (x >= 1) {
                        x2++;
                        x -= 1;
                    }
                    this.charsi[o] = 0;
                }
                offs1 += 6;
                offs2 += 16;
            }

            offs1 = offs2 = 0;
            for (i = 0; i < 96; ++i) {
                for (y = 0; y < 10; ++y) {
                    for (x = 0; x < 6; ++x) {
                        stat = 0;
                        if (y != 9) {
                            var basePos = offs1 + y * 6 + x;
                            var above = Data.normal[basePos];
                            var below = Data.normal[basePos + 6];
                            var left = Data.normal[basePos - 1];
                            var right = Data.normal[basePos + 1];
                            var belowLeft = Data.normal[basePos + 5];
                            var belowRight = Data.normal[basePos + 7];
                            if (above && below) stat = 3;
                            if (x > 0 && above && belowLeft && !left) stat |= 1;
                            if (x > 0 && below && left && !belowLeft) stat |= 1;
                            if (x < 5 && above && belowRight && !right) stat |= 2;
                            if (x < 6 && below && right && !belowRight) stat |= 2;
                        }
                        tempi[offs2] = (stat & 1) ? 15 : 0;
                        tempi[offs2 + 1] = (stat & 2) ? 15 : 0;
                        offs2 += 2;
                    }
                }
                offs1 += 60;
            }

            offs1 = offs2 = 0;
            for (i = 0; i < 960; ++i) {
                x = x2 = 0;
                for (j = 0; j < 16; ++j) {
                    o = offs2 + j;
                    p = offs1 + x2;
                    this.chars[o] = lerp(tempi2[p], tempi2[p + 1], x);
                    this.charsi[o] = lerp(tempi[p], tempi[p + 1], x);
                    x += 11 / 15;
                    if (x >= 1) {
                        x2++;
                        x -= 1;
                    }
                    if (i >= 320 && i < 640) {
                        this.graph[o] = this.sepgraph[o] = this.chars[o];
                        this.graphi[o] = this.sepgraphi[o] = this.charsi[o];
                    }
                }
                offs1 += 12;
                offs2 += 16;
            }

            function clamp(x) {
                x *= 255 / 15;
                if (x < 0) return 0;
                if (x > 255) return 255;
                return x | 0;
            }

            this.palette = [];
            for (i = 0; i < 64; ++i) {
                this.palette[i] = utils.makeFast32(new Uint32Array(16));
                for (var c = 0; c < 16; ++c) {
                    var r = ((i & 1) >> 0) * c + ((i & 8) >> 3) * (15 - c);
                    var g = ((i & 2) >> 1) * c + ((i & 16) >> 4) * (15 - c);
                    var b = ((i & 4) >> 2) * c + ((i & 32) >> 5) * (15 - c);
                    this.palette[i][c] = 0xff000000 | (clamp(b) << 16) | (clamp(g) << 8) | (clamp(r) << 0);
                }
            }

            function printerize(c, offset) {
                for (var i = 0; i < 10; ++i) {
                    var thing = "";
                    for (var j = 0; j < 16; ++j) {
                        if (c[offset + i * 16 + j]) {
                            thing += "*";
                        } else thing += ".";
                    }
                    console.log(i + " " + thing);
                }
            }
        };
        this.init();
    }

    Teletext.prototype.setNextChars = function () {
        if (this.gfx) {
            if (this.sep) {
                this.nextChars[0] = this.sepgraph;
                this.nextChars[1] = this.sepgraphi;
            } else {
                this.nextChars[0] = this.graph;
                this.nextChars[1] = this.graphi;
            }
        } else {
            this.nextChars[0] = this.chars;
            this.nextChars[1] = this.charsi;
        }
    };

    Teletext.prototype.handleControlCode = function (data) {
        this.holdClear = false;
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
                this.holdClear = true;
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
            this.curChars[0] = this.heldChars[0];
            this.curChars[1] = this.heldChars[1];
        } else {
            data = 0x20;
        }
        return data;
    };

    Teletext.prototype.render = function (buf, offset, scanline, interline, data) {
        var i;
        // Account for the two-character delay.
        this.delayBuf.push(data);
        data = this.delayBuf.shift();
        this.oldDbl = this.dbl;
        offset += 16;

        this.prevCol = this.col;
        this.curChars[0] = this.nextChars[0];
        this.curChars[1] = this.nextChars[1];

        if (data === 255) {
            for (i = 0; i < 16; ++i) {
                buf[offset + i] = 0xff000000;
            }
            return;
        }
        var prevFlash = this.flash;
        if (data < 0x20) {
            data = this.handleControlCode(data);
        } else if (this.gfx) {
            this.heldChar = data;
            this.heldChars[0] = this.curChars[0];
            this.heldChars[1] = this.curChars[1];
        }
        var t = (data - 0x20) * 160;
        var rounding;
        if (this.oldDbl) {
            t += (scanline >>> 1) * 16;
            if (this.secondHalfOfDouble) t += 5 * 16;
            rounding = (interline && (scanline & 1)) ? 1 : 0;
        } else {
            t += scanline * 16;
            rounding = interline ? 1 : 0;
        }

        var palette;
        if (prevFlash && this.flashOn) {
            var flashColour = this.palette[(this.bg & 7) << 3][0];
            for (i = 0; i < 16; ++i) {
                buf[offset++] = flashColour;
            }
        } else {
            if (!this.dbl && this.secondHalfOfDouble) {
                palette = this.palette[((this.bg & 7) << 3) | (this.bg & 7)];
            } else {
                palette = this.palette[((this.bg & 7) << 3) | (this.prevCol & 7)];
            }
            var px = this.curChars[rounding];
            // Unrolling seems a good thing here, at least on Chrome.
            buf[offset] = palette[px[t]];
            buf[offset + 1] = palette[px[t + 1]];
            buf[offset + 2] = palette[px[t + 2]];
            buf[offset + 3] = palette[px[t + 3]];
            buf[offset + 4] = palette[px[t + 4]];
            buf[offset + 5] = palette[px[t + 5]];
            buf[offset + 6] = palette[px[t + 6]];
            buf[offset + 7] = palette[px[t + 7]];
            buf[offset + 8] = palette[px[t + 8]];
            buf[offset + 9] = palette[px[t + 9]];
            buf[offset + 10] = palette[px[t + 10]];
            buf[offset + 11] = palette[px[t + 11]];
            buf[offset + 12] = palette[px[t + 12]];
            buf[offset + 13] = palette[px[t + 13]];
            buf[offset + 14] = palette[px[t + 14]];
            buf[offset + 15] = palette[px[t + 15]];
        }

        if (this.holdOff) {
            this.holdChar = false;
            this.heldChar = 32;
        }
        if (this.holdClear) {
            this.heldChar = 32;
        }
    };

    Teletext.prototype.verticalCharEnd = function () {
        if (this.secondHalfOfDouble)
            this.secondHalfOfDouble = false;
        else
            this.secondHalfOfDouble = this.wasDbl;
    };

    Teletext.prototype.vsync = function () {
        if (++this.flashTime === 48) this.flashTime = 0;
        this.flashOn = this.flashTime < 16;
    };

    Teletext.prototype.endline = function () {
        this.col = 7;
        this.bg = 0;
        this.holdChar = false;
        this.heldChar = 0x20;
        this.nextChars[0] = this.heldChars[0] = this.chars;
        this.nextChars[1] = this.heldChars[1] = this.charsi;
        this.flash = false;
        this.sep = false;
        this.gfx = false;

        this.dbl = this.wasDbl = false;
    };

    return Teletext;
});
