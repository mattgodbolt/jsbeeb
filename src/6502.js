"use strict";
import * as utils from "./utils.js";
import * as via from "./via.js";
import { Acia } from "./acia.js";
import { Serial } from "./serial.js";
import { Tube } from "./tube.js";
import { Adc } from "./adc.js";
import { Scheduler } from "./scheduler.js";
import { TouchScreen } from "./touchscreen.js";
import { TeletextAdaptor } from "./teletext_adaptor.js";
import { Filestore } from "./filestore.js";

const signExtend = utils.signExtend;

function _set(byte, mask, set) {
    return (byte & ~mask) | (set ? mask : 0);
}

class Flags {
    constructor() {
        this._byte = 0x30;
    }

    get c() {
        return !!(this._byte & 0x01);
    }

    set c(val) {
        this._byte = _set(this._byte, 0x01, val);
    }

    get z() {
        return !!(this._byte & 0x02);
    }

    set z(val) {
        this._byte = _set(this._byte, 0x02, val);
    }

    get i() {
        return !!(this._byte & 0x04);
    }

    set i(val) {
        this._byte = _set(this._byte, 0x04, val);
    }

    get d() {
        return !!(this._byte & 0x08);
    }

    set d(val) {
        this._byte = _set(this._byte, 0x08, val);
    }

    get v() {
        return !!(this._byte & 0x40);
    }

    set v(val) {
        this._byte = _set(this._byte, 0x40, val);
    }

    get n() {
        return !!(this._byte & 0x80);
    }

    set n(val) {
        this._byte = _set(this._byte, 0x80, val);
    }

    reset() {
        this._byte = 0x30;
    }

    debugString() {
        return (
            (this.n ? "N" : "n") +
            (this.v ? "V" : "v") +
            "xx" +
            (this.d ? "D" : "d") +
            (this.i ? "I" : "i") +
            (this.z ? "Z" : "z") +
            (this.c ? "C" : "c")
        );
    }

    setzn(v) {
        v &= 0xff;
        this._byte = (this._byte & ~(0x02 | 0x80)) | (v & 0x80) | (v === 0 ? 0x02 : 0x00);
        return v | 0;
    }

    asByte() {
        return this._byte | 0x30;
    }

    setFromByte(byte) {
        this._byte = byte | 0x30;
    }
}

class Base6502 {
    constructor(model) {
        this.model = model;
        this.a = this.x = this.y = this.s = 0;
        this.p = new Flags();
        this.pc = 0;
        this.opcodes = model.opcodesFactory(this);
        this.disassembler = this.opcodes.disassembler;
        this.forceTracing = false;
        this.runner = this.opcodes.runInstruction;
        this.interrupt = 0;
        this._nmiLevel = false;
        this._nmiEdge = false;

        if (model.nmos) {
            this.adc = function (addend) {
                if (!this.p.d) {
                    this.adcNonBCD(addend);
                } else {
                    this.adcBCD(addend);
                }
            };

            this.sbc = function (subend) {
                if (!this.p.d) {
                    this.adcNonBCD(subend ^ 0xff);
                } else {
                    this.sbcBCD(subend);
                }
            };
        } else {
            this.adc = function (addend) {
                if (!this.p.d) {
                    this.adcNonBCD(addend);
                } else {
                    this.adcBCDcmos(addend);
                }
            };

            this.sbc = function (subend) {
                if (!this.p.d) {
                    this.adcNonBCD(subend ^ 0xff);
                } else {
                    this.sbcBCDcmos(subend);
                }
            };
        }
    }

    incpc() {
        this.pc = (this.pc + 1) & 0xffff;
    }

    getb() {
        const result = this.readmem(this.pc);
        this.incpc();
        return result | 0;
    }

    getw() {
        let result = this.readmem(this.pc) | 0;
        this.incpc();
        result |= (this.readmem(this.pc) | 0) << 8;
        this.incpc();
        return result | 0;
    }

    checkInt() {
        this.takeInt = !!(this.interrupt && !this.p.i);
        this.takeInt |= this._nmiEdge;
    }

    // eslint-disable-next-line no-unused-vars
    writemem(address, value) {
        throw new Error("Must be overridden");
    }

    writememZpStack(address, value) {
        this.writemem(address, value);
    }

    // eslint-disable-next-line no-unused-vars
    readmem(address) {
        throw new Error("Must be overridden");
    }

    readmemZpStack(address) {
        return this.readmem(address);
    }

    push(v) {
        this.writememZpStack(0x100 + this.s, v);
        this.s = (this.s - 1) & 0xff;
    }

    pull() {
        this.s = (this.s + 1) & 0xff;
        return this.readmemZpStack(0x100 + this.s);
    }

    get nmi() {
        return this._nmiLevel;
    }

    NMI(nmi) {
        const prevLevel = this._nmiLevel;
        this._nmiLevel = !!nmi;
        if (this._nmiLevel && !prevLevel) this._nmiEdge = true;
    }

    polltime() {
        throw new Error("Must be overridden");
    }

    brk(isIrq) {
        // Behavior here generally discovered via Visual 6502 analysis.
        // 6502 has a quirky BRK; it was sanitized in 65c12.
        // See also https://wiki.nesdev.com/w/index.php/CPU_interrupts
        let pushAddr = this.pc;
        if (!isIrq) pushAddr = (pushAddr + 1) & 0xffff;
        this.readmem(pushAddr);

        this.push(pushAddr >>> 8);
        this.push(pushAddr & 0xff);
        let pushFlags = this.p.asByte();
        if (isIrq) pushFlags &= ~0x10;
        this.push(pushFlags);

        // NMI status is determined part way through the BRK / IRQ
        // sequence, and yes, on 6502, an NMI can redirect the vector
        // for a half-way done BRK instruction.
        this.polltime(4);
        let vector = 0xfffe;
        if ((this.model.nmos || isIrq) && this._nmiEdge) {
            vector = 0xfffa;
            this._nmiEdge = false;
        }
        this.takeInt = false;
        this.pc = this.readmem(vector) | (this.readmem(vector + 1) << 8);
        this.p.i = true;
        if (this.model.nmos) {
            this.polltime(3);
        } else {
            this.p.d = false;
            if (isIrq) {
                this.polltime(3);
            } else {
                this.polltime(2);
                // TODO: check 65c12 BRK interrupt poll timing.
                this.checkInt();
                this.polltime(1);
            }
        }
    }

    branch(taken) {
        const offset = signExtend(this.getb());
        if (!taken) {
            this.polltime(1);
            this.checkInt();
            this.polltime(1);
            return;
        }
        const newPc = (this.pc + offset) & 0xffff;
        const pageCrossed = !!((this.pc & 0xff00) ^ (newPc & 0xff00));
        this.pc = newPc;
        if (!this.model.nmos) {
            this.polltime(2 + pageCrossed);
            this.checkInt();
            this.polltime(1);
        } else if (!pageCrossed) {
            this.polltime(1);
            this.checkInt();
            this.polltime(2);
        } else {
            // 6502 polls twice during a taken branch with page
            // crossing and either is sufficient to trigger IRQ.
            // See https://wiki.nesdev.com/w/index.php/CPU_interrupts
            this.polltime(1);
            this.checkInt();
            const sawInt = this.takeInt;
            this.polltime(2);
            this.checkInt();
            this.takeInt |= sawInt;
            this.polltime(1);
        }
    }

    adcNonBCD(addend) {
        const result = this.a + addend + (this.p.c ? 1 : 0);
        this.p.v = !!((this.a ^ result) & (addend ^ result) & 0x80);
        this.p.c = !!(result & 0x100);
        this.a = this.p.setzn(result);
    }

    // For flags and stuff see URLs like:
    // http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f86911eaeaea&steps=16
    adcBCD(addend) {
        let ah = 0;
        const tempb = (this.a + addend + (this.p.c ? 1 : 0)) & 0xff;
        this.p.z = !tempb;
        let al = (this.a & 0xf) + (addend & 0xf) + (this.p.c ? 1 : 0);
        if (al > 9) {
            al -= 10;
            al &= 0xf;
            ah = 1;
        }
        ah += (this.a >>> 4) + (addend >>> 4);
        this.p.n = !!(ah & 8);
        this.p.v = !((this.a ^ addend) & 0x80) && !!((this.a ^ (ah << 4)) & 0x80);
        this.p.c = false;
        if (ah > 9) {
            this.p.c = true;
            ah -= 10;
            ah &= 0xf;
        }
        this.a = ((al & 0xf) | (ah << 4)) & 0xff;
    }

    // With reference to c64doc: http://vice-emu.sourceforge.net/plain/64doc.txt
    // and http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f8e988eaeaea&steps=18
    sbcBCD(subend) {
        const carry = this.p.c ? 0 : 1;
        let al = (this.a & 0xf) - (subend & 0xf) - carry;
        let ah = (this.a >>> 4) - (subend >>> 4);
        if (al & 0x10) {
            al = (al - 6) & 0xf;
            ah--;
        }
        if (ah & 0x10) {
            ah = (ah - 6) & 0xf;
        }

        const result = this.a - subend - carry;
        this.p.n = !!(result & 0x80);
        this.p.z = !(result & 0xff);
        this.p.v = !!((this.a ^ result) & (subend ^ this.a) & 0x80);
        this.p.c = !(result & 0x100);
        this.a = al | (ah << 4);
    }

    adcBCDcmos(addend) {
        this.polltime(1); // One more cycle, apparently
        const carry = this.p.c ? 1 : 0;
        let al = (this.a & 0xf) + (addend & 0xf) + carry;
        let ah = (this.a >>> 4) + (addend >>> 4);
        if (al > 9) {
            al = (al - 10) & 0xf;
            ah++;
        }
        this.p.v = !((this.a ^ addend) & 0x80) && !!((this.a ^ (ah << 4)) & 0x80);
        this.p.c = false;
        if (ah > 9) {
            ah = (ah - 10) & 0xf;
            this.p.c = true;
        }
        this.a = this.p.setzn(al | (ah << 4));
    }

    sbcBCDcmos(subend) {
        this.polltime(1); // One more cycle, apparently
        const carry = this.p.c ? 0 : 1;
        const al = (this.a & 0xf) - (subend & 0xf) - carry;
        let result = this.a - subend - carry;
        if (result < 0) {
            result -= 0x60;
        }
        if (al < 0) result -= 0x06;

        this.adcNonBCD(subend ^ 0xff); // For flags
        this.a = this.p.setzn(result);
    }

    arr(arg) {
        // Insane instruction. I started with b-em source, but ended up using:
        // http://www.6502.org/users/andre/petindex/local/64doc.txt as reference,
        // tidying up as needed and fixing a couple of typos.
        if (this.p.d) {
            const temp = this.a & arg;

            const ah = temp >>> 4;
            const al = temp & 0x0f;

            this.p.n = this.p.c;
            this.a = (temp >>> 1) | (this.p.c ? 0x80 : 0x00);
            this.p.z = !this.a;
            this.p.v = (temp ^ this.a) & 0x40;

            if (al + (al & 1) > 5) this.a = (this.a & 0xf0) | ((this.a + 6) & 0xf);

            this.p.c = ah + (ah & 1) > 5;
            if (this.p.c) this.a = (this.a + 0x60) & 0xff;
        } else {
            this.a = this.a & arg;
            this.p.v = !!(((this.a >>> 7) ^ (this.a >>> 6)) & 0x01);
            this.a >>>= 1;
            if (this.p.c) this.a |= 0x80;
            this.p.setzn(this.a);
            this.p.c = !!(this.a & 0x40);
        }
    }
}

class Tube6502 extends Base6502 {
    constructor(model, cpu) {
        super(model);

        this.cycles = 0;
        this.romPaged = true;
        this.memory = new Uint8Array(65536);
        this.rom = new Uint8Array(4096);

        this.tube = new Tube(cpu, this);
    }

    reset(hard) {
        this.romPaged = true;
        this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
        this.p.i = true;
        this.tube.reset(hard);
    }

    readmem(offset) {
        if ((offset & 0xfff8) === 0xfef8) {
            if ((offset & 7) === 0) {
                this.romPaged = false;
            }
            return this.tube.parasiteRead(offset);
        }
        if (this.romPaged && (offset & 0xf000) === 0xf000) {
            return this.rom[offset & 0xfff];
        }
        return this.memory[offset & 0xffff];
    }

    readmemZpStack(offset) {
        return this.memory[offset & 0xffff];
    }

    writemem(addr, b) {
        if ((addr & 0xfff8) === 0xfef8) {
            return this.tube.parasiteWrite(addr, b);
        }
        this.memory[addr & 0xffff] = b;
    }

    writememZpStack(addr, b) {
        this.memory[addr & 0xffff] = b;
    }

    polltime(cycles) {
        this.cycles -= cycles;
    }

    polltimeAddr(cycles) {
        this.polltime(cycles);
    }

    read(addr) {
        return this.tube.hostRead(addr);
    }

    write(addr, b) {
        this.tube.hostWrite(addr, b);
    }

    execute(cycles) {
        this.cycles += cycles * 2;
        if (this.cycles < 3) return;
        while (this.cycles > 0) {
            const opcode = this.readmem(this.pc);
            this.incpc();
            this.runner.run(opcode);
            if (this.takeInt) this.brk(true);
        }
    }

    async loadOs() {
        console.log("Loading tube rom from roms/" + this.model.os);
        const tubeRom = this.rom;
        const data = await utils.loadData("roms/" + this.model.os);
        const len = data.length;
        if (len !== 2048) throw new Error("Broken ROM file (length=" + len + ")");
        for (let i = 0; i < len; ++i) {
            tubeRom[i + 2048] = data[i];
        }
    }
}

class FakeTube {
    read() {
        return 0xfe;
    }

    write() {}

    execute() {}

    reset() {}
}

class FakeUserPort {
    write() {}

    read() {
        return 0xff;
    }
}

function fixUpConfig(config) {
    if (config === undefined) config = {};
    if (!config.keyLayout) config.keyLayout = "physical";
    if (!config.cpuMultiplier) config.cpuMultiplier = 1;
    if (!config.userPort) config.userPort = new FakeUserPort();
    if (config.printerPort === undefined) config.printerPort = null;
    config.extraRoms = config.extraRoms || [];
    config.debugFlags = config.debugFlags || {};
    return config;
}

class DebugHook {
    constructor(cpu, functionName) {
        this.cpu = cpu;
        this.functionName = functionName;
        this.handlers = [];
    }

    add(handler) {
        const self = this;
        this.handlers.push(handler);
        if (!this.cpu[this.functionName]) {
            this.cpu[this.functionName] = function () {
                for (let i = 0; i < self.handlers.length; ++i) {
                    const handler = self.handlers[i];
                    if (handler.apply(handler, arguments)) {
                        self.cpu.stop();
                        return true;
                    }
                }
                return false;
            };
        }
        handler.remove = function () {
            self.remove(handler);
        };
        return handler;
    }

    remove(handler) {
        const i = this.handlers.indexOf(handler);
        if (i < 0) throw "Unable to find debug hook handler";
        this.handlers = this.handlers.slice(0, i).concat(this.handlers.slice(i + 1));
        if (this.handlers.length === 0) {
            this.cpu[this.functionName] = null;
        }
    }

    clear() {
        this.handlers = [];
        this.cpu[this.functionName] = null;
    }
}

function is1MHzAccess(addr) {
    const FEslowdown = [true, false, true, true, false, false, true, false];
    return addr >= 0xfc00 && addr < 0xff00 && (addr < 0xfe00 || FEslowdown[(addr >>> 5) & 7]);
}

export class Cpu6502 extends Base6502 {
    constructor(model, dbgr, video_, soundChip_, ddNoise_, music5000_, cmos, config, econet_) {
        super(model);
        this.config = fixUpConfig(config);
        this.debugFlags = this.config.debugFlags;
        this.cmos = cmos;
        this.debugger = dbgr;

        this.video = video_;
        this.crtc = this.video.crtc;
        this.ula = this.video.ula;
        this.soundChip = soundChip_;
        this.music5000 = music5000_;
        this.ddNoise = ddNoise_;
        this.memStatOffsetByIFetchBank = 0;
        this.memStatOffset = 0;
        this.memStat = new Uint8Array(512);
        this.memLook = new Int32Array(512); // Cannot be unsigned as we use negative offsets
        this.ramRomOs = new Uint8Array(128 * 1024 + 17 * 16 * 16384);
        this.romOffset = 128 * 1024;
        this.osOffset = this.romOffset + 16 * 16 * 1024;
        this.romsel = 0;
        this.acccon = 0;
        this.oldPcArray = new Uint16Array(256);
        this.oldAArray = new Uint8Array(256);
        this.oldXArray = new Uint8Array(256);
        this.oldYArray = new Uint8Array(256);
        this.oldPcIndex = 0;
        this.resetLine = true;
        this.cpuMultiplier = this.config.cpuMultiplier;
        this.videoCyclesBatch = this.config.videoCyclesBatch | 0;
        this.peripheralCyclesPerSecond = 2 * 1000 * 1000;
        this.tube = model.tube ? new Tube6502(model.tube, this) : new FakeTube();
        this.music5000PageSel = 0;
        this.econet = econet_;

        this.peripheralCycles = 0;
        this.videoCycles = 0;

        if (this.cpuMultiplier === 1 && this.videoCyclesBatch === 0) {
            this.polltime = this.polltimeFast;
        } else {
            this.polltime = this.polltimeSlow;
        }

        this._debugRead = this._debugWrite = this._debugInstruction = null;
        this.debugInstruction = new DebugHook(this, "_debugInstruction");
        this.debugRead = new DebugHook(this, "_debugRead");
        this.debugWrite = new DebugHook(this, "_debugWrite");

        this.scheduler = new Scheduler();
        this.sysvia = new via.SysVia(
            this,
            this.scheduler,
            this.video,
            this.soundChip,
            this.cmos,
            this.model.isMaster,
            this.config.keyLayout,
            this.config.getGamepads,
        );
        this.uservia = new via.UserVia(this, this.scheduler, this.model.isMaster, this.config.userPort);
        this.acia = new Acia(this, this.soundChip.toneGenerator, this.scheduler, this.touchScreen);
        this.serial = new Serial(this.acia);
        this.adconverter = new Adc(this.sysvia, this.scheduler);
        this.soundChip.setScheduler(this.scheduler);
        this.fdc = new this.model.Fdc(this, this.ddNoise, this.scheduler, this.debugFlags);
    }

    getPrevPc(index) {
        return this.oldPcArray[(this.oldPcIndex - index) & 0xff];
    }

    // BBC Master memory map (within ramRomOs array):
    // 00000 - 08000 -> base 32KB RAM
    // 08000 - 09000 -> ANDY - 4KB
    // 09000 - 0b000 -> HAZEL - 8KB
    // 0b000 - 10000 -> LYNNE - 20KB
    romSelect(b) {
        this.romsel = b;
        const bankOffset = ((b & 15) << 14) + this.romOffset;
        const offset = bankOffset - 0x8000;
        for (let c = 128; c < 192; ++c) this.memLook[c] = this.memLook[256 + c] = offset;
        const swram = this.model.swram[b & 15] ? 1 : 2;
        for (let c = 128; c < 192; ++c) this.memStat[c] = this.memStat[256 + c] = swram;
        if (this.model.isMaster && b & 0x80) {
            // 4Kb RAM (private RAM - ANDY)
            // Zero offset as 0x8000 mapped to 0x8000
            for (let c = 128; c < 144; ++c) {
                this.memLook[c] = this.memLook[256 + c] = 0;
                this.memStat[c] = this.memStat[256 + c] = 1;
            }
        }
    }

    writeAcccon(b) {
        this.acccon = b;
        // ACCCON is
        // IRR TST IJF ITU  Y  X  E  D
        //  7   6   5   4   3  2  1  0
        // Video offset (to LYNNE) is controlled by the "D" bit of ACCCON.
        // LYNNE lives at 0xb000 in our map, but the offset we use here is 0x8000
        // as the video circuitry will already be looking at 0x3000 or so above
        // the offset.
        this.videoDisplayPage = b & 1 ? 0x8000 : 0x0000;

        const bitE = !!(b & 2);
        const bitX = !!(b & 4);
        const bitY = !!(b & 8);
        // The "X" bit controls the "illegal" paging 20KB region overlay of LYNNE.
        // This loop rewires which paged RAM 0x3000 - 0x7fff hits.
        for (let i = 48; i < 128; ++i) {
            // For "normal" access, it's simple: shadow or not.
            this.memLook[i] = bitX ? 0x8000 : 0;
            // For special Master opcode access at 0xc000 - 0xdfff,
            // it's more involved.
            if (bitY) {
                // If 0xc000 is mapped as RAM, the Master opcode access
                // is disabled; follow what normal access does.
                this.memLook[i + 256] = this.memLook[i];
            } else {
                // Master opcode access enabled; bit E determines whether
                // it hits shadow RAM or normal RAM. This is independent
                // of bit X.
                this.memLook[i + 256] = bitE ? 0x8000 : 0;
            }
        }
        // The "Y" bit pages in HAZEL at c000->dfff. HAZEL is mapped in our RAM
        // at 0x9000, so (0x9000 - 0xc000) = -0x3000 is needed as an offset.
        const hazelRAM = bitY ? 1 : 2;
        const hazelOff = bitY ? -0x3000 : this.osOffset - 0xc000;
        for (let i = 192; i < 224; ++i) {
            this.memLook[i] = this.memLook[i + 256] = hazelOff;
            this.memStat[i] = this.memStat[i + 256] = hazelRAM;
        }
    }

    // Works for unpaged RAM only (ie stack and zp)
    readmemZpStack(addr) {
        addr &= 0xffff;
        const res = this.ramRomOs[addr];
        if (this._debugRead) this._debugRead(addr, 0, res);
        return res | 0;
    }

    writememZpStack(addr, b) {
        addr &= 0xffff;
        b |= 0;
        if (this._debugWrite) this._debugWrite(addr, b);
        this.ramRomOs[addr] = b;
    }

    // Handy debug function to read a string zero or \n terminated.
    readString(addr) {
        let s = "";
        for (;;) {
            const b = this.readmem(addr);
            addr++;
            if (b === 0 || b === 13) break;
            s += String.fromCharCode(b);
        }
        return s;
    }

    findString(string, addr) {
        addr = addr | 0;
        for (; addr < 0xffff; ++addr) {
            let i;
            for (i = 0; i < string.length; ++i) {
                if (this.readmem(addr + i) !== string.charCodeAt(i)) break;
            }
            if (i === string.length) {
                return addr;
            }
        }
        return null;
    }

    readArea(addr, len) {
        let str = "";
        for (let i = 0; i < len; ++i) {
            str += utils.hexbyte(this.readmem(addr + i));
        }
        return str;
    }

    handleEconetStationId() {
        if (!this.econet) return 0xff;
        this.econet.econetNMIEnabled = false;
        return this.econet.stationId;
    }

    handleEconetNMIEnable() {
        if (this.econet && !this.econet.econetNMIEnabled) {
            // was off
            this.econet.econetNMIEnabled = true;
            if (this.econet.ADLC.status1 & 128) {
                // irq pending
                this.NMI(true); // delayed NMI asserted
            }
        }
        return 0xff;
    }

    readDevice(addr) {
        if (this.model.isMaster && this.acccon & 0x40) {
            // TST bit of ACCCON
            return this.ramRomOs[this.osOffset + (addr & 0x3fff)];
        }
        addr &= 0xffff;

        switch (addr & ~0x0003) {
            case 0xfc10:
                if (this.model.hasTeletextAdaptor) return this.teletextAdaptor.read(addr - 0xfc10);
                break;
            case 0xfc20:
            case 0xfc24:
            case 0xfc28:
            case 0xfc2c:
            case 0xfc30:
            case 0xfc34:
            case 0xfc38:
            case 0xfc3c:
                // SID Chip.
                break;
            case 0xfc40:
            case 0xfc44:
            case 0xfc48:
            case 0xfc4c:
            case 0xfc50:
            case 0xfc54:
            case 0xfc58:
            case 0xfc5c:
                // IDE
                break;
            case 0xfcfc:
                if (addr === 0xfcff && this.model.hasMusic5000) return this.music5000PageSel;
                break;
            case 0xfe00:
            case 0xfe04:
                return this.crtc.read(addr);
            case 0xfe08:
            case 0xfe0c:
                return this.acia.read(addr);
            case 0xfe10:
            case 0xfe14:
                return this.serial.read(addr);
            case 0xfe18:
                return this.model.isMaster ? this.adconverter.read(addr) : this.handleEconetStationId();
            case 0xfe20:
                if (!this.model.isMaster) return this.handleEconetNMIEnable();
                break;
            case 0xfe24:
            case 0xfe28:
                if (this.model.isMaster) return this.fdc.read(addr);
                break;
            case 0xfe30:
                if (this.model.isMaster) return this.romsel & 0x8f;
                break;
            case 0xfe34:
                if (this.model.isMaster) return this.acccon;
                break;
            case 0xfe38:
                if (this.model.isMaster) return this.handleEconetStationId();
                break;
            case 0xfe3c:
                if (this.model.isMaster) return this.handleEconetNMIEnable();
                break;
            case 0xfe40:
            case 0xfe44:
            case 0xfe48:
            case 0xfe4c:
            case 0xfe50:
            case 0xfe54:
            case 0xfe58:
            case 0xfe5c:
                return this.sysvia.read(addr);
            case 0xfe60:
            case 0xfe64:
            case 0xfe68:
            case 0xfe6c:
            case 0xfe70:
            case 0xfe74:
            case 0xfe78:
            case 0xfe7c:
                return this.uservia.read(addr);
            case 0xfe80:
            case 0xfe84:
            case 0xfe88:
            case 0xfe8c:
            case 0xfe90:
            case 0xfe94:
            case 0xfe98:
            case 0xfe9c:
                if (!this.model.isMaster) return this.fdc.read(addr);
                break;
            case 0xfea0:
                // Econet status register
                if (this.econet) {
                    return this.econet.readRegister(addr & 3);
                }
                break;
            case 0xfec0:
            case 0xfec4:
            case 0xfec8:
            case 0xfecc:
            case 0xfed0:
            case 0xfed4:
            case 0xfed8:
            case 0xfedc:
                if (!this.model.isMaster) return this.adconverter.read(addr);
                break;
            case 0xfee0:
            case 0xfee4:
            case 0xfee8:
            case 0xfeec:
            case 0xfef0:
            case 0xfef4:
            case 0xfef8:
            case 0xfefc:
                return this.tube.read(addr);
        }

        if (this.model.hasMusic5000) {
            if ((this.music5000PageSel & 0xf0) === 0x30 && (addr & 0xff00) === 0xfd00) {
                return this.music5000.read(this.music5000PageSel, addr);
            }
        }

        if (addr >= 0xfc00 && addr < 0xfe00) return 0xff;
        return addr >>> 8;
    }

    videoRead(addr) {
        return this.ramRomOs[addr | this.videoDisplayPage] | 0;
    }

    readmem(addr) {
        addr &= 0xffff;
        const statOffset = this.memStatOffset + (addr >>> 8);
        if (this.memStat[statOffset]) {
            const offset = this.memLook[statOffset];
            const res = this.ramRomOs[offset + addr];
            if (this._debugRead) this._debugRead(addr, res, offset);
            return res | 0;
        } else {
            const res = this.readDevice(addr);
            if (this._debugRead) this._debugRead(addr, res, 0);
            return res | 0;
        }
    }

    peekmem(addr) {
        const statOffset = this.memStatOffset + (addr >>> 8);
        if (this.memStat[statOffset]) {
            const offset = this.memLook[statOffset];
            return this.ramRomOs[offset + addr];
        } else {
            return 0xff; // TODO; peekDevice -- this.peekDevice(addr);
        }
    }

    writemem(addr, b) {
        addr &= 0xffff;
        b |= 0;
        if (this._debugWrite) this._debugWrite(addr, b);
        const statOffset = this.memStatOffset + (addr >>> 8);
        if (this.memStat[statOffset] === 1) {
            const offset = this.memLook[statOffset];
            this.ramRomOs[offset + addr] = b;
            return;
        }
        if (addr < 0xfc00 || addr >= 0xff00) return;
        this.writeDevice(addr, b);
    }

    writeDevice(addr, b) {
        addr &= 0xffff;
        b |= 0;

        if (this.model.hasMusic5000 && (addr & 0xff00) === 0xfd00 && (this.music5000PageSel & 0xf0) === 0x30) {
            this.music5000.write(this.music5000PageSel, addr, b);
            return;
        }

        switch (addr & ~0x0003) {
            case 0xfc10:
                if (this.model.hasTeletextAdaptor) return this.teletextAdaptor.write(addr - 0xfc10, b);
                break;
            case 0xfc20:
            case 0xfc24:
            case 0xfc28:
            case 0xfc2c:
            case 0xfc30:
            case 0xfc34:
            case 0xfc38:
            case 0xfc3c:
                // SID chip
                break;
            case 0xfc40:
            case 0xfc44:
            case 0xfc48:
            case 0xfc4c:
            case 0xfc50:
            case 0xfc54:
            case 0xfc58:
            case 0xfc5c:
                // IDE
                break;
            case 0xfcfc:
                if (addr === 0xfcff && this.model.hasMusic5000) {
                    this.music5000PageSel = b;
                }
                break;
            case 0xfe00:
            case 0xfe04:
                return this.crtc.write(addr, b);
            case 0xfe08:
            case 0xfe0c:
                return this.acia.write(addr, b);
            case 0xfe10:
            case 0xfe14:
                return this.serial.write(addr, b);
            case 0xfe18:
                if (this.model.isMaster) return this.adconverter.write(addr, b);
                if (!this.model.isMaster && this.econet) this.econet.econetNMIEnabled = false;
                break;
            case 0xfe20:
                return this.ula.write(addr, b);
            case 0xfe24:
            case 0xfe28:
                if (this.model.isMaster) {
                    return this.fdc.write(addr, b);
                }
                return this.ula.write(addr, b);
            case 0xfe2c:
                if (!this.model.isMaster) {
                    return this.ula.write(addr, b);
                }
                break;
            case 0xfe30:
                return this.romSelect(b);
            case 0xfe34:
                if (this.model.isMaster) {
                    return this.writeAcccon(b);
                }
                return this.romSelect(b);
            case 0xfe38:
                if (this.model.isMaster && this.econet) this.econet.econetNMIEnabled = false;
                break;
            case 0xfe3c:
                if (!this.model.isMaster) {
                    return this.romSelect(b);
                }
                break;
            case 0xfe40:
            case 0xfe44:
            case 0xfe48:
            case 0xfe4c:
            case 0xfe50:
            case 0xfe54:
            case 0xfe58:
            case 0xfe5c:
                return this.sysvia.write(addr, b);
            case 0xfe60:
            case 0xfe64:
            case 0xfe68:
            case 0xfe6c:
            case 0xfe70:
            case 0xfe74:
            case 0xfe78:
            case 0xfe7c:
                return this.uservia.write(addr, b);
            case 0xfe80:
            case 0xfe84:
            case 0xfe88:
            case 0xfe8c:
            case 0xfe90:
            case 0xfe94:
            case 0xfe98:
            case 0xfe9c:
                if (!this.model.isMaster) return this.fdc.write(addr, b);
                break;

            case 0xfea0:
            case 0xfea4:
            case 0xfea8:
            case 0xfeac:
            case 0xfeb0:
            case 0xfeb4:
            case 0xfeb8:
            case 0xfebc:
                if (this.econet) this.econet.writeRegister(addr & 3, b);
                break;
            case 0xfec0:
            case 0xfec4:
            case 0xfec8:
            case 0xfecc:
            case 0xfed0:
            case 0xfed4:
            case 0xfed8:
            case 0xfedc:
                if (!this.model.isMaster) return this.adconverter.write(addr, b);
                break;
            case 0xfee0:
            case 0xfee4:
            case 0xfee8:
            case 0xfeec:
            case 0xfef0:
            case 0xfef4:
            case 0xfef8:
            case 0xfefc:
                return this.tube.write(addr, b);
        }
    }

    async loadRom(name, offset) {
        if (name.indexOf("http") !== 0) name = "roms/" + name;
        console.log("Loading ROM from " + name);
        const ramRomOs = this.ramRomOs;
        let data = await utils.loadData(name);
        if (/\.zip/i.test(name)) {
            data = utils.unzipRomImage(data).data;
        }
        ramRomOs.set(data, offset);
    }

    async loadOs(os) {
        const extraRoms = Array.prototype.slice.call(arguments, 1).concat(this.config.extraRoms);
        os = "roms/" + os;
        console.log(`Loading OS from ${os}`);
        const ramRomOs = this.ramRomOs;
        const data = await utils.loadData(os);
        const len = data.length;
        if (len < 16384 || len & 16383) throw new Error(`Broken OS ROM file (length=${len})`);
        ramRomOs.set(data, this.osOffset);
        const numExtraBanks = (len - 16384) / 16384;
        let romIndex = 16 - numExtraBanks;
        for (let i_1 = 0; i_1 < numExtraBanks; ++i_1) {
            const srcBase = 16384 + 16384 * i_1;
            const destBase = this.romOffset + (romIndex + i_1) * 16384;
            ramRomOs.set(data.subarray(srcBase, srcBase + 16384), destBase);
        }
        const awaiting = [];
        for (let i_2 = 0; i_2 < extraRoms.length; ++i_2) {
            // Skip over banks 4-7 (sideways RAM on a Master)
            romIndex--;
            while (this.model.swram[romIndex]) {
                romIndex--;
            }

            awaiting.push(this.loadRom(extraRoms[i_2], this.romOffset + romIndex * 16384));
        }
        return await Promise.all(awaiting);
    }

    setReset(resetOn) {
        this.resetLine = !resetOn;
    }

    reset(hard) {
        if (hard) {
            // On the Master, opcodes executing from 0xc000 - 0xdfff can optionally have their memory accesses
            // redirected to shadow RAM.
            this.memStatOffsetByIFetchBank = this.model.isMaster ? (1 << 0xc) | (1 << 0xd) : 0x0000;
            if (!this.model.isTest) {
                for (let i = 0; i < 128; ++i) this.memStat[i] = this.memStat[256 + i] = 1;
                for (let i = 128; i < 256; ++i) this.memStat[i] = this.memStat[256 + i] = 2;
                for (let i = 0; i < 128; ++i) this.memLook[i] = this.memLook[256 + i] = 0;
                for (let i = 128; i < 192; ++i) this.memLook[i] = this.memLook[256 + i] = this.romOffset - 0x8000;
                for (let i = 192; i < 256; ++i) this.memLook[i] = this.memLook[256 + i] = this.osOffset - 0xc000;

                for (let i = 0xfc; i < 0xff; ++i) this.memStat[i] = this.memStat[256 + i] = 0;
            } else {
                // Test sets everything as RAM.
                for (let i = 0; i < 256; ++i) {
                    this.memStat[i] = this.memStat[256 + i] = 1;
                    this.memLook[i] = this.memLook[256 + i] = 0;
                }
            }
            // DRAM content is not guaranteed to contain any particular
            // value on start up, so we choose values that help avoid
            // bugs in various games.
            for (let i = 0; i < this.romOffset; ++i) {
                if (i < 0x100) {
                    // For Clogger.
                    this.ramRomOs[i] = 0x00;
                } else {
                    // For Eagle Empire.
                    this.ramRomOs[i] = 0xff;
                }
            }
            this.videoDisplayPage = 0;
            if (this.config.printerPort) this.uservia.ca2changecallback = this.config.printerPort.outputStrobe;

            this.sysvia.reset();
            this.uservia.reset();
            this.acia.reset();
            this.serial.reset();
            this.ddNoise.spinDown();
            this.fdc.powerOnReset();
            this.adconverter.reset();

            this.touchScreen = new TouchScreen(this.scheduler);
            if (this.model.hasTeletextAdaptor) this.teletextAdaptor = new TeletextAdaptor(this);
            if (this.econet) this.filestore = new Filestore(this, this.econet);
        } else {
            this.fdc.reset();
        }
        this.tube.reset(hard);
        if (hard) {
            this.targetCycles = 0;
            this.currentCycles = 0;
            this.cycleSeconds = 0;
        }
        this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
        this.p.i = true;
        this._nmiEdge = false;
        this._nmiLevel = false;
        this.halted = false;
        this.music5000PageSel = 0;
        this.video.reset(this, this.sysvia, hard);
        this.soundChip.reset(hard);
        if (this.teletextAdaptor) this.teletextAdaptor.reset(hard);
        if (this.music5000) this.music5000.reset(hard);
        if (hard && this.econet) {
            this.econet.reset();
            this.filestore.reset();
        }
    }

    updateKeyLayout() {
        this.sysvia.setKeyLayout(this.config.keyLayout);
    }

    polltimeAddr(cycles, addr) {
        cycles = cycles | 0;
        if (is1MHzAccess(addr)) {
            cycles += 1 + ((cycles ^ this.currentCycles) & 1);
        }
        this.polltime(cycles);
    }

    // Common between polltimeSlow and polltimeFast
    polltimeCommon(cycles) {
        this.scheduler.polltime(cycles);
        this.tube.execute(cycles);
        if (this.teletextAdaptor) this.teletextAdaptor.polltime(cycles);
        if (this.music5000) this.music5000.polltime(cycles);
        if (this.econet) {
            const donmi = this.econet.polltime(cycles);
            if (donmi && this.econet.econetNMIEnabled) {
                this.NMI(true);
            }
            this.filestore.polltime(cycles);
        }
    }

    // Slow version allows video batching and cpu multipliers
    polltimeSlow(cycles) {
        cycles |= 0;
        this.currentCycles += cycles;
        this.peripheralCycles += cycles;
        this.videoCycles += cycles;
        cycles = (this.videoCycles / this.cpuMultiplier) | 0;
        if (cycles > this.videoCyclesBatch) {
            this.video.polltime(cycles);
            this.videoCycles -= (cycles * this.cpuMultiplier) | 0;
        }
        cycles = (this.peripheralCycles / this.cpuMultiplier) | 0;
        if (!cycles) return;
        this.peripheralCycles -= (cycles * this.cpuMultiplier) | 0;
        this.polltimeCommon(cycles);
    }

    // Faster, but more limited version
    polltimeFast(cycles) {
        cycles |= 0;
        this.currentCycles += cycles;
        this.video.polltime(cycles);
        this.polltimeCommon(cycles);
    }

    execute(numCyclesToRun) {
        this.halted = false;
        this.targetCycles += numCyclesToRun;
        // To prevent issues with wrapping around / overflowing the accuracy that poxy Javascript numbers have,
        // find the smaller of the target and current cycles, and if that's over one second's worth; subtract
        // that from both, to keep the domain low (while accumulating seconds). Take care to preserve the bottom
        // bit though; as that encodes whether we're on an even or odd bus cycle.
        const smaller = Math.min(this.targetCycles, this.currentCycles) & 0xfffffffe;
        if (smaller >= 2 * 1000 * 1000) {
            this.targetCycles -= 2 * 1000 * 1000;
            this.currentCycles -= 2 * 1000 * 1000;
            this.cycleSeconds++;
        }
        // Any tracing or debugging means we need to run the potentially slower version: the debug read or
        // debug write might change tracing or other debugging while we're running.
        if (this.forceTracing || this._debugInstruction || this._debugRead || this._debugWrite) {
            return this.executeInternal();
        } else {
            return this.executeInternalFast();
        }
    }

    executeInternal() {
        let first = true;
        while (!this.halted && this.currentCycles < this.targetCycles) {
            this.oldPcIndex = (this.oldPcIndex + 1) & 0xff;
            this.oldPcArray[this.oldPcIndex] = this.pc;
            this.memStatOffset = this.memStatOffsetByIFetchBank & (1 << (this.pc >>> 12)) ? 256 : 0;
            const opcode = this.readmem(this.pc);
            if (this._debugInstruction && !first && this._debugInstruction(this.pc, opcode)) {
                return false;
            }
            first = false;
            this.incpc();
            this.runner.run(opcode);
            this.oldAArray[this.oldPcIndex] = this.a;
            this.oldXArray[this.oldPcIndex] = this.x;
            this.oldYArray[this.oldPcIndex] = this.y;
            if (this.takeInt) this.brk(true);
            if (!this.resetLine) this.reset(false);
        }
        return !this.halted;
    }

    executeInternalFast() {
        while (!this.halted && this.currentCycles < this.targetCycles) {
            this.memStatOffset = this.memStatOffsetByIFetchBank & (1 << (this.pc >>> 12)) ? 256 : 0;
            const opcode = this.readmem(this.pc);
            this.incpc();
            this.runner.run(opcode);
            if (this.takeInt) this.brk(true);
            if (!this.resetLine) this.reset(false);
        }
        return !this.halted;
    }

    stop() {
        this.halted = true;
    }

    dumpTrace(maxToShow, func) {
        if (!maxToShow) maxToShow = 256;
        if (maxToShow > 256) maxToShow = 256;
        const disassembler = this.disassembler;
        func =
            func ||
            function (pc, a, x, y) {
                const dis = disassembler.disassemble(pc, true)[0];
                console.log(
                    utils.hexword(pc),
                    (dis + "                       ").substring(0, 15),
                    utils.hexbyte(a),
                    utils.hexbyte(x),
                    utils.hexbyte(y),
                );
            };
        for (let i = maxToShow - 2; i >= 0; --i) {
            const j = (this.oldPcIndex - i) & 255;
            func(this.oldPcArray[j], this.oldAArray[j], this.oldXArray[j], this.oldYArray[j]);
        }
        func(this.pc, this.a, this.x, this.y);
    }

    async initialise() {
        if (this.model.os.length) {
            await this.loadOs.apply(this, this.model.os);
        }
        if (this.model.tube) {
            await this.tube.loadOs();
        }
        this.reset(true);
        this.debugger.setCpu(this);
    }
}
