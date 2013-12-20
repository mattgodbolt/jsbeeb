function teletext() {
    "use strict";
    var self = this;

    self.chars = new Uint8Array(96 * 160);
    self.charsi = new Uint8Array(96 * 160);
    self.graph = new Uint8Array(96 * 160);
    self.graphi = new Uint8Array(96 * 160);
    self.sepgraph = new Uint8Array(96 * 160);
    self.sepgraphi = new Uint8Array(96 * 160);

    function init() {
        var Data = teletextCharacters();
        var i, x, x2, stat, offs1, offs2, j, y;
        // turn the 1s into 15s (?)
        for (i = 0; i < 96*60; ++i) {
            Data.normal[i] *= 15;
            Data.graphics[i] *= 15;
            Data.separated[i] *= 15;
        }
        // Double width for antialiasing.
        var tempi2 = new Uint8Array(96*120);
        for (i = 0; i < 96 * 120; ++i)
            tempi2[i] = Data.normal[i>>>1];
        var tempi = new Uint8Array(96*120);

        function lerp(a, b, x) {
            return a * (1-x) + b * x;
        }

        offs1 = offs2 = 0;
        for (i = 0; i < 960; ++i) {
            x = x2 = 0;
            for (j = 0; j < 16; ++j) {
                var o = offs2 + j;
                //var p = offs1 + x2;
                //self.graph[o] = lerp(Data.graphics[p], Data.graphics[p + 1], x);
                //self.sepgraph[o] = lerp(Data.separated[p], Data.separated[p + 1], x);
                if (!j) {
                    self.graph[o] = self.graphi[o] = Data.graphics[offs1];
                    self.sepgraph[o] = self.sepgraphi[o] = Data.separated[offs1];
                } else if (j == 15) {
                    self.graph[o] = self.graphi[o] = Data.graphics[offs1 + 5];
                    self.sepgraph[o] = self.sepgraphi[o] = Data.separated[offs1 + 5];
                } else {
                    self.graph[o] = self.graphi[o] = Data.graphics[offs1 + x2];
                    self.sepgraph[o] = self.sepgraphi[o] = Data.separated[offs1 + x2];
                }
                x += 5/15;
                if (x >= 1) { x2++; x -= 1; }
                self.charsi[o] = 0;
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
                        var above = Data.normal[offs1 + y*6 + x];
                        var below = Data.normal[offs1 + y*6 + x + 6];
                        var left = Data.normal[offs1 + y*6 + x - 1];
                        var right = Data.normal[offs1 + y*6 + x + 1];
                        var belowLeft = Data.normal[offs1 + y*6 + x + 5];
                        var belowRight = Data.normal[offs1 + y*6 + x + 7];
                        if (above && below) stat = 3;
                        if (x>0 && above && belowLeft && !left) stat |= 1;
                        if (x>0 && below && left && !belowLeft) stat |= 1;
                        if (x<5 && above && belowRight && !right) stat |= 2;
                        if (x<6 && below && right && !belowRight) stat |= 2;
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
                var o = offs2 + j;
                var p = offs1 + x2;
                self.chars[o] = lerp(tempi2[p], tempi2[p + 1], x);
                self.charsi[o] = lerp(tempi[p], tempi[p + 1], x);
                x += 11/15;
                if (x >= 1) { x2++; x -= 1; }
                if (i >= 320 && i < 640) {
                    self.graph[o] = self.sepgraph[o] = self.chars[o];
                    self.graphi[o] = self.sepgraphi[o] = self.charsi[o];
                }
            }
            offs1 += 12;
            offs2 += 16;
        }

        function B(x) { x*= 255/15; if (x < 0) return 0; if (x > 255) return 255; return x|0; }
        self.palette = [];
        for (i = 0; i < 64; ++i) {
            self.palette[i] = new Uint32Array(16);
            for (var c = 0; c < 16; ++c) {
                var r = ((i&1)>>0) * c + ((i&8)>>3) * (15-c);
                var g = ((i&2)>>1) * c + ((i&16)>>4) * (15-c);
                var b = ((i&4)>>2) * c + ((i&32)>>5) * (15-c);
                self.palette[i][c] = 0xff000000 | (B(r)<<16) | (B(g)<<8) | (B(b)<<0);
            }
        }

        self.col = 7;
        self.bg = 0;
        self.sep = 0;
        self.dbl = self.nextdbl = self.wasdbl = false;
        self.gfx = 0;
        self.flash = self.flashon = self.flashtime = 0;
        self.heldchar = self.holdchar = 0;
    }

    function handleControlCode(data) {
        // TODO: control codes
    }

    function render(buf, offset, scanline, data) {
        var i;
        if (data == 255) {
            for (i = 0; i < 16; ++i) {
                buf[offset + i + 16] = 0xff000000; // todo color lookup 0
            }
            return;
        }
        if (data < 0x20) {
            handleControlCode(data);
            data = 0x20; // for now
        }
        scanline >>>=1; // why is this needed?
        var t = (data - 0x20) * 160 + scanline * 16;
        var palette;
        if (!self.dbl && self.nextdbl) {
            palette = self.palette[((self.bg & 7)<<3) | (self.bg & 7)];
        } else {
            palette = self.palette[((self.bg & 7)<<3) | (self.col & 7)];
        }
        var px = self.chars;
        // interlace?
        for (i = 0; i < 16; ++i) {
            buf[offset + i + 16] = palette[px[t]&15];
            t++;
        }
    };

    this.endline = function() {
        self.dbl = self.wasdbl = false;
    };

    this.render = render;

    init();
    //for (var j = 0; j < 10; ++j) {
    //    var t = (66 - 0x20) * 160 + j * 16;
    //    var s = "";
    //    for (var i = 0; i < 16; ++i) {
    //        s += self.chars[t].toString(16);
    //        ++t;
    //    }
    //    console.log(s);
    //}
}
