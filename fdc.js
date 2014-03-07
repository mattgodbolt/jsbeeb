// Floppy disc controller and assorted utils.

function ssdLoad(name, fdc) {
    "use strict";
    console.log("Loading disc from " + name);
    var request = new XMLHttpRequest();
    request.open("GET", name, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send(null);
    return ssdFor(fdc, request.response);
}

function ssdFor(fdc, stringData) {
    "use strict";
    var len = stringData.length;
    var data = new Uint8Array(len);
    for (var i = 0; i < len; ++i) {
        data[i] = stringData.charCodeAt(i) & 0xff;
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
            if (this.track !== track || density || (side && !this.dsd)) {
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
            this.time = 0;
            if (this.notFound && --this.notFound === 0) {
                fdc.notFound();
            }
            if (this.inRead) {
                fdc.discData(data[this.seekOffset + this.sectorOffset + this.byteWithinSector]);
                if (++this.byteWithinSector == 256) {
                    this.inRead = false;
                    fdc.discFinishRead();
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
                case 0: fdc.discData(this.track); break;
                case 1: fdc.discData(this.side); break;
                case 2: fdc.discData(this.rsector); break;
                case 3: fdc.discData(1); break;
                case 4: case 5: fdc.discData(0); break;
                case 6:
                    this.inRead = false;
                    fdc.discFinishRead();
                    this.rsector++;
                    if (this.rsector === 10) this.rsector = 0;
                    break;
                }
                this.byteWithinSector++;
            }
        }
    };
}

function I8271(cpu) {
    "use strict";
    var self = this;
    self.status = 0;
    self.result = 0;
    self.data = 0;
    self.drivesel = 0;
    self.curdrive = 0;
    self.drvout = 0;
    self.curtrack = [0,0];
    self.realtrack = [0,0];
    self.sectorsleft = 0;
    self.cursector = 0;
    self.phase = 0;
    self.command = 0xff;
    self.time = 0;
    self.paramnum = 0;
    self.paramreq = 0;
    self.params = new Uint8Array(8);
    self.written = 0;
    self.verify = 0;
    self.drives = [ssdLoad("discs/elite.ssd", this)];

    self.NMI = function() {
        cpu.NMI(self.status & 8);
    };

    self.loadDiscData = function(drive, data) {
        self.drives[drive] = ssdFor(this, data);
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

    self.discData = function(byte) {
        self.data = byte;
        self.status = 0x8c;
        self.result = 0;
        self.NMI();
        debugByte++;
    };
    self.discFinishRead = function() {
        this.time = 200;
    };

    var paramMap = {0x35: 4, 0x29: 1, 0x2c: 0, 0x3d: 1, 0x3a: 2, 0x13: 3, 0x0b: 3, 
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
        self.paramreq = numParams(self.command);
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

    function writeSpecial(reg, a, b) {
        self.status = 0; 
        switch (reg) {
        case 0x17: break; // apparently "mode register"
        case 0x12: self.curtrack[0] = b; break;
        case 0x1a: self.curtrack[1] = b; break;
        case 0x23: self.drvout = a; break;
        default:
            self.result = self.status = 0x18;
            self.NMI();
            self.time = 0;
            break;
        }
    }

    function spinup() {}
    function spindown() {}
    function setspindown() {}

    function seek(track) {
        spinup();
        var diff = track - self.curtrack[self.curdrive];
        self.realtrack[self.curdrive] += diff;
        self.drives[self.curdrive].seek(self.realtrack[self.curdrive]);
        // NB should be dependent on diff; but always non-zero
        self.time = 200; // TODO: b-em uses a round-the-houses approach to this where ddnoise actually sets time
    }
    
    var debugByte = 0;
    function read(track, sector, numSectors) {
        self.sectorsleft = numSectors & 31;
        self.cursector = sector;
        spinup();
        self.phase = false;
        seek(track);
        debugByte = 0;
    }

    function parameter(val) {
        if (self.paramnum < 5) self.params[self.paramnum++] = val;
        if (self.paramnum != self.paramreq) return;
        switch (self.command) {
        case 0x35: // Specify.
            self.status = 0; 
            break;
        case 0x29: // Seek
            seek(self.params[0]);
            break;
        case 0x13: // Read
            read(self.params[0], self.params[1], self.params[2]);
            break;
        case 0x3a: // Special
            writeSpecial(self.params[0], self.params[1], self.params[2]);
            break;
        default:
            self.result = 0x18;
            self.status = 0x18;
            self.NMI();
            self.time = 0;
            break;
        }
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
    };

    function callback() {
        self.time = 0;
        switch (self.command) {
        case 0x29: // Seek
            self.curtrack[self.curdrive] = self.params[0];
            self.status = 0x18;
            self.result = 0;
            self.NMI();
            break; 
        case 0x13: // Read
        case 0x1f: // Verify
            if (!self.phase) {
                self.curtrack[self.curdrive] = self.params[0];
                self.phase = true;
                self.drives[self.curdrive].read(self.cursector, self.params[0], (self.drvout & 0x20) ? true : false, 0);
                return;
            }
            if (--self.sectorsleft === 0) {
                self.status = 0x18;
                self.result = 0;
                self.NMI();
                setspindown();
                self.verify = 0;
                return;
            }
            self.cursector++;
            self.drives[self.curdrive].read(self.cursector, self.params[0], (self.drvout & 0x20) ? true : false, 0);
            break;
        case 0xff: break;
        default:
            console.log("ERK bad command", hexbyte(self.command));
            break;
        }
    }

    var driveTime = 0;
    self.polltime = function(c) {
        if (!c) return;
        if (self.time) {
            self.time -= c;
            if (self.time <= 0) {
                callback();
            }
        }
        driveTime -= c;
        if (driveTime <= 0) {
            driveTime += 16;
            if (self.drives[self.curdrive])
                self.drives[self.curdrive].poll();
        }
    };
}

var Fdc = I8271;
