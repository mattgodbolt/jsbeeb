// Floppy disc controller and assorted utils.
define(['./utils'], function (utils) {
    "use strict";
    function load(name) {
        console.log("Loading disc from " + name); // todo support zip files
        return utils.loadData(name);
    }

    function emptySsd(fdc) {
        var result = {
            notFound: 0,
            seek: function () {
                return 0;
            },
            poll: function () {
                if (this.notFound && --this.notFound === 0) fdc.notFound();
            }
        };

        result.read = result.write = result.address = result.format = function () {
            this.notFound = 500 * 16;
        };
        return result;
    }

    function discFor(fdc, isDsd, stringData) {
        var data;
        if (typeof(stringData) !== "string") {
            data = stringData;
        } else {
            var len = stringData.length;
            data = new Uint8Array(len);
            for (var i = 0; i < len; ++i) data[i] = stringData.charCodeAt(i) & 0xff;
        }
        return baseDisc(fdc, isDsd, data);
    }

    function localDisc(fdc, name) {
        var discName = "disc_" + name;
        var data;
        var i;
        var dataString = localStorage[discName];
        if (!dataString) {
            console.log("Creating browser-local disc " + name);
            data = new Uint8Array(100 * 1024);
            for (i = 0; i < Math.min(12, name.length); ++i)
                data[i] = name.charCodeAt(i) & 0xff;
        } else {
            console.log("Loading browser-local disc " + name);
            var len = dataString.length;
            data = new Uint8Array(len);
            for (i = 0; i < len; ++i) data[i] = dataString.charCodeAt(i) & 0xff;
        }
        return baseDisc(fdc, false, data, function () {
            var str = "";
            for (var i = 0; i < data.length; ++i) str += String.fromCharCode(data[i]);
            localStorage[discName] = str;
        });
    }

    function baseDisc(fdc, isDsd, data, flusher) {
        if (data === null || data === undefined) throw new Error("Bad disc data");
        return {
            dsd: isDsd,
            inRead: false,
            inWrite: false,
            inFormat: false,
            byteWithinSector: 0,
            writeProt: !flusher,
            seekOffset: 0,
            sectorOffset: 0,
            formatSector: 0,
            time: 0,
            rsector: 0,
            track: -1,
            side: -1,
            notFound: 0,
            flush: function () {
                if (flusher) flusher();
            },
            seek: function (track) {
                this.seekOffset = track * 10 * 256;
                if (this.dsd) this.seekOffset <<= 1;
                var oldTrack = this.track;
                this.track = track;
                return this.track - oldTrack;
            },
            check: function (track, side, density) {
                if (this.track !== track || density || (side && !this.dsd)) {
                    this.notFound = 500;
                    return false;
                }
                return true;
            },
            read: function (sector, track, side, density) {
                if (!this.check(track, side, density)) return;
                this.side = side;
                this.inRead = true;
                this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
                this.byteWithinSector = 0;
            },
            write: function (sector, track, side, density) {
                if (!this.check(track, side, density)) return;
                this.side = side;
                this.inWrite = true;
                this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
                this.byteWithinSector = 0;
                this.time = -1000; // TODO wtf?
            },
            address: function (track, side, density) {
                if (!this.check(track, side, density)) return;
                this.side = side;
                this.inReadAddr = true;
                this.byteWithinSector = 0;
                this.rsector = 0;
            },
            format: function (track, side, density) {
                if (!this.check(track, side, density)) return;
                this.side = side;
                this.inFormat = true;
                this.formatSector = 0;
                this.sectorOffset = side ? 10 * 256 : 0;
                this.byteWithinSector = 0;
            },
            poll: function () {
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
                        case 0:
                            fdc.discData(this.track);
                            break;
                        case 1:
                            fdc.discData(this.side);
                            break;
                        case 2:
                            fdc.discData(this.rsector);
                            break;
                        case 3:
                            fdc.discData(1);
                            break;
                        case 4:
                        case 5:
                            fdc.discData(0);
                            break;
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
                        if (++this.formatSector === 10) {
                            this.inFormat = false;
                            fdc.discFinishRead();
                            this.flush();
                        }
                    }
                }
            }
        };
    }

    function I8271(cpu, noise) {
        var self = this;
        self.status = 0;
        self.result = 0;
        self.data = 0;
        self.driveSel = 0;
        self.curDrive = 0;
        self.drvout = 0;
        self.curTrack = [0, 0];
        self.realTrack = [0, 0];
        self.sectorsLeft = 0;
        self.curSector = 0;
        self.phase = 0;
        self.command = 0xff;
        self.time = 0;
        self.paramNum = 0;
        self.paramReq = 0;
        self.driveTime = 0;
        self.motorTime = 0;
        self.params = new Uint8Array(8);
        self.isActive = false;
        self.motorOn = [false, false];
        self.motorSpin = [0, 0];
        self.written = false;
        self.verify = false;
        self.drives = [emptySsd(this), emptySsd(this)];
        self.readyTimer = 0;

        self.NMI = function () {
            cpu.NMI(self.status & 8);
        };

        self.loadDisc = function (drive, disc) {
            self.drives[drive] = disc;
        };

        self.read = function (addr) {
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

        self.notFound = function () {
            error(0x18);
        };
        self.writeProtect = function () {
            error(0x12);
        };
        self.headerCrcError = function () {
            error(0x0c);
        };
        self.dataCrcError = function () {
            error(0x0e);
        };

        self.discData = function (byte) {
            if (self.verify) return;
            self.data = byte;
            self.status = 0x8c;
            self.result = 0;
            self.NMI();
            debugByte++;
        };
        self.readDiscData = function (last) {
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
        self.discFinishRead = function () {
            this.time = 200;
        };

        var paramMap = {
            0x35: 4, 0x29: 1, 0x2c: 0, 0x3d: 1, 0x3a: 2, 0x13: 3, 0x0b: 3,
            0x1b: 3, 0x1f: 3, 0x23: 5
        };

        function numParams(command) {
            var found = paramMap[command];
            if (!found) return 0;
            return found;
        }

        function command(val) {
            if (self.status & 0x80) return;
            self.command = val & 0x3f;
            if (self.command == 0x17) self.command = 0x13;
            self.driveSel = val >>> 6;
            self.curDrive = (val & 0x80) ? 1 : 0;
            self.paramNum = 0;
            self.paramReq = numParams(self.command);
            self.status = 0x80;
            if (!self.paramReq) {
                if (self.command === 0x2c) {
                    // read drive status
                    self.status = 0x10;
                    self.result = 0x88 | (self.curTrack[self.curDrive] ? 0 : 2);
                    if (self.readyTimer === 0) {
                        if (self.driveSel & 1) self.result |= 0x04;
                        if (self.driveSel & 2) self.result |= 0x40;
                    } else if (self.readyTimer === 1) self.readyTimer = 0; // Ready for next time
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
                case 0x17:
                    break; // apparently "mode register"
                case 0x12:
                    self.curTrack[0] = b;
                    break;
                case 0x1a:
                    self.curTrack[1] = b;
                    break;
                case 0x23:
                    self.drvout = a;
                    break;
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
                case 0x06:
                    break;
                case 0x12:
                    self.result = self.curTrack[0];
                    break;
                case 0x1a:
                    self.result = self.curTrack[1];
                    break;
                case 0x23:
                    self.result = self.drvout;
                    break;
                default:
                    self.result = self.status = 0x18;
                    self.NMI();
                    self.time = 0;
                    break;
            }
        }

        function spinup() {
            // TODO: not sure where this should go, or for how long. This is a workaround for EliteA
            if (!self.motorOn[self.curDrive]) {
                self.readyTimer = (0.5 * cpu.peripheralCyclesPerSecond) | 0; // Apparently takes a half second to spin up
            } else {
                self.readyTimer = 1000;  // little bit of time for each command (so, really, spinup is a bad place to put this)
            }
            self.isActive = true;
            self.motorOn[self.curDrive] = true;
            self.motorSpin[self.curDrive] = 0;
            noise.spinUp();
        }

        function setspindown() {
            if (self.motorOn[self.curDrive])
                self.motorSpin[self.curDrive] = 40000;
        }

        function seek(track) {
            spinup();
            self.realTrack[self.curDrive] += track - self.curTrack[self.curDrive];
            var diff = self.drives[self.curDrive].seek(self.realTrack[self.curDrive]);
            var seekLen = (noise.seek(diff) * cpu.peripheralCyclesPerSecond) | 0;
            self.time = Math.max(200, seekLen);
        }

        var debugByte = 0;

        function prepareSectorIO(track, sector, numSectors) {
            if (numSectors !== undefined) self.sectorsLeft = numSectors & 31;
            if (sector !== undefined) self.curSector = sector;
            spinup();
            self.phase = 0;
            seek(track);
            debugByte = 0;
        }

        function parameter(val) {
            if (self.paramNum < 5) self.params[self.paramNum++] = val;
            if (self.paramNum != self.paramReq) return;
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

        function reset(val) {
        }

        function data(val) {
            self.data = val;
            self.written = true;
            self.status &= ~0x0c;
            self.NMI();
        }

        self.write = function (addr, val) {
            switch (addr & 7) {
                case 0:
                    command(val);
                    break;
                case 1:
                    parameter(val);
                    break;
                case 2:
                    reset(val);
                    break;
                case 4:
                    data(val);
                    break;
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
                    self.curTrack[self.curDrive] = self.params[0];
                    update(0x18);
                    break;

                case 0x0b: // Write
                    if (!self.phase) {
                        self.curTrack[self.curDrive] = self.params[0];
                        self.phase = 1;
                        self.drives[self.curDrive].write(self.curSector, self.params[0], density(), 0);
                        update(0x8c);
                        return;
                    }
                    if (--self.sectorsLeft === 0) {
                        done();
                        return;
                    }
                    self.curSector++;
                    self.drives[self.curDrive].write(self.curSector, self.params[0], density(), 0);
                    update(0x8c);
                    self.debugByte = 0;
                    break;

                case 0x13: // Read
                case 0x1f: // Verify
                    if (!self.phase) {
                        self.curTrack[self.curDrive] = self.params[0];
                        self.phase = 1;
                        self.drives[self.curDrive].read(self.curSector, self.params[0], density(), 0);
                        return;
                    }
                    if (--self.sectorsLeft === 0) {
                        done();
                        return;
                    }
                    self.curSector++;
                    self.drives[self.curDrive].read(self.curSector, self.params[0], density(), 0);
                    break;

                case 0x23: // Format
                    switch (self.phase) {
                        case 0:
                            self.curTrack[self.curDrive] = self.params[0];
                            self.drives[self.curDrive].write(self.curSector, self.params[0], density(), 0);
                            update(0x8c);
                            self.phase = 1;
                            break;
                        case 1:
                            self.drives[self.curDrive].format(self.params[0], density(), 0);
                            self.phase = 2;
                            break;
                        case 2:
                            done();
                            break;
                    }
                    break;

                case 0xff:
                    break;
                default:
                    console.log("ERK bad command", utils.hexbyte(self.command));
                    break;
            }
        }

        self.polltime = function (cycles) {
            cycles = cycles | 0;
            if (!self.isActive) return;
            if (self.time) {
                self.time -= cycles;
                if (self.time <= 0) {
                    callback();
                }
            }
            self.driveTime -= cycles;
            if (self.driveTime <= 0) {
                self.driveTime += 16;
                if (self.drives[self.curDrive])
                    self.drives[self.curDrive].poll();
            }
            self.motorTime -= cycles;
            if (self.motorTime <= 0) {
                self.motorTime += 128;
                for (var i = 0; i < 2; ++i) {
                    if (self.motorSpin[i] && --self.motorSpin[i] === 0) {
                        self.motorOn[i] = false;
                        noise.spinDown(); // TODO multiple discs!
                    }
                }
                self.isActive = self.motorOn[0] || self.motorOn[1];
            }
            if (this.readyTimer > 1) {
                this.readyTimer -= cycles;
                if (this.readyTimer < 1) this.readyTimer = 1;
            }
        };
    }

    function WD1770(cpu, noise) {
        this.cpu = cpu;
        this.noise = noise;
        this.isActive = false;
        this.command = 0;
        this.sector = 0;
        this.track = 0;
        this.status = 0;
        this.data = 0;
        this.side = 0;
        this.curDrive = 0;
        this.curTrack = 0;
        this.written = false;
        this.density = false;
        this.stepIn = false;
        this.motorOn = [false, false];
        this.motorSpin = [0, 0];
        this.motorTime = 0;
        this.driveTime = 0;
        this.time = 0;
        this.drives = [emptySsd(this), emptySsd(this)];
    }

    WD1770.prototype.spinUp = function () {
        this.isActive = true;
        this.status |= 0x80;
        this.motorOn[this.curDrive] = true;
        this.motorSpin[this.curDrive] = 0;
        this.noise.spinUp();
    };

    WD1770.prototype.spinDown = function () {
        this.isActive = 0;
        this.status &= ~0x80;
        this.motorOn[this.curDrive] = false;
        this.noise.spinDown();
    };

    WD1770.prototype.setSpinDown = function () {
        this.motorSpin[this.curDrive] = 45000;
    };

    WD1770.prototype.track0 = function () {
        return this.curTrack === 0 ? 0x04 : 0x00;
    };

    WD1770.prototype.callback = function () {
        switch (this.command >>> 4) {
            case 0: // Restore
                this.track = this.curTrack = 0;
                this.status = 0x80;
                this.setSpinDown();
                this.cpu.NMI(true);
                break;
            case 1: // Seek
                this.curTrack = this.track = this.data;
                this.status = 0x80 | this.track0();
                this.cpu.NMI(true);
                break;
            case 3: // Step (with update)
            case 5: // Step in (with update)
            case 7: // Step out (with update)
                this.track = this.curTrack;
            /* falls through */
            case 2: // Step
            case 4: // Step in
            case 6: // Step out
                this.status = 0x80 | this.track0();
                this.cpu.NMI(true);
                break;
            case 8: // Read sector
            case 10: // Write sector
            case 15: // Write track
                this.status = 0x80;
                this.setSpinDown();
                this.cpu.NMI(true);
                break;
            case 12: // Read address
                this.status = 0x80;
                this.setSpinDown();
                this.cpu.NMI(true);
                this.sector = this.track;
                break;
        }
    };

    WD1770.prototype.polltime = function (cycles) {
        cycles = cycles | 0;
        if (!this.isActive) return;
        if (this.time) {
            this.time -= cycles;
            if (this.time <= 0) {
                this.time = 0;
                this.callback();
            }
        }
        this.driveTime -= cycles;
        if (this.driveTime <= 0) {
            this.driveTime += 16;
            if (this.drives[this.curDrive])
                this.drives[this.curDrive].poll();
        }
        this.motorTime -= cycles;
        if (this.motorTime <= 0) {
            this.motorTime += 128;
            for (var i = 0; i < 2; ++i) {
                if (this.motorSpin[i] && --this.motorSpin[i] === 0)
                    this.motorOn[i] = false;
            }
            this.isActive = this.motorOn[0] || this.motorOn[1];
            if (!this.isActive) this.noise.spinDown();
        }
    };

    WD1770.prototype.read = function (addr) {
        // b-em clears NMIs, but that happens after each instruction anyway, so
        // I'm not quite sure what that's all about.
        switch (addr) {
            case 0xfe84:
            case 0xfe28:
                return this.status;
            case 0xfe85:
            case 0xfe29:
                return this.track;
            case 0xfe86:
            case 0xfe2a:
                return this.sector;
            case 0xfe87:
            case 0xfe2b:
                this.status &= ~0x02;
                return this.data;
        }
        return 0xfe;
    };

    WD1770.prototype.write = function (addr, byte) {
        switch (addr) {
            case 0xfe80:
                this.curDrive = (byte & 2) ? 1 : 0;
                this.side = (byte & 4) ? 1 : 0;
                this.density = !(byte & 8);
                break;
            case 0xfe24:
                this.curDrive = (byte & 2) ? 1 : 0;
                this.side = (byte & 16) ? 1 : 0;
                this.density = !(byte & 32);
                break;
            case 0xfe84:
            case 0xfe28:
                var command = (byte >>> 4) & 0xf;
                var isInterrupt = command === 0x0d;
                if ((this.status & 1) && !isInterrupt) {
                    // Attempt to write while controller is busy.
                    return;
                }
                this.command = byte;
                if (!isInterrupt) this.spinUp();
                this.handleCommand(command);
                break;
            case 0xfe85:
            case 0xfe29:
                this.track = byte;
                break;
            case 0xfe86:
            case 0xfe2a:
                this.sector = byte;
                break;
            case 0xfe87:
            case 0xfe2b:
                this.status &= ~0x02;
                this.data = byte;
                this.written = true;
                break;
        }
    };

    WD1770.prototype.curDisc = function () {
        return this.drives[this.curDrive];
    };

    WD1770.prototype.seek = function(addr) {
        var diff = this.curDisc().seek(addr);
        var seekTime = (this.noise.seek(diff) * this.cpu.peripheralCyclesPerSecond)|0;
        this.time = Math.max(200, seekTime);
    };

    WD1770.prototype.handleCommand = function (command) {
        switch (command) {
            case 0x0: // Restore
                this.status = 0x80 | 0x21 | this.track0();
                this.seek(0);
                break;
            case 0x01: // Seek
                this.status = 0x80 | 0x21 | this.track0();
                this.seek(this.data);
                break;
            case 0x02: // Step (no update)
            case 0x03: // Step (update track register)
                this.status = 0x80 | 0x21 | this.track0();
                this.curTrack += this.stepIn ? 1 : -1;
                if (this.curTrack < 0) this.curTrack = 0;
                this.seek(this.curTrack);
                break;
            case 0x04: // Step in (no update)
            case 0x05: // Step in (update track register)
                this.status = 0x80 | 0x21 | this.track0();
                this.curTrack++;
                this.seek(this.curTrack);
                this.stepIn = true;
                break;
            case 0x06: // Step out (no update)
            case 0x07: // Step out (update track register)
                this.status = 0x80 | 0x21 | this.track0();
                this.curTrack--;
                if (this.curTrack < 0) this.curTrack = 0;
                this.seek(this.curTrack);
                this.stepIn = false;
                break;
            case 0x08: // Read single sector
                this.status = 0x81;
                this.curDisc().read(this.sector, this.track, this.side, this.density);
                break;
            case 0x0a: // Write single sector
                this.status = 0x83;
                this.curDisc().write(this.sector, this.track, this.side, this.density);
                this.written = false;
                this.cpu.NMI(true);
                break;
            case 0x0c: // Read address
                this.status = 0x81;
                this.curDisc().address(this.track, this.side, this.density);
                break;
            case 0x0d: // Force IRQ
                this.status = 0x80 | this.track0();
                this.cpu.NMI(this.command & 0x08);
                this.spinDown();
                break;
            case 0x0f: // Write track
                this.status = 0x81;
                this.curDisc().format(this.track, this.side, this.density);
                break;
            default: // Unsupported
                this.time = 0;
                this.status = 0x90;
                this.cpu.NMI(true);
                this.spinDown();
                break;
        }
    };

    WD1770.prototype.discData = function (byte) {
        this.status |= 0x02;
        this.data = byte;
        this.cpu.NMI(true);
    };

    WD1770.prototype.readDiscData = function (last) {
        if (!this.written) return 0xff;
        this.written = false;
        if (!last) {
            this.cpu.NMI(true);
            this.status |= 0x02;
        }
        return this.data;
    };

    WD1770.prototype.error = function (code) {
        this.time = 0;
        this.cpu.NMI(true);
        this.status = code;
        this.spinDown();
    };

    WD1770.prototype.discFinishRead = function () {
//        console.log("finish read");
        this.time = 200;
    };

    WD1770.prototype.notFound = function () {
        this.error(0x90);
    };
    WD1770.prototype.writeProtect = function () {
        this.error(0xc0);
    };
    WD1770.prototype.headerCrcError = function () {
        this.error(0x98);
    };
    WD1770.prototype.dataCrcError = function () {
        this.error(0x88);
    };

    WD1770.prototype.loadDisc = function (drive, disc) {
        this.drives[drive] = disc;
    };

    return {
        I8271: I8271,
        WD1770: WD1770,
        load: load,
        localDisc: localDisc,
        emptySsd: emptySsd,
        discFor: discFor,
        baseDisc: baseDisc
    };
});
