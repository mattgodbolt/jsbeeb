// Floppy disc controller and assorted utils.

function ssdLoad(name) {
    "use strict";
    console.log("Loading disc from " + name);
    return loadData(name);
}

function emptySsd(fdc) {
    "use strict";
    var result = {
        notFound: 0,
        seek: function() {},
        poll: function() {
            if (this.notFound && --this.notFound === 0) fdc.notFound();
        }
    };

    result.read = result.write = result.address = result.format = function() {
        this.notFound = 500 * 16;
    };
    return result;
}

function ssdFor(fdc, stringData) {
    "use strict";
    var data;
    if (typeof(stringData) != "string") {
        data = stringData;
    } else {
        var len = stringData.length;
        data = new Uint8Array(len);
        for (var i = 0; i < len; ++i) data[i] = stringData.charCodeAt(i) & 0xff;
    }
    return baseSsd(fdc, data);
}

function localDisc(fdc, name) {
    "use strict";
    var discName = "disc_" + name;
    var data;
    var i;
    var dataString = localStorage[discName];
    if (!dataString) {
        console.log("Creating browser-local disc " + name);
        data = new Uint8Array(100 * 1024);
        for (i = 0; i < Math.max(12, name.length); ++i)
            data[i] = name.charCodeAt(i) & 0xff;
    } else {
        console.log("Loading browser-local disc " + name);
        var len = dataString.length;
        data = new Uint8Array(len);
        for (i = 0; i < len; ++i) data[i] = dataString.charCodeAt(i) & 0xff;
    }
    return baseSsd(fdc, data, function() {
        var str = "";
        for (var i = 0; i < data.length; ++i) str += String.fromCharCode(data[i]);
        localStorage[discName] = str;
    });
} 

function baseSsd(fdc, data, flusher) {
    "use strict";
    return {
        dsd: false,
        inRead: false,
        inWrite: false,
        inFormat: false,
        byteWithinSector: 0,
        writeProt: !flusher,
        seekOffset: 0,
        sectorOffset: 0,
        time: 0,
        rsector: 0,
        track: -1,
        side: -1,
        notFound: 0,
        flush: function() {
            flusher();
        },
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
        write: function(sector, track, side, density) {
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
        format: function(track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.inFormat = true;
            this.sector = 0;
            this.sectorOffset = side ? 10 * 256 : 0;
            this.byteWithinSector = 0;
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
                var c = fdc.readDiscData(this.byteWithinSector == 255);
                data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = c;
                if (++this.byteWithinSector == 256) {
                    this.inWrite = false;
                    fdc.discFinishRead();
                    this.flush();
                }
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
            if (this.inFormat) {
                if (this.writeProt) {
                    fdc.writeProtect();
                    this.inFormat = false;
                    return;
                }
                data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = 0;
                if (++this.byteWithinSector == 256) {
                    this.byteWithinSector = 0;
                    this.sectorOffset += 256;
                    if (++this.sector === 10) {
                        this.inFormat = false;
                        fdc.discFinishRead();
                        this.flush();
                    }
                }
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
    self.motoron = [false, false];
    self.motorspin = [0, 0];
    self.written = false;
    self.verify = false;
    self.drives = [emptySsd(this), emptySsd(this)];

    self.NMI = function() {
        cpu.NMI(self.status & 8);
    };

    self.loadDiscData = function(drive, data) {
        self.drives[drive] = ssdFor(this, data);
    };
    self.loadDisc = function(drive, disc) {
        self.drives[drive] = disc;
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

    function error(result) {
        self.result = result;
        self.status = 0x18;
        self.NMI();
        self.time = 0;
        setspindown();
    }

    self.notFound = function() { error(0x18); };
    self.writeProtect = function() { error(0x12); };
    self.headerCrcError = function() { error(0x0c); };
    self.dataCrcError = function() { error(0x0e); };

    self.discData = function(byte) {
        if (self.verify) return;
        self.data = byte;
        self.status = 0x8c;
        self.result = 0;
        self.NMI();
        debugByte++;
    };
    self.readDiscData = function(last) {
        debugByte++;
        if (!self.written) return 0x00;
        if (!last) {
            self.status = 0x8c;
            self.result = 0;
            self.NMI();
        }
        self.written = false;
        return self.data;
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

    function readSpecial(reg) {
        self.status = 0x10; 
        self.result = 0;
        switch (reg) {
        case 0x06: break;
        case 0x12: self.result = self.curtrack[0]; break;
        case 0x1a: self.result = self.curtrack[1]; break;
        case 0x23: self.result = self.drvout; break;
        default:
            self.result = self.status = 0x18;
            self.NMI();
            self.time = 0;
            break;
        }
    }

    function spinup() {
        self.motoron[self.curdrive] = true;
        self.motorspin[self.curdrive] = 0;
    }
    function setspindown() {
        if (self.motoron[self.curdrive])
            self.motorspin[self.curdrive] = 40000;
    }

    function seek(track) {
        spinup();
        var diff = track - self.curtrack[self.curdrive];
        self.realtrack[self.curdrive] += diff;
        self.drives[self.curdrive].seek(self.realtrack[self.curdrive]);
        // NB should be dependent on diff; but always non-zero
        self.time = 200; // TODO: b-em uses a round-the-houses approach to this where ddnoise actually sets time
    }
    
    var debugByte = 0;
    function prepareSectorIO(track, sector, numSectors) {
        if (numSectors !== undefined) self.sectorsleft = numSectors & 31;
        if (sector !== undefined) self.cursector = sector;
        spinup();
        self.phase = 0;
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
        case 0x1f: // Verify
        case 0x13: // Read
        case 0x0b: // Write
            prepareSectorIO(self.params[0], self.params[1], self.params[2]);
            break;
        case 0x1b: // Read ID
            prepareSectorIO(self.params[0], undefined, self.params[2]);
            break;
        case 0x23: // Format
            prepareSectorIO(self.params[0]);
            break;
        case 0x3a: // Special register write
            writeSpecial(self.params[0], self.params[1], self.params[2]);
            break;
        case 0x3d: // Special register read
            readSpecial(self.params[0]);
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
        self.written = true;
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

    function density() {
        return !!(self.drvout & 0x20);
    }

    function update(status) {
        self.status = status;
        self.result = 0;
        self.NMI();
    }

    function done() {
        update(0x18);
        setspindown();
        self.verify = false;
    }

    function callback() {
        self.time = 0;
        switch (self.command) {
        case 0x29: // Seek
            self.curtrack[self.curdrive] = self.params[0];
            update(0x18);
            break; 

        case 0x0b: // Write
            if (!self.phase) {
                self.curtrack[self.curdrive] = self.params[0];
                self.phase = 1;
                self.drives[self.curdrive].write(self.cursector, self.params[0], density(), 0);
                update(0x8c);
                return;
            }
            if (--self.sectorsleft === 0) {
                done();
                return;
            }
            self.cursector++;
            self.drives[self.curdrive].write(self.cursector, self.params[0], density(), 0);
            update(0x8c);
            self.debugByte = 0;
            break;

        case 0x13: // Read
        case 0x1f: // Verify
            if (!self.phase) {
                self.curtrack[self.curdrive] = self.params[0];
                self.phase = 1;
                self.drives[self.curdrive].read(self.cursector, self.params[0], density(), 0);
                return;
            }
            if (--self.sectorsleft === 0) {
                done();
                return;
            }
            self.cursector++;
            self.drives[self.curdrive].read(self.cursector, self.params[0], density(), 0);
            break;

        case 0x23: // Format
            switch (self.phase) {
            case 0:
                self.curtrack[self.curdrive] = self.params[0];
                self.drives[self.curdrive].write(self.cursector, self.params[0], density(), 0);
                update(0x8c);
                self.phase = 1;
                break;
            case 1:
                self.drives[self.curdrive].format(self.params[0], density(), 0);
                self.phase = 2;
                break;
            case 2:
                done();
                break;
            }
            break;

        case 0xff: break;
        default:
            console.log("ERK bad command", hexbyte(self.command));
            break;
        }
    }

    var driveTime = 0;
    var motorTime = 0;
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
        motorTime -= c;
        if (motorTime <= 0) {
            motorTime += 128;
            for (var i = 0; i < 2; ++i) {
                if (self.motorspin[i] && --self.motorspin[i] === 0)
                    self.motoron[i] = false;
            }
        }
    };
}

var Fdc = I8271;
