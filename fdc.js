// Floppy disc controller and assorted utils.

function ssdLoad(name, fdc) {
    "use strict";
    console.log("Loading disc from " + name);
    var request = new XMLHttpRequest();
    request.open("GET", name, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send(null);
    var len = request.response.length;
    var data = new Uint8Array(len);
    for (var i = 0; i < len; ++i) {
        data[i] = request.response.charCodeAt(i) & 0xff;
    }
    return {
        dsd: false,
        inRead: false,
        inWrite: false,
        inFormat: false,
        byteWithinSector: 0,
        writeProt: true,
        seekOffset: 0,
        sectorOffset: 0,
        time: 0,
        rsector: 0,
        track: -1,
        side: -1,
        notFound: 0,
        seek: function(track) {
            this.seekOffset = track * 10 * 256;
            if (this.dsd) this.seekOffset <<= 1;
            this.track = track;
        },
        check: function(track, side, density) {
            if (!this.track !== track || density || (side && !this.dsd)) {
                this.notFound = 500;
                return false;
            }
            return true;
        },
        read: function(sector, track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.inRead = true;
            this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
            this.byteWithinSector = 0;
        },
        write: function(track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.inWrite = true;
            this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
            this.byteWithinSector = 0;
            this.time = -1000; // TODO wtf?
        },
        address: function(track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.inReadAddr = true;
            this.byteWithinSector = 0;
            this.rsector = 0;
        },
        format: function() {
            if (!this.check(track, side, density)) return;
            //TODO
        },
        poll: function() {
            this.time++;
            if (this.time < 16) return;
            if (this.notFound && --this.notFound == 0) {
                fdc.notFound();
            }
            if (this.inRead) {
                fdc.data(data[this.seekOffset + this.sectorOffset + this.byteWithinSector]);
                if (++this.byteWithinSector == 256) {
                    this.inRead = false;
                    fdc.finishRead();
                }
            }
            if (this.inWrite) {
                if (this.writeProt) {
                    fdc.writeProtect();
                    this.inWrite = false;
                    return;
                }
                // TODO
            }
            if (this.inReadAddr) {
                switch (this.byteWithinSector) {
                case 0: fdc.data(this.track); break;
                case 1: fdc.data(this.side); break;
                case 2: fdc.data(this.rsector); break;
                case 3: fdc.data(1); break;
                case 4: case 5: fdc.data(0); break;
                case 6:
                    this.inRead = false;
                    fdc.finishRead();
                    this.rsector++;
                    if (this.rsector === 10) this.rsector = 0;
                    break;
                }
                this.byteWithinSector++;
            }
        }
    };
}

function i8271(cpu) {
    "use strict";
    var self = this;
    self.status = 0;
    self.result = 0;
    self.data = 0;
    self.drivesel = 0;
    self.curdrive = 0;
    self.curtrack = [0,0];
    self.realtrack = [0,0];
    self.command = 0xff;
    self.time = 0;
    self.paramnum = 0;
    self.paramreq = 0;
    self.params = new Uint8Array(8);
    self.written = 0;
    self.drives = [ssdLoad("discs/Welcome.ssd")];

    self.NMI = function() {
        if (self.status & 8) cpu.NMI();
    };

    self.read = function(addr) {
        switch (addr & 7) {
        case 0: // status
            return self.status;
        case 1: // result
            self.status &= ~0x18;
            self.NMI();
            return self.result;
        case 4: // data
            self.status &= ~0x0c;
            self.NMI();
            return self.data;
        }
        return 0x00;
    };

    var paramMap = {0x34: 4, 0x29: 1, 0x2c: 0, 0x3d: 1, 0x3a: 2, 0x13: 3, 0x0b: 3, 
        0x1b: 3, 0x1f: 3, 0x23: 5 };
    function numParams(command) {
        var found = paramMap[command];
        if (!found) return 0;
        return found;
    }

    function command(val) {
        if (self.status & 0x80) return;
        self.command = val & 0x3f;
        if (self.command == 0x17) self.command = 0x13;
        self.drivesel = val >>> 6;
        self.curdrive = (val & 0x80) ? 1 : 0;
        self.paramnum = 0;
        self.paramreq = numParams(command);
        self.status = 0x80;
        if (!self.paramreq) {
            if (self.command == 0x2c) {
                // read drive status
                self.status = 0x10;
                self.result = 0x88 | (self.curtrack[self.curdrive] ? 0 : 2);
                if (self.drivesel & 1) self.result |= 0x04;
                if (self.drivesel & 2) self.result |= 0x40;
            } else {
                self.result = 0x18;
                self.status = 0x18;
                self.NMI();
                self.time = 0;
            }
        }
    }

    function parameter(val) {
        if (self.paramnum < 5) self.params[self.paramnum++] = val;
        if (self.paramnum != self.paramreq) return;
        console.log(self);
        // todo: here...
    }

    function reset(val) {}
    function data(val) {
        self.data = val;
        self.written = 1;
        self.status &= ~0x0c;
        self.NMI();
    }

    self.write = function(addr, val) {
        switch (addr & 7) {
        case 0: command(val); break;
        case 1: parameter(val); break;
        case 2: reset(val); break;
        case 4: data(val); break;
        }
    }

    self.polltime = function(c) {
        if (!c) return;
        self.time -= c;
        if (self.time <= 0) {
            // CALLBACK
        }
    }
};
var fdc = i8271;
