// Floppy disc controller and assorted utils.
define(['./utils'], function (utils) {
    "use strict";

    var DiscTimeSlice = 16 * 16;

    function load(name) {
        console.log("Loading disc from " + name); // todo support zip files
        return utils.loadData(name);
    }

    function emptySsd(fdc) {
        var scheduler = fdc.scheduler;
        var result = {
            notFound: 0,
            seek: function () {
                return 0;
            },
            notFoundTask: scheduler.newTask(function () {
                fdc.notFound();
            })
        };
        result.read = result.write = result.address = result.format = function () {
            this.notFoundTask.reschedule(500 * DiscTimeSlice);
        };
        return result;
    }

    function discFor(fdc, name, stringData, onChange) {
        var data;
        if (typeof stringData !== "string") {
            data = stringData;
        } else {
            data = utils.stringToUint8Array(stringData);
        }
        var prevData = new Uint8Array(data);

        function changed() {
            var res = false;
            for (var i = 0; i < data.length; ++i) {
                if (data[i] !== prevData[i]) {
                    prevData[i] = data[i];
                    res = true;
                }
            }
            return res;
        }

        return new BaseDisc(fdc, name, data, function () {
            if (!changed()) return;
            if (onChange) {
                onChange(this.data);
            }
        });
    }

    function localDisc(fdc, name) {
        var discName = "disc_" + name;
        var data;
        var i;
        var dataString = localStorage[discName];
        if (!dataString) {
            console.log("Creating browser-local disc " + name);
            var nameDetails = utils.discImageSize(name);
            var byteSize = nameDetails.byteSize;
            data = new Uint8Array(byteSize);
            utils.setDiscName(data, name);
        } else {
            console.log("Loading browser-local disc " + name);
            data = utils.stringToUint8Array(dataString);
        }
        return new BaseDisc(fdc, discName, data, function () {
            var str = utils.uint8ArrayToString(this.data);
            try {
                window.localStorage.setItem(this.name, str);
            } catch (e) {
                window.alert("Writing to localStorage failed: " + e);
            }
        });
    }

    function BaseDisc(fdc, name, data, flusher) {
        if (data === null || data === undefined) throw new Error("Bad disc data");
        var nameDetails = utils.discImageSize(name);
        var isDsd = nameDetails.isDsd;
        var byteSize = nameDetails.byteSize;
        if (data.length > byteSize && !isDsd) {
            // For safety, if SSD is too big, assume it's a mis-named DSD.
            nameDetails = utils.discImageSize('.dsd');
            isDsd = true;
            byteSize = nameDetails.byteSize;
        }
        data = utils.resizeUint8Array(data, byteSize);

        this.fdc = fdc;
        this.name = name;
        this.isDsd = isDsd;
        this.flusher = flusher;
        this.data = data;
        this.byteWithinSector = 0;
        this.writeProt = !flusher;
        this.seekOffset = 0;
        this.sectorOffset = 0;
        this.formatSector = 0;
        this.rsector = 0;
        this.track = 0;
        this.side = -1;
        this.notFoundTask = fdc.scheduler.newTask(function () {
            this.fdc.notFound();
        }.bind(this));
        this.readTask = fdc.scheduler.newTask(function () {
            this.fdc.discData(this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector]);
            if (++this.byteWithinSector === 256) {
                this.fdc.discFinishRead();
            } else {
                this.readTask.reschedule(DiscTimeSlice);
            }
        }.bind(this));
        this.writeTask = fdc.scheduler.newTask(function () {
            if (this.writeProt) {
                this.fdc.writeProtect();
                return;
            }
            var c = this.fdc.readDiscData(this.byteWithinSector === 255);
            this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = c;
            if (++this.byteWithinSector === 256) {
                this.fdc.discFinishRead();
                this.flush();
            } else {
                this.writeTask.reschedule(DiscTimeSlice);
            }
        }.bind(this));
        this.readAddrTask = fdc.scheduler.newTask(function () {
            switch (this.byteWithinSector) {
                case 0:
                    this.fdc.discData(this.track);
                    break;
                case 1:
                    this.fdc.discData(this.side);
                    break;
                case 2:
                    this.fdc.discData(this.rsector);
                    break;
                case 3:
                    this.fdc.discData(1);
                    break;
                case 4:
                case 5:
                    this.fdc.discData(0);
                    break;
                case 6:
                    this.fdc.discFinishRead();
                    this.rsector++;
                    if (this.rsector === 10) this.rsector = 0;
                    return;
            }
            this.byteWithinSector++;
            this.readAddrTask.reschedule(DiscTimeSlice);
        }.bind(this));
        this.formatTask = fdc.scheduler.newTask(function () {
            if (this.writeProt) {
                this.fdc.writeProtect();
                return;
            }
            this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = 0;
            if (++this.byteWithinSector === 256) {
                this.byteWithinSector = 0;
                this.sectorOffset += 256;
                if (++this.formatSector === 10) {
                    this.fdc.discFinishRead();
                    this.flush();
                    return;
                }
            }
            this.formatTask.reschedule(DiscTimeSlice);
        }.bind(this));
        BaseDisc.prototype.flush = function () {
            if (this.flusher) this.flusher();
        };
        BaseDisc.prototype.seek = function (track) {
            this.seekOffset = track * 10 * 256;
            if (this.isDsd) this.seekOffset <<= 1;
            var oldTrack = this.track;
            this.track = track;
            return this.track - oldTrack;
        };
        BaseDisc.prototype.check = function (track, side, density) {
            if (this.track !== track || density || (side && !this.isDsd)) {
                this.notFoundTask.reschedule(500 * DiscTimeSlice);
                return false;
            }
            return true;
        };
        BaseDisc.prototype.read = function (sector, track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.readTask.reschedule(DiscTimeSlice);
            this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
            this.byteWithinSector = 0;
        };
        BaseDisc.prototype.write = function (sector, track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            // NB in old code this used to override "time" to be -1000, which immediately forced a write.
            // I'm not sure why that was required. So I'm ignoring it here. Any funny disc write bugs might be
            // traceable to this change.
            this.writeTask.reschedule(DiscTimeSlice);
            this.sectorOffset = sector * 256 + (side ? 10 * 256 : 0);
            this.byteWithinSector = 0;
        };
        BaseDisc.prototype.address = function (track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.readAddrTask.reschedule(DiscTimeSlice);
            this.byteWithinSector = 0;
            this.rsector = 0;
        };
        BaseDisc.prototype.format = function (track, side, density) {
            if (!this.check(track, side, density)) return;
            this.side = side;
            this.formatTask.reschedule(DiscTimeSlice);
            this.formatSector = 0;
            this.sectorOffset = side ? 10 * 256 : 0;
            this.byteWithinSector = 0;
        };
    }

    function I8271(cpu, noise, scheduler) {
        var self = this;
        self.status = 0;
        self.result = 0;
        self.data = 0;
        self.curDrive = 0;
        self.drvout = 0;
        self.curTrack = [0, 0];
        self.realTrack = [0, 0];
        self.sectorsLeft = 0;
        self.curSector = 0;
        self.phase = 0;
        self.command = 0xff;
        self.callbackTask = scheduler.newTask(function () {
            callback();
        });
        self.paramNum = 0;
        self.paramReq = 0;
        self.params = new Uint8Array(8);
        self.motorOn = [false, false];
        self.motorSpinDownTask = [
            scheduler.newTask(function () {
                self.motorOn[0] = false;
                self.drvout &= ~0x40;
                noise.spinDown(); // TODO multiple discs!
            }),
            scheduler.newTask(function () {
                self.motorOn[1] = false;
                self.drvout &= ~0x80;
                noise.spinDown(); // TODO multiple discs!
            })
        ];
        self.written = false;
        self.verify = false;
        self.scheduler = scheduler;
        self.drives = [emptySsd(this), emptySsd(this)];

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
            self.callbackTask.cancel();
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
            self.callbackTask.reschedule(DiscTimeSlice);
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
            if (self.command === 0x17) self.command = 0x13;
            self.curDrive = (val & 0x80) ? 1 : 0;
            if (self.command < 0x2c) {
                self.drvout &= ~(0x80 | 0x40);
                self.drvout |= (val & (0x80 | 0x40));
            }
            self.paramNum = 0;
            self.paramReq = numParams(self.command);
            self.status = 0x80;
            if (!self.paramReq) {
                if (self.command === 0x2c) {
                    // read drive status
                    self.status = 0x10;
                    self.result = 0x80;
                    self.result |= (self.realTrack[self.curDrive] ? 0 : 2);
                    self.result |= (self.drives[self.curDrive].writeProt ? 0x08 : 0);
                    if (self.drvout & 0x40) self.result |= 0x04;
                    if (self.drvout & 0x80) self.result |= 0x40;
                } else {
                    self.result = 0x18;
                    self.status = 0x18;
                    self.NMI();
                }
            }
        }

        function writeSpecial(reg, val) {
            self.status = 0;
            switch (reg) {
                case 0x17:
                    break; // apparently "mode register"
                case 0x12:
                    self.curTrack[0] = val;
                    break;
                case 0x1a:
                    self.curTrack[1] = val;
                    break;
                case 0x23:
                    self.drvout = val;
                    break;
                default:
                    self.result = self.status = 0x18;
                    self.NMI();
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
                    break;
            }
        }

        function spinup() {
            var time = DiscTimeSlice;

            if (!self.motorOn[self.curDrive]) {
                // Half a second.
                time = (0.5 * cpu.peripheralCyclesPerSecond) | 0;
                self.motorOn[self.curDrive] = true;
                noise.spinUp();
            }

            self.callbackTask.reschedule(time);
            self.motorSpinDownTask[self.curDrive].cancel();
            self.phase = 0;
        }

        function setspindown() {
            if (self.motorOn[self.curDrive]) {
                self.motorSpinDownTask[self.curDrive].reschedule(cpu.peripheralCyclesPerSecond * 2);
            }
        }

        function seek(track) {
            var realTrack = self.realTrack[self.curDrive];
            realTrack += (track - self.curTrack[self.curDrive]);
            if (realTrack < 0)
                realTrack = 0;
            if (realTrack > 79) {
                realTrack = 79;
            }
            self.realTrack[self.curDrive] = realTrack;
            var diff = self.drives[self.curDrive].seek(realTrack);
            // Let disc noises overlap by ~10%
            var seekLen = (noise.seek(diff) * 0.9 * cpu.peripheralCyclesPerSecond) | 0;
            self.callbackTask.reschedule(Math.max(DiscTimeSlice, seekLen));
            self.phase = 1;
        }

        var debugByte = 0;

        function prepareSectorIO(track, sector, numSectors) {
            if (numSectors !== undefined) self.sectorsLeft = numSectors & 31;
            if (sector !== undefined) self.curSector = sector;
            debugByte = 0;
            spinup(); // State: spinup -> seek.
        }

        function parameter(val) {
            if (self.paramNum < 5) self.params[self.paramNum++] = val;
            if (self.paramNum !== self.paramReq) return;
            switch (self.command) {
                case 0x35: // Specify.
                    self.status = 0;
                    break;
                case 0x29: // Seek
                    spinup(); // State: spinup -> seek.
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
                    writeSpecial(self.params[0], self.params[1]);
                    break;
                case 0x3d: // Special register read
                    readSpecial(self.params[0]);
                    break;
                default:
                    self.result = 0x18;
                    self.status = 0x18;
                    self.NMI();
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
            if (self.phase === 0) {
                // Spinup complete.
                seek(self.params[0]);
                return;
            }

            switch (self.command) {
                case 0x29: // Seek
                    self.curTrack[self.curDrive] = self.params[0];
                    done();
                    break;

                case 0x0b: // Write
                    if (self.phase === 1) {
                        self.curTrack[self.curDrive] = self.params[0];
                        self.phase = 2;
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
                    if (self.phase === 1) {
                        self.curTrack[self.curDrive] = self.params[0];
                        self.phase = 2;
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

                case 0x1b: // Read ID
                    if (self.phase === 1) {
                        self.curTrack[self.curDrive] = self.params[0];
                        self.phase = 2;
                        self.drives[self.curDrive].address(self.params[0], density(), 0);
                        return;
                    }
                    if (--self.sectorsLeft === 0) {
                        done();
                        return;
                    }
                    self.drives[self.curDrive].address(self.params[0], density(), 0);
                    break;

                case 0x23: // Format
                    switch (self.phase) {
                        case 1:
                            self.curTrack[self.curDrive] = self.params[0];
                            self.drives[self.curDrive].write(self.curSector, self.params[0], density(), 0);
                            update(0x8c);
                            self.phase = 2;
                            break;
                        case 2:
                            self.drives[self.curDrive].format(self.params[0], density(), 0);
                            self.phase = 3;
                            break;
                        case 3:
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
    }

    function WD1770(cpu, noise, scheduler) {
        this.cpu = cpu;
        this.noise = noise;
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
        this.motorSpinDownTask = [
            scheduler.newTask(function () {
                this.motorOn[0] = false;
                this.checkSpinDownNoise();
            }.bind(this)),
            scheduler.newTask(function () {
                this.motorOn[1] = false;
                this.checkSpinDownNoise();
            }.bind(this))
        ];
        this.scheduler = scheduler;
        this.drives = [emptySsd(this), emptySsd(this)];
        this.callbackTask = scheduler.newTask(function () {
            this.callback();
        }.bind(this));
    }

    WD1770.prototype.checkSpinDownNoise = function () {
        if (!this.motorOn[0] && !this.motorOn[1])
            this.noise.spinDown();
    };

    WD1770.prototype.spinUp = function () {
        this.status |= 0x80;
        this.motorOn[this.curDrive] = true;
        this.motorSpinDownTask[this.curDrive].cancel();
        this.noise.spinUp();
    };

    WD1770.prototype.spinDown = function () {
        this.status &= ~0x80;
        this.motorOn[this.curDrive] = false;
        this.checkSpinDownNoise();
    };

    WD1770.prototype.setSpinDown = function () {
        this.motorSpinDownTask[this.curDrive].reschedule(45000 * 128);
    };

    WD1770.prototype.track0 = function () {
        return this.curTrack === 0 ? 0x00 : 0x04;
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

    WD1770.prototype.seek = function (addr) {
        var diff = this.curDisc().seek(addr);
        var seekTime = (this.noise.seek(diff) * this.cpu.peripheralCyclesPerSecond) | 0;
        this.callbackTask.reschedule(Math.max(DiscTimeSlice, seekTime));
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
                this.callbackTask.cancel();
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
        this.callbackTask.cancel();
        this.cpu.NMI(true);
        this.status = code;
        this.spinDown();
    };

    WD1770.prototype.discFinishRead = function () {
        this.callbackTask.reschedule(DiscTimeSlice);
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
        BaseDisc: BaseDisc
    };
});
