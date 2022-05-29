// Floppy disc controller and assorted utils.
import * as utils from "./utils.js";

const DiscTimeSlice = 16 * 16;

export function load(name) {
    console.log("Loading disc from " + name); // todo support zip files
    return utils.loadData(name);
}

export function emptySsd(fdc) {
    const scheduler = fdc.scheduler;
    const result = {
        notFound: 0,
        seek: function () {
            return 0;
        },
        notFoundTask: scheduler.newTask(() => {
            fdc.notFound();
        }),
    };
    result.read =
        result.write =
        result.address =
        result.format =
            () => {
                this.notFoundTask.reschedule(500 * DiscTimeSlice);
            };
    return result;
}

export function discFor(fdc, name, stringData, onChange) {
    const data = typeof stringData !== "string" ? stringData : utils.stringToUint8Array(stringData);
    const prevData = new Uint8Array(data);

    function changed() {
        let res = false;
        for (let i = 0; i < data.length; ++i) {
            if (data[i] !== prevData[i]) {
                prevData[i] = data[i];
                res = true;
            }
        }
        return res;
    }

    return new BaseDisc(fdc, name, data, () => {
        if (!changed()) return;
        if (onChange) {
            onChange(this.data);
        }
    });
}

export function localDisc(fdc, name) {
    const discName = "disc_" + name;
    let data;
    const dataString = localStorage[discName];
    if (!dataString) {
        console.log("Creating browser-local disc " + name);
        data = new Uint8Array(utils.discImageSize(name).byteSize);
        utils.setDiscName(data, name);
    } else {
        console.log("Loading browser-local disc " + name);
        data = utils.stringToUint8Array(dataString);
    }
    return new BaseDisc(fdc, discName, data, () => {
        const str = utils.uint8ArrayToString(this.data);
        try {
            window.localStorage.setItem(this.name, str);
        } catch (e) {
            window.alert("Writing to localStorage failed: " + e);
        }
    });
}

export function BaseDisc(fdc, name, data, flusher) {
    if (data === null || data === undefined) throw new Error("Bad disc data");
    let nameDetails = utils.discImageSize(name);
    let isDsd = nameDetails.isDsd;
    let sectorsPerTrack = nameDetails.isDoubleDensity ? 16 : 10;
    let byteSize = nameDetails.byteSize;
    if (data.length > byteSize && !isDsd) {
        // For safety, if SSD is too big, assume it's a mis-named DSD.
        nameDetails = utils.discImageSize(".dsd");
        isDsd = true;
        byteSize = nameDetails.byteSize;
    }
    data = utils.resizeUint8Array(data, byteSize);

    this.fdc = fdc;
    this.name = name;
    this.isDsd = isDsd;
    this.sectorsPerTrack = sectorsPerTrack;
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

    this.notFoundTask = fdc.scheduler.newTask(() => this.fdc.notFound());
    this.readTask = fdc.scheduler.newTask(() => {
        this.fdc.discData(this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector]);
        if (++this.byteWithinSector === 256) {
            this.fdc.discFinishRead();
        } else {
            this.readTask.reschedule(DiscTimeSlice);
        }
    });
    this.writeTask = fdc.scheduler.newTask(() => {
        if (this.writeProt) {
            this.fdc.writeProtect();
            return;
        }
        this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = this.fdc.readDiscData(
            this.byteWithinSector === 255
        );
        if (++this.byteWithinSector === 256) {
            this.fdc.discFinishRead();
            this.flush();
        } else {
            this.writeTask.reschedule(DiscTimeSlice);
        }
    });
    this.readAddrTask = fdc.scheduler.newTask(() => {
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
                if (this.rsector === this.sectorsPerTrack) this.rsector = 0;
                return;
        }
        this.byteWithinSector++;
        this.readAddrTask.reschedule(DiscTimeSlice);
    });
    this.formatTask = fdc.scheduler.newTask(() => {
        if (this.writeProt) {
            this.fdc.writeProtect();
            return;
        }
        this.data[this.seekOffset + this.sectorOffset + this.byteWithinSector] = 0;
        if (++this.byteWithinSector === 256) {
            this.byteWithinSector = 0;
            this.sectorOffset += 256;
            if (++this.formatSector === this.sectorsPerTrack) {
                this.fdc.discFinishRead();
                this.flush();
                return;
            }
        }
        this.formatTask.reschedule(DiscTimeSlice);
    });

    BaseDisc.prototype.flush = () => {
        if (this.flusher) this.flusher();
    };
    BaseDisc.prototype.seek = (track) => {
        this.seekOffset = track * this.sectorsPerTrack * 256;
        if (this.isDsd) this.seekOffset <<= 1;
        const oldTrack = this.track;
        this.track = track;
        return this.track - oldTrack;
    };
    BaseDisc.prototype.check = (track, side) => {
        if (this.track !== track || (side && !this.isDsd)) {
            this.notFoundTask.reschedule(500 * DiscTimeSlice);
            return false;
        }
        return true;
    };
    BaseDisc.prototype.read = (sector, track, side) => {
        if (!this.check(track, side)) return;
        this.side = side;
        this.readTask.reschedule(DiscTimeSlice);
        this.sectorOffset = sector * 256 + (side ? this.sectorsPerTrack * 256 : 0);
        this.byteWithinSector = 0;
    };
    BaseDisc.prototype.write = (sector, track, side) => {
        if (!this.check(track, side)) return;
        this.side = side;
        // NB in old code this used to override "time" to be -1000, which immediately forced a write.
        // I'm not sure why that was required. So I'm ignoring it here. Any funny disc write bugs might be
        // traceable to this change.
        this.writeTask.reschedule(DiscTimeSlice);
        this.sectorOffset = sector * 256 + (side ? this.sectorsPerTrack * 256 : 0);
        this.byteWithinSector = 0;
    };
    BaseDisc.prototype.address = (track, side) => {
        if (!this.check(track, side)) return;
        this.side = side;
        this.readAddrTask.reschedule(DiscTimeSlice);
        this.byteWithinSector = 0;
        this.rsector = 0;
    };
    BaseDisc.prototype.format = (track, side) => {
        if (!this.check(track, side)) return;
        this.side = side;
        this.formatTask.reschedule(DiscTimeSlice);
        this.formatSector = 0;
        this.sectorOffset = side ? this.sectorsPerTrack * 256 : 0;
        this.byteWithinSector = 0;
    };
}

export class I8271 {
    constructor(cpu, noise, scheduler) {
        this.cpu = cpu;
        this.noise = noise;
        this.status = 0;
        this.result = 0;
        this.curData = 0;
        this.curDrive = 0;
        this.drvout = 0;
        this.curTrack = [0, 0];
        this.realTrack = [0, 0];
        this.sectorsLeft = 0;
        this.curSector = 0;
        this.phase = 0;
        this.curCommand = 0xff;
        this.callbackTask = scheduler.newTask(() => {
            this.callback();
        });
        this.paramNum = 0;
        this.paramReq = 0;
        this.params = new Uint8Array(8);
        this.motorOn = [false, false];
        this.motorSpinDownTask = [
            scheduler.newTask(() => {
                this.motorOn[0] = false;
                this.drvout &= ~0x40;
                noise.spinDown(); // TODO multiple discs!
            }),
            scheduler.newTask(() => {
                this.motorOn[1] = false;
                this.drvout &= ~0x80;
                noise.spinDown(); // TODO multiple discs!
            }),
        ];
        this.written = false;
        this.verify = false;
        this.scheduler = scheduler;
        this.drives = [emptySsd(this), emptySsd(this)];
    }

    NMI() {
        this.cpu.NMI(this.status & 8);
    }

    loadDisc(drive, disc) {
        this.drives[drive] = disc;
    }

    read(addr) {
        switch (addr & 7) {
            case 0: // status
                return this.status;
            case 1: // result
                this.status &= ~0x18;
                this.NMI();
                return this.result;
            case 4: // data
            case 5:
            case 6:
            case 7:
                this.status &= ~0x0c;
                this.NMI();
                return this.curData;
        }
        return 0x00;
    }

    error(result) {
        this.result = result;
        this.status = 0x18;
        this.NMI();
        this.callbackTask.cancel();
        this.setspindown();
    }

    notFound() {
        this.error(0x18);
    }

    writeProtect() {
        this.error(0x12);
    }

    headerCrcError() {
        this.error(0x0c);
    }

    dataCrcError() {
        this.error(0x0e);
    }

    discData(byte) {
        if (this.verify) return;
        this.curData = byte;
        this.status = 0x8c;
        this.result = 0;
        this.NMI();
    }

    readDiscData(last) {
        if (!this.written) return 0x00;
        if (!last) {
            this.status = 0x8c;
            this.result = 0;
            this.NMI();
        }
        this.written = false;
        return this.curData;
    }

    discFinishRead() {
        this.callbackTask.reschedule(DiscTimeSlice);
    }

    numParams(command) {
        const paramMap = {
            0x35: 4,
            0x29: 1,
            0x2c: 0,
            0x3d: 1,
            0x3a: 2,
            0x13: 3,
            0x0b: 3,
            0x1b: 3,
            0x1f: 3,
            0x23: 5,
        };
        const found = paramMap[command];
        if (!found) return 0;
        return found;
    }

    command(val) {
        if (this.status & 0x80) return;
        this.curCommand = val & 0x3f;
        if (this.curCommand === 0x17) this.curCommand = 0x13;
        this.curDrive = val & 0x80 ? 1 : 0;
        if (this.curCommand < 0x2c) {
            this.drvout &= ~(0x80 | 0x40);
            this.drvout |= val & (0x80 | 0x40);
        }
        this.paramNum = 0;
        this.paramReq = this.numParams(this.curCommand);
        this.status = 0x80;
        if (!this.paramReq) {
            if (this.curCommand === 0x2c) {
                // read drive status
                this.status = 0x10;
                this.result = 0x80;
                this.result |= this.realTrack[this.curDrive] ? 0 : 2;
                this.result |= this.drives[this.curDrive].writeProt ? 0x08 : 0;
                if (this.drvout & 0x40) this.result |= 0x04;
                if (this.drvout & 0x80) this.result |= 0x40;
            } else {
                this.result = 0x18;
                this.status = 0x18;
                this.NMI();
            }
        }
    }

    writeSpecial(reg, val) {
        this.status = 0;
        switch (reg) {
            case 0x17:
                break; // apparently "mode register"
            case 0x12:
                this.curTrack[0] = val;
                break;
            case 0x1a:
                this.curTrack[1] = val;
                break;
            case 0x23:
                this.drvout = val;
                break;
            default:
                this.result = this.status = 0x18;
                this.NMI();
                break;
        }
    }

    readSpecial(reg) {
        this.status = 0x10;
        this.result = 0;
        switch (reg) {
            case 0x06:
                break;
            case 0x12:
                this.result = this.curTrack[0];
                break;
            case 0x1a:
                this.result = this.curTrack[1];
                break;
            case 0x23:
                this.result = this.drvout;
                break;
            default:
                this.result = this.status = 0x18;
                this.NMI();
                break;
        }
    }

    spinup() {
        let time = DiscTimeSlice;

        if (!this.motorOn[this.curDrive]) {
            // Half a second.
            time = (0.5 * this.cpu.peripheralCyclesPerSecond) | 0;
            this.motorOn[this.curDrive] = true;
            this.noise.spinUp();
        }

        this.callbackTask.reschedule(time);
        this.motorSpinDownTask[this.curDrive].cancel();
        this.phase = 0;
    }

    setspindown() {
        if (this.motorOn[this.curDrive]) {
            this.motorSpinDownTask[this.curDrive].reschedule(this.cpu.peripheralCyclesPerSecond * 2);
        }
    }

    seek(track) {
        let realTrack = this.realTrack[this.curDrive];
        realTrack += track - this.curTrack[this.curDrive];
        if (realTrack < 0) realTrack = 0;
        if (realTrack > 79) {
            realTrack = 79;
        }
        this.realTrack[this.curDrive] = realTrack;
        const diff = this.drives[this.curDrive].seek(realTrack);
        // Let disc noises overlap by ~10%
        const seekLen = (this.noise.seek(diff) * 0.9 * this.cpu.peripheralCyclesPerSecond) | 0;
        this.callbackTask.reschedule(Math.max(DiscTimeSlice, seekLen));
        this.phase = 1;
    }

    prepareSectorIO(track, sector, numSectors) {
        if (numSectors !== undefined) this.sectorsLeft = numSectors & 31;
        if (sector !== undefined) this.curSector = sector;
        this.spinup(); // State: spinup -> seek.
    }

    parameter(val) {
        if (this.paramNum < 5) this.params[this.paramNum++] = val;
        if (this.paramNum !== this.paramReq) return;
        switch (this.curCommand) {
            case 0x35: // Specify.
                this.status = 0;
                break;
            case 0x29: // Seek
                this.spinup(); // State: spinup -> seek.
                break;
            case 0x1f: // Verify
            case 0x13: // Read
            case 0x0b: // Write
                this.prepareSectorIO(this.params[0], this.params[1], this.params[2]);
                break;
            case 0x1b: // Read ID
                this.prepareSectorIO(this.params[0], undefined, this.params[2]);
                break;
            case 0x23: // Format
                this.prepareSectorIO(this.params[0]);
                break;
            case 0x3a: // Special register write
                this.writeSpecial(this.params[0], this.params[1]);
                break;
            case 0x3d: // Special register read
                this.readSpecial(this.params[0]);
                break;
            default:
                this.result = 0x18;
                this.status = 0x18;
                this.NMI();
                break;
        }
    }

    reset() {}

    data(val) {
        this.curData = val;
        this.written = true;
        this.status &= ~0x0c;
        this.NMI();
    }

    write(addr, val) {
        switch (addr & 7) {
            case 0:
                this.command(val);
                break;
            case 1:
                this.parameter(val);
                break;
            case 2:
                this.reset(val);
                break;
            case 4:
            case 5:
            case 6:
            case 7:
                this.data(val);
                break;
        }
    }

    density() {
        return !!(this.drvout & 0x20);
    }

    update(status) {
        this.status = status;
        this.result = 0;
        this.NMI();
    }

    done() {
        this.update(0x18);
        this.setspindown();
        this.verify = false;
    }

    callback() {
        if (this.phase === 0) {
            // Spinup complete.
            this.seek(this.params[0]);
            return;
        }

        switch (this.curCommand) {
            case 0x29: // Seek
                this.curTrack[this.curDrive] = this.params[0];
                this.done();
                break;

            case 0x0b: // Write
                if (this.phase === 1) {
                    this.curTrack[this.curDrive] = this.params[0];
                    this.phase = 2;
                    this.drives[this.curDrive].write(this.curSector, this.params[0], this.density(), 0);
                    this.update(0x8c);
                    return;
                }
                if (--this.sectorsLeft === 0) {
                    this.done();
                    return;
                }
                this.curSector++;
                this.drives[this.curDrive].write(this.curSector, this.params[0], this.density(), 0);
                this.update(0x8c);
                break;

            case 0x13: // Read
            case 0x1f: // Verify
                if (this.phase === 1) {
                    this.curTrack[this.curDrive] = this.params[0];
                    this.phase = 2;
                    this.drives[this.curDrive].read(this.curSector, this.params[0], this.density(), 0);
                    return;
                }
                if (--this.sectorsLeft === 0) {
                    this.done();
                    return;
                }
                this.curSector++;
                this.drives[this.curDrive].read(this.curSector, this.params[0], this.density(), 0);
                break;

            case 0x1b: // Read ID
                if (this.phase === 1) {
                    this.curTrack[this.curDrive] = this.params[0];
                    this.phase = 2;
                    this.drives[this.curDrive].address(this.params[0], this.density(), 0);
                    return;
                }
                if (--this.sectorsLeft === 0) {
                    this.done();
                    return;
                }
                this.drives[this.curDrive].address(this.params[0], this.density(), 0);
                break;

            case 0x23: // Format
                switch (this.phase) {
                    case 1:
                        this.curTrack[this.curDrive] = this.params[0];
                        this.drives[this.curDrive].write(this.curSector, this.params[0], this.density(), 0);
                        this.update(0x8c);
                        this.phase = 2;
                        break;
                    case 2:
                        this.drives[this.curDrive].format(this.params[0], this.density(), 0);
                        this.phase = 3;
                        break;
                    case 3:
                        this.done();
                        break;
                }
                break;

            case 0xff:
                break;
            default:
                console.log("ERK bad command", utils.hexbyte(this.curCommand));
                break;
        }
    }
}

export class WD1770 {
    constructor(cpu, noise, scheduler) {
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
            scheduler.newTask(() => {
                this.motorOn[0] = false;
                this.checkSpinDownNoise();
            }),
            scheduler.newTask(() => {
                this.motorOn[1] = false;
                this.checkSpinDownNoise();
            }),
        ];
        this.scheduler = scheduler;
        this.drives = [emptySsd(this), emptySsd(this)];
        this.callbackTask = scheduler.newTask(() => {
            this.callback();
        });
    }

    checkSpinDownNoise() {
        if (!this.motorOn[0] && !this.motorOn[1]) this.noise.spinDown();
    }

    spinUp() {
        this.status |= 0x80;
        this.motorOn[this.curDrive] = true;
        this.motorSpinDownTask[this.curDrive].cancel();
        this.noise.spinUp();
    }

    spinDown() {
        this.status &= ~0x80;
        this.motorOn[this.curDrive] = false;
        this.checkSpinDownNoise();
    }

    setSpinDown() {
        this.motorSpinDownTask[this.curDrive].reschedule(45000 * 128);
    }

    track0() {
        return this.curTrack === 0 ? 0x00 : 0x04;
    }

    callback() {
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
    }

    read(addr) {
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
    }

    write(addr, byte) {
        switch (addr) {
            case 0xfe80:
                this.curDrive = byte & 2 ? 1 : 0;
                this.side = byte & 4 ? 1 : 0;
                this.density = !(byte & 8);
                break;
            case 0xfe24:
                this.curDrive = byte & 2 ? 1 : 0;
                this.side = byte & 16 ? 1 : 0;
                this.density = !(byte & 32);
                break;
            case 0xfe84:
            case 0xfe28: {
                const command = (byte >>> 4) & 0xf;
                const isInterrupt = command === 0x0d;
                if (this.status & 1 && !isInterrupt) {
                    // Attempt to write while controller is busy.
                    return;
                }
                this.command = byte;
                if (!isInterrupt) this.spinUp();
                this.handleCommand(command);
                break;
            }
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
    }

    curDisc() {
        return this.drives[this.curDrive];
    }

    seek(addr) {
        const diff = this.curDisc().seek(addr);
        const seekTime = (this.noise.seek(diff) * this.cpu.peripheralCyclesPerSecond) | 0;
        this.callbackTask.reschedule(Math.max(DiscTimeSlice, seekTime));
    }

    handleCommand(command) {
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
    }

    discData(byte) {
        this.status |= 0x02;
        this.data = byte;
        this.cpu.NMI(true);
    }

    readDiscData(last) {
        if (!this.written) return 0xff;
        this.written = false;
        if (!last) {
            this.cpu.NMI(true);
            this.status |= 0x02;
        }
        return this.data;
    }

    error(code) {
        this.callbackTask.cancel();
        this.cpu.NMI(true);
        this.status = code;
        this.spinDown();
    }

    discFinishRead() {
        this.callbackTask.reschedule(DiscTimeSlice);
    }

    notFound() {
        this.error(0x90);
    }

    writeProtect() {
        this.error(0xc0);
    }

    headerCrcError() {
        this.error(0x98);
    }

    dataCrcError() {
        this.error(0x88);
    }

    loadDisc(drive, disc) {
        this.drives[drive] = disc;
    }
}
