import * as via from "./via.js";
import { Acia } from "./acia.js";
import { Serial } from "./serial.js";
import { Tube } from "./tube.js";
import { Adc } from "./adc.js";
import { Scheduler } from "./scheduler.js";
import { TouchScreen } from "./touchscreen.js";
import { TeletextAdaptor } from "./teletext_adaptor.js";
import { Filestore } from "./filestore.js";
import { FakeRelayNoise } from "./relaynoise.js";
import { AtomPPIA } from "./ppia.js";
import { AtomMMC2 } from "./mmc.js";
import { signExtend } from "./binary.js";
import { hexbyte, hexword } from "./hex.js";
import { loadData } from "./loader.js";
import { MediaResolver } from "./media-resolver.js";
import { BrkOpcode, Breakpoints } from "./breakpoints.js";

async function romImage(name) {
    return (await new MediaResolver().resolve("rom", name)).data;
}

function _set(byte, mask, set) {
    return (byte & ~mask) | (set ? mask : 0);
}

const UnpeekableDevice = 0xff;
export const BaseRamBytes = 64 * 1024;
export const RomBankBytes = 16 * 1024;
export const NumRomBanks = 16;
const RomselAndy = 0x80;
const AndyStart = 0x8000;
const AndyEnd = 0x9000;
const RomOffset = BaseRamBytes;
const OsOffset = RomOffset + NumRomBanks * RomBankBytes;
const BbcMemoryBytes = OsOffset + RomBankBytes;
// Further from every real offset than any address, and a small integer in every V8 build.
const SlowPathOffset = -0x40000000;
const NmiVector = 0xfffa;
const IrqVector = 0xfffe;

/**
 * Packs sideways RAM banks into a snapshot's `swram` and `swramBankMask`: the banks back to back in ascending
 * order, and a mask with bit n set when bank n is among them.
 * @param {Map<number, Uint8Array>} banks 16KB of contents for each bank number
 */
export function packSidewaysRam(banks) {
    const bankNumbers = [...banks.keys()].sort((a, b) => a - b);
    const swram = new Uint8Array(bankNumbers.length * RomBankBytes);
    bankNumbers.forEach((bank, index) => swram.set(banks.get(bank), index * RomBankBytes));
    return { swram, swramBankMask: bankNumbers.reduce((mask, bank) => mask | (1 << bank), 0) };
}

/** One bit per device that can drive the NMI line; the CPU takes the OR of them all. */
export const NmiSource = Object.freeze({
    fdc: 0x01,
    econet: 0x02,
    tube: 0x04,
});

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
    constructor(model, { cycleAccurate = true } = {}) {
        this.model = model;
        this.a = this.x = this.y = this.s = 0;
        this.p = new Flags();
        this.pc = 0;
        this.opcodes = model.opcodesFactory(this, { cycleAccurate });
        this.disassembler = this.opcodes.disassembler;
        this.forceTracing = false;
        this.runner = this.opcodes.runInstruction;
        this.interrupt = 0;
        this._nmiSources = 0;
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
        return this._nmiSources !== 0;
    }

    nmiAsserted(source) {
        return (this._nmiSources & source) !== 0;
    }

    setNmi(source, level) {
        const wasAsserted = this._nmiSources !== 0;
        if (level) this._nmiSources |= source;
        else this._nmiSources &= ~source;
        if (!wasAsserted && this._nmiSources) this._nmiEdge = true;
    }

    /** Called as the NMI vector is taken, for devices that withdraw their request at that point. */
    nmiAcknowledged() {}

    polltime() {
        throw new Error("Must be overridden");
    }

    /** Takes a BRK, or an interrupt for `isIrq`, returning the vector it took. */
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
        let vector = IrqVector;
        if ((this.model.nmos || isIrq) && this._nmiEdge) {
            vector = NmiVector;
            this._nmiEdge = false;
            this.nmiAcknowledged();
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
                // TODO(#1063) check 65c12 BRK interrupt poll timing.
                this.checkInt();
                this.polltime(1);
            }
        }
        return vector;
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
    constructor(model, cpu, { cpuMultiplier = 1 } = {}) {
        super(model, { cycleAccurate: false });

        if (!(cpuMultiplier > 0)) throw new Error(`Tube CPU multiplier must be positive, got ${cpuMultiplier}`);

        this.cycles = 0;
        this.cyclesPerHostCycle = model.clockMhz / cpu.model.clockMhz;
        this.cpuMultiplier = cpuMultiplier;
        this.romPaged = true;
        this.memory = new Uint8Array(65536);
        this.rom = new Uint8Array(4096);

        this.tube = new Tube(cpu, this);
    }

    reset(hard) {
        this.romPaged = true;
        this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
        this.p.i = true;
        this.s = (this.s - 3) & 0xff; // Simulate 3 dummy pushes during reset
        // A latched NMI would otherwise survive the reset and be taken on the first instruction
        // after it, defeating the empty R3 FIFO the ULA seeds for exactly that reason.
        this._nmiSources = 0;
        this._nmiEdge = false;
        this.takeInt = false;
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

    nmiAcknowledged() {
        this.tube.acknowledgeNmi();
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
        this.cycles += cycles * this.cyclesPerHostCycle * this.cpuMultiplier;
        if (this.cycles < 3) return;
        while (this.cycles > 0) {
            const opcode = this.readmem(this.pc);
            this.incpc();
            this.runner.run(opcode);
            if (this.takeInt) this.brk(true);
        }
    }

    snapshotState({ includeRoms = false } = {}) {
        return {
            a: this.a,
            x: this.x,
            y: this.y,
            s: this.s,
            pc: this.pc,
            p: this.p.asByte(),
            nmiLevel: this.nmi,
            nmiEdge: this._nmiEdge,
            takeInt: this.takeInt,
            // The parasite has no scheduler of its own, so this is not relative to any epoch.
            cycles: this.cycles,
            romPaged: this.romPaged,
            memory: this.memory.slice(),
            rom: includeRoms ? this.rom.slice() : undefined,
            ula: this.tube.snapshotState(),
        };
    }

    restoreState(state) {
        this.a = state.a;
        this.x = state.x;
        this.y = state.y;
        this.s = state.s;
        this.pc = state.pc;
        this.p.setFromByte(state.p);
        this._nmiSources = state.nmiLevel ? NmiSource.tube : 0;
        this._nmiEdge = state.nmiEdge;
        this.takeInt = state.takeInt;
        this.cycles = state.cycles;
        this.romPaged = state.romPaged;
        this.memory.set(state.memory);
        if (state.rom) this.rom.set(state.rom);

        // After the registers, so the edge-triggered NMI moves from its saved level to the one
        // the ULA implies: no edge if they agree, and the edge it is owed if they do not.
        this.tube.restoreState(state.ula);
    }

    async loadOs() {
        console.log("Loading tube rom from roms/" + this.model.os);
        const tubeRom = this.rom;
        const data = await loadData("roms/" + this.model.os);
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

class DebugHook {
    constructor(cpu, functionName, { remembersStop = false } = {}) {
        this.cpu = cpu;
        this.functionName = functionName;
        this.remembersStop = remembersStop;
        this.handlers = [];
        this.calledAtStop = null;
    }

    add(handler) {
        this.handlers.push(handler);
        if (!this.cpu[this.functionName]) {
            this.cpu[this.functionName] = (...args) => {
                // remove() replaces the array, so a handler removing itself cannot make the loop skip the next one.
                const handlers = this.handlers;
                let stop = false;
                for (const hook of handlers) {
                    if (hook.apply(hook, args)) stop = true;
                }
                if (stop) {
                    if (this.remembersStop) this.calledAtStop = new Set(handlers);
                    this.cpu.stop();
                }
                return stop;
            };
            this.cpu.refreshLook();
        }
        handler.remove = () => this.remove(handler);
        return handler;
    }

    remove(handler) {
        const i = this.handlers.indexOf(handler);
        if (i < 0) throw "Unable to find debug hook handler";
        this.handlers = this.handlers.slice(0, i).concat(this.handlers.slice(i + 1));
        if (this.handlers.length === 0) {
            this.cpu[this.functionName] = null;
            this.cpu.refreshLook();
        }
    }

    clear() {
        this.handlers = [];
        this.cpu[this.functionName] = null;
        this.cpu.refreshLook();
    }

    get stopped() {
        return this.calledAtStop !== null;
    }

    forgetStop() {
        this.calledAtStop = null;
    }

    rememberUnseenStop() {
        this.calledAtStop = new Set();
    }

    /** Calls the handlers not called at the stop, with `cpu.resumingFromStop` set, ignoring any request to stop. */
    callRemaining(...args) {
        const called = this.calledAtStop;
        this.cpu.resumingFromStop = true;
        try {
            for (const handler of this.handlers) {
                if (!called.has(handler)) handler.apply(handler, args);
            }
        } finally {
            this.cpu.resumingFromStop = false;
        }
    }
}

function is1MHzAccess(addr) {
    const FEslowdown = [true, false, true, true, false, false, true, false];
    return addr >= 0xfc00 && addr < 0xff00 && (addr < 0xfe00 || FEslowdown[(addr >>> 5) & 7]);
}

export class Cpu6502 extends Base6502 {
    constructor(
        model,
        {
            dbgr,
            video,
            soundChip,
            ddNoise,
            relayNoise = new FakeRelayNoise(),
            music5000,
            cmos,
            config,
            econet,
            cycleAccurate = true,
        } = {},
    ) {
        super(model, { cycleAccurate });
        this.config = config;
        this.keyLayout = config.keyLayout;
        this.cmos = cmos;
        this.debugger = dbgr;

        this.video = video;
        this.crtc = this.video.crtc;
        this.ula = this.video.ula;
        this.soundChip = soundChip;
        this.music5000 = music5000;
        this.ddNoise = ddNoise;
        this.relayNoise = relayNoise;
        this.memStatOffsetByIFetchBank = 0;
        this.memStatOffset = 0;
        this.memStat = new Uint8Array(512);
        this.memLook = new Int32Array(512); // Cannot be unsigned as we use negative offsets
        this.readLook = new Int32Array(512).fill(SlowPathOffset);
        this.writeLook = new Int32Array(512).fill(SlowPathOffset);
        this.ramRomOs = new Uint8Array(this.memoryBytes);
        this.romOffset = RomOffset;
        this.osOffset = OsOffset;
        this.romsel = 0;
        this.acccon = 0;
        this.oldPcArray = new Uint16Array(256);
        this.oldAArray = new Uint8Array(256);
        this.oldXArray = new Uint8Array(256);
        this.oldYArray = new Uint8Array(256);
        this.oldPcIndex = 0;
        this.resetLine = true;
        this.zeroCycleChanges = 0;
        this.cpuMultiplier = this.config.cpuMultiplier;
        this.videoCyclesBatch = this.config.videoCyclesBatch | 0;
        this.peripheralCyclesPerSecond = model.cyclesPerSecond;
        this.hasTube = !!this.config.tube;
        this.hasMusic5000 = !!this.config.hasMusic5000;
        this.hasTeletextAdaptor = !!this.config.hasTeletextAdaptor;
        this.teletextAdaptor = this.hasTeletextAdaptor ? new TeletextAdaptor(this) : null;
        this.tube = this.hasTube
            ? new Tube6502(this.config.tube, this, { cpuMultiplier: this.config.tubeCpuMultiplier })
            : new FakeTube();
        this.music5000PageSel = 0;
        this.econet = econet;
        this.filestore = econet ? new Filestore(this, econet) : null;

        this.peripheralCycles = 0;
        this.videoCycles = 0;

        this.polltime = this.buildPolltime();
        this.is1MHzAccess = this.buildIs1MHzAccess();

        this._debugRead = this._debugWrite = this._debugInstruction = this._debugInterrupt = null;
        this.resumingFromStop = false;
        this.debugInstruction = new DebugHook(this, "_debugInstruction", { remembersStop: true });
        this.debugRead = new DebugHook(this, "_debugRead");
        this.debugWrite = new DebugHook(this, "_debugWrite");
        // Called with "irq" or "nmi" and the address the interrupt returns to, after an interrupt is taken.
        this.debugInterrupt = new DebugHook(this, "_debugInterrupt");
        this.breakpoints = new Breakpoints(this);

        this.scheduler = new Scheduler();
        this.sysvia = new via.SysVia(this, this.scheduler, {
            video: this.video,
            soundChip: this.soundChip,
            cmos: this.cmos,
            isMaster: this.model.isMaster,
            initialLayout: this.keyLayout,
            getGamepads: this.config.getGamepads,
        });
        this.uservia = new via.UserVia(this, this.scheduler, this.model.isMaster, this.config.userPort);
        this.acia = new Acia(this, this.soundChip.toneGenerator, this.scheduler, this.relayNoise);
        this.serial = new Serial(this.acia);
        this.keyboardInterface = this.sysvia;
        this.tapeInterface = this.acia;
        this.adconverter = new Adc(this.sysvia, this.scheduler);
        this.touchScreen = new TouchScreen(this.scheduler, this.model.cyclesPerSecond);
        this.soundChip.setScheduler(this.scheduler);
        this.fdc = new this.model.Fdc(this, this.ddNoise, this.scheduler);
    }

    get memoryBytes() {
        return BbcMemoryBytes;
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
        const bank = this.pagedBank;
        const offset = bank * RomBankBytes + this.romOffset - 0x8000;
        const swram = this.model.swram[bank] ? 1 : 2;
        this.mapBothHalves(0x80, 0xc0, swram, offset);
        if (this.model.isMaster && b & 0x80) {
            // 4Kb RAM (private RAM - ANDY)
            // Zero offset as 0x8000 mapped to 0x8000
            this.mapBothHalves(0x80, 0x90, 1, 0);
        }
    }

    /** The sideways bank ROMSEL pages in. */
    get pagedBank() {
        return this.bankPagedBy(this.romsel);
    }

    /** The sideways bank a ROM number, as ROMSEL takes it, pages in. */
    bankPagedBy(romNumber) {
        const { romSockets } = this.model;
        return NumRomBanks - romSockets + (romNumber & (romSockets - 1));
    }

    /**
     * Whether sideways `bank` is paged in and, at `address`, not hidden by the Master's ANDY RAM, which ROMSEL bit 7
     * pages over &8000 to &8FFF.
     */
    isBankPagedAt(bank, address) {
        const andyPaged = this.model.isMaster && (this.romsel & RomselAndy) !== 0;
        if (andyPaged && address >= AndyStart && address < AndyEnd) return false;
        return this.pagedBank === bank;
    }

    mapPages(start, end, stat, offset) {
        this.memStat.fill(stat, start, end);
        this.memLook.fill(offset, start, end);
        // While a debug hook is set, every access of its kind takes the slow path, which calls it.
        this.readLook.fill(stat && !this._debugRead ? offset : SlowPathOffset, start, end);
        this.writeLook.fill(stat === 1 && !this._debugWrite ? offset : SlowPathOffset, start, end);
    }

    mapBothHalves(fromPage, toPage, stat, offset) {
        this.mapPages(fromPage, toPage, stat, offset);
        this.mapPages(256 + fromPage, 256 + toPage, stat, offset);
    }

    refreshLook() {
        for (let i = 0; i < this.memStat.length; ++i) this.mapPages(i, i + 1, this.memStat[i], this.memLook[i]);
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
        // The "X" bit controls the "illegal" paging 20KB region overlay of LYNNE at 0x3000 - 0x7fff.
        const normal = bitX ? 0x8000 : 0;
        this.mapPages(0x30, 0x80, 1, normal);
        // Opcodes at 0xc000 - 0xdfff see shadow RAM by bit E, independent of bit X, unless HAZEL
        // is paged in there, when they see what normal access does.
        this.mapPages(256 + 0x30, 256 + 0x80, 1, bitY ? normal : bitE ? 0x8000 : 0);
        // The "Y" bit pages in HAZEL at c000->dfff. HAZEL is mapped in our RAM
        // at 0x9000, so (0x9000 - 0xc000) = -0x3000 is needed as an offset.
        const hazelRAM = bitY ? 1 : 2;
        const hazelOff = bitY ? -0x3000 : this.osOffset - 0xc000;
        this.mapBothHalves(0xc0, 0xe0, hazelRAM, hazelOff);
    }

    // Pages 0 and 1 are the same in both halves of the tables, so these skip memStatOffset.
    readmemZpStack(addr) {
        addr &= 0xffff;
        const offset = this.readLook[addr >>> 8];
        if (offset !== SlowPathOffset) return this.ramRomOs[offset + addr] | 0;
        return this.readmemSlow(addr);
    }

    writememZpStack(addr, b) {
        addr &= 0xffff;
        b |= 0;
        const offset = this.writeLook[addr >>> 8];
        if (offset !== SlowPathOffset) this.ramRomOs[offset + addr] = b;
        else this.writememSlow(addr, b);
    }

    // Handy debug function to read a string zero or \n terminated.
    readString(addr) {
        let s = "";
        for (;;) {
            const b = this.peekmem(addr);
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
                if (this.peekmem(addr + i) !== string.charCodeAt(i)) break;
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
            str += hexbyte(this.peekmem(addr + i));
        }
        return str;
    }

    econetStationId() {
        return this.econet ? this.econet.stationId : 0xff;
    }

    handleEconetStationId() {
        if (this.econet) this.setEconetNmiEnabled(false);
        return this.econetStationId();
    }

    handleEconetNmiEnable() {
        if (this.econet) this.setEconetNmiEnabled(true);
        return 0xff;
    }

    setEconetNmiEnabled(enabled) {
        this.econet.econetNMIEnabled = enabled;
        this.updateEconetNmi();
    }

    updateEconetNmi() {
        this.setNmi(NmiSource.econet, this.econet.nmi);
    }

    readDevice(addr) {
        if (this.model.isMaster && this.acccon & 0x40) {
            // TST bit of ACCCON
            return this.ramRomOs[this.osOffset + (addr & 0x3fff)];
        }
        addr &= 0xffff;

        switch (addr & ~0x0003) {
            case 0xfc10:
                if (this.hasTeletextAdaptor) return this.teletextAdaptor.read(addr - 0xfc10);
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
                if (addr === 0xfcff && this.hasMusic5000) return this.music5000PageSel;
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
            case 0xfe1c:
                if (!this.model.isMaster) return this.handleEconetStationId();
                break;
            case 0xfe20:
            case 0xfe2c:
                if (!this.model.isMaster) return this.handleEconetNmiEnable();
                break;
            case 0xfe24:
            case 0xfe28:
                return this.model.isMaster ? this.fdc.read(addr) : this.handleEconetNmiEnable();
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
                if (this.model.isMaster) return this.handleEconetNmiEnable();
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
            case 0xfea4:
            case 0xfea8:
            case 0xfeac:
            case 0xfeb0:
            case 0xfeb4:
            case 0xfeb8:
            case 0xfebc:
                if (this.econet) return this.econet.readRegister(addr & 3);
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

        if (this.hasMusic5000) {
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
        const offset = this.readLook[this.memStatOffset + (addr >>> 8)];
        if (offset !== SlowPathOffset) return this.ramRomOs[offset + addr] | 0;
        return this.readmemSlow(addr);
    }

    readmemSlow(addr) {
        const statOffset = this.memStatOffset + (addr >>> 8);
        let offset = 0;
        let res;
        if (this.memStat[statOffset]) {
            offset = this.memLook[statOffset];
            res = this.ramRomOs[offset + addr];
        } else {
            res = this.readDevice(addr);
        }
        if (this._debugRead) this._debugRead(addr, res, offset);
        return res | 0;
    }

    peekmem(addr) {
        return this._peekmemFor(this.memStatOffset, addr);
    }

    /**
     * Reads as code outside &C000-&DFFF sees memory, whatever ran last: on a Master in a shadow mode, the view of the
     * language, not of the VDU driver.
     */
    peekmemAsLanguage(addr) {
        return this._peekmemFor(0, addr);
    }

    _peekmemFor(memStatOffset, addr) {
        // Callers read on past $ffff (an instruction's operand, a dump's end) where the 6502 wraps to $0000.
        addr &= 0xffff;
        const statOffset = memStatOffset + (addr >>> 8);
        if (this.memStat[statOffset]) {
            const offset = this.memLook[statOffset];
            return this.ramRomOs[offset + addr];
        } else {
            return this.peekDevice(addr);
        }
    }

    /** Whether `addr` is a device's, rather than memory, as the machine is paged now. */
    isDevice(addr) {
        return this.memStat[this.memStatOffset + ((addr & 0xffff) >>> 8)] === 0;
    }

    /**
     * What readDevice would return, without its side effects. Devices with no way to read them without side
     * effects show UnpeekableDevice instead, and VIA ports show their pins as last driven (see Via.peek).
     */
    peekDevice(addr) {
        if (this.model.isMaster && this.acccon & 0x40) {
            return this.ramRomOs[this.osOffset + (addr & 0x3fff)];
        }
        addr &= 0xffff;
        const isMaster = this.model.isMaster;

        switch (addr & ~0x0003) {
            case 0xfc10:
                if (this.hasTeletextAdaptor) return UnpeekableDevice;
                break;
            case 0xfcfc:
                if (addr === 0xfcff && this.hasMusic5000) return this.music5000PageSel;
                break;
            case 0xfe00:
            case 0xfe04:
                return this.crtc.read(addr);
            case 0xfe10:
            case 0xfe14:
                return UnpeekableDevice;
            case 0xfe08:
            case 0xfe0c:
                return this.acia.peek(addr);
            case 0xfe18:
                return isMaster ? this.adconverter.peek(addr) : this.econetStationId();
            case 0xfe1c:
                if (!isMaster) return this.econetStationId();
                break;
            case 0xfe20:
            case 0xfe2c:
                if (!isMaster) return UnpeekableDevice;
                break;
            case 0xfe24:
            case 0xfe28:
                return isMaster ? this.fdc.peek(addr) : UnpeekableDevice;
            case 0xfe30:
                if (isMaster) return this.romsel & 0x8f;
                break;
            case 0xfe34:
                if (isMaster) return this.acccon;
                break;
            case 0xfe38:
                if (isMaster) return this.econetStationId();
                break;
            case 0xfe3c:
                if (isMaster) return UnpeekableDevice;
                break;
            case 0xfe40:
            case 0xfe44:
            case 0xfe48:
            case 0xfe4c:
            case 0xfe50:
            case 0xfe54:
            case 0xfe58:
            case 0xfe5c:
                return this.sysvia.peek(addr);
            case 0xfe60:
            case 0xfe64:
            case 0xfe68:
            case 0xfe6c:
            case 0xfe70:
            case 0xfe74:
            case 0xfe78:
            case 0xfe7c:
                return this.uservia.peek(addr);
            case 0xfe80:
            case 0xfe84:
            case 0xfe88:
            case 0xfe8c:
            case 0xfe90:
            case 0xfe94:
            case 0xfe98:
            case 0xfe9c:
                if (!isMaster) return this.fdc.peek(addr);
                break;
            case 0xfea0:
            case 0xfea4:
            case 0xfea8:
            case 0xfeac:
            case 0xfeb0:
            case 0xfeb4:
            case 0xfeb8:
            case 0xfebc:
                if (this.econet) return UnpeekableDevice;
                break;
            case 0xfec0:
            case 0xfec4:
            case 0xfec8:
            case 0xfecc:
            case 0xfed0:
            case 0xfed4:
            case 0xfed8:
            case 0xfedc:
                if (!isMaster) return this.adconverter.peek(addr);
                break;
            case 0xfee0:
            case 0xfee4:
            case 0xfee8:
            case 0xfeec:
            case 0xfef0:
            case 0xfef4:
            case 0xfef8:
            case 0xfefc:
                return this.hasTube ? UnpeekableDevice : this.tube.read(addr);
        }

        if (this.hasMusic5000) {
            if ((this.music5000PageSel & 0xf0) === 0x30 && (addr & 0xff00) === 0xfd00) {
                return this.music5000.read(this.music5000PageSel, addr) | 0;
            }
        }

        if (addr >= 0xfc00 && addr < 0xfe00) return 0xff;
        return addr >>> 8;
    }

    writemem(addr, b) {
        addr &= 0xffff;
        b |= 0;
        const offset = this.writeLook[this.memStatOffset + (addr >>> 8)];
        if (offset !== SlowPathOffset) this.ramRomOs[offset + addr] = b;
        else this.writememSlow(addr, b);
    }

    writememSlow(addr, b) {
        if (this._debugWrite) this._debugWrite(addr, b);
        const statOffset = this.memStatOffset + (addr >>> 8);
        const stat = this.memStat[statOffset];
        if (stat === 1) this.ramRomOs[this.memLook[statOffset] + addr] = b;
        else if (stat === 0) this.writeDevice(addr, b);
    }

    writeDevice(addr, b) {
        addr &= 0xffff;
        b |= 0;

        if (this.hasMusic5000 && (addr & 0xff00) === 0xfd00 && (this.music5000PageSel & 0xf0) === 0x30) {
            this.music5000.write(this.music5000PageSel, addr, b);
            return;
        }

        switch (addr & ~0x0003) {
            case 0xfc10:
                if (this.hasTeletextAdaptor) return this.teletextAdaptor.write(addr - 0xfc10, b);
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
                if (addr === 0xfcff && this.hasMusic5000) {
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
                if (this.econet) this.setEconetNmiEnabled(false);
                break;
            case 0xfe1c:
                if (!this.model.isMaster && this.econet) this.setEconetNmiEnabled(false);
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
                if (!this.model.isMaster) return this.romSelect(b);
                if (this.econet) this.setEconetNmiEnabled(false);
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
        console.log(`Loading ROM from ${name}`);
        this.ramRomOs.set(await romImage(name), offset);
    }

    /**
     * Loads the OS and then the model's sideways ROMs into the highest free banks, in order, an empty name leaving its
     * socket empty. The fittings' ROMs follow, into the empty sockets before any lower bank; then each of the config's
     * `bankRoms` goes into the bank it names, which must be free after those and named only once, and the config's
     * extra ROMs into the empty sockets and highest banks left.
     */
    async loadOs(os, ...modelRoms) {
        os = "roms/" + os;
        console.log(`Loading OS from ${os}`);
        const ramRomOs = this.ramRomOs;
        const data = await loadData(os);
        const len = data.length;
        if (len < RomBankBytes || len % RomBankBytes) throw new Error(`Broken OS ROM file (length=${len})`);
        ramRomOs.set(data.subarray(0, RomBankBytes), this.osOffset);
        const numExtraBanks = (len - RomBankBytes) / RomBankBytes;
        let romIndex = NumRomBanks - numExtraBanks;
        const filledBy = new Map();
        for (let i_1 = 0; i_1 < numExtraBanks; ++i_1) {
            const srcBase = RomBankBytes * (i_1 + 1);
            const destBase = this.romOffset + (romIndex + i_1) * RomBankBytes;
            ramRomOs.set(data.subarray(srcBase, srcBase + RomBankBytes), destBase);
            filledBy.set(romIndex + i_1, `a ROM from ${os}`);
        }
        const placed = [];
        const place = (bank, rom) => placed.push({ bank, rom });
        const { romSockets } = this.model;
        const lowestBank = NumRomBanks - romSockets;
        const nextFreeBank = (isTaken) => {
            romIndex--;
            while (isTaken(romIndex)) romIndex--;
            if (romIndex < lowestBank) throw new Error("Too many extra ROMs (no free sideways ROM banks)");
            return romIndex;
        };
        const isRam = (bank) => this.model.swram[bank];
        let emptySockets = [];
        for (const rom of modelRoms) {
            const bank = nextFreeBank(isRam);
            if (!rom) {
                emptySockets.push(bank);
                continue;
            }
            filledBy.set(bank, rom);
            place(bank, rom);
        }
        for (const rom of this.config.fittedRoms) {
            const bank = emptySockets.length ? emptySockets.shift() : nextFreeBank(isRam);
            filledBy.set(bank, rom);
            place(bank, rom);
        }
        const { bankRoms } = this.config;
        for (const { bank, rom } of bankRoms) {
            if (bank < lowestBank || bank >= NumRomBanks)
                throw new Error(
                    `Can't load ${rom} into ROM bank ${bank}: the ${this.model.name} has ${romSockets} ROM sockets, banks ${lowestBank} to ${NumRomBanks - 1}`,
                );
            if (filledBy.has(bank))
                throw new Error(`Can't load ${rom} into ROM bank ${bank}, which already holds ${filledBy.get(bank)}`);
            filledBy.set(bank, rom);
            place(bank, rom);
        }
        const isNamed = (bank) => bankRoms.some((named) => named.bank === bank);
        emptySockets = emptySockets.filter((bank) => !isNamed(bank));
        const isRamOrNamed = (bank) => isRam(bank) || isNamed(bank);
        for (const rom of this.config.extraRoms)
            place(emptySockets.length ? emptySockets.shift() : nextFreeBank(isRamOrNamed), rom);
        return await Promise.all(
            placed.map(({ bank, rom }) => this.loadRom(rom, this.romOffset + bank * RomBankBytes)),
        );
    }

    setReset(resetOn) {
        this.resetLine = !resetOn;
    }

    snapshotState({ includeRoms = false } = {}) {
        return {
            // CPU registers
            a: this.a,
            x: this.x,
            y: this.y,
            s: this.s,
            pc: this.pc,
            p: this.p.asByte(),
            nmiLevel: this.nmi,
            nmiEdge: this._nmiEdge,
            halted: this.halted,
            takeInt: this.takeInt,
            stoppedAtBreakpoint: this.debugInstruction.stopped,
            // Memory control
            romsel: this.romsel,
            acccon: this.acccon,
            videoDisplayPage: this.videoDisplayPage,
            // Cycle tracking
            currentCycles: this.currentCycles,
            targetCycles: this.targetCycles,
            cycleSeconds: this.cycleSeconds,
            peripheralCycles: this.peripheralCycles,
            videoCycles: this.videoCycles,
            music5000PageSel: this.music5000PageSel,
            ram: this.ramRomOs.slice(0, this.romOffset),
            roms: includeRoms ? this.ramRomOs.slice(this.romOffset, this.osOffset) : undefined,
            ...(includeRoms ? {} : this.packedSidewaysRam()),
            // Sub-component state
            scheduler: this.scheduler.snapshotState(),
            sysvia: this.sysvia.snapshotState(),
            uservia: this.uservia.snapshotState(),
            video: this.video.snapshotState(),
            soundChip: this.soundChip.snapshotState(),
            acia: this.acia.snapshotState(),
            adc: this.adconverter.snapshotState(),
            touchScreen: this.touchScreen.snapshotState(),
            fdc: this.fdc.snapshotState(),
            teletextAdaptor: this.teletextAdaptor ? this.teletextAdaptor.snapshotState() : undefined,
            tube: this.hasTube ? this.tube.snapshotState({ includeRoms }) : undefined,
        };
    }

    romBank(bank) {
        const start = this.romOffset + bank * RomBankBytes;
        return this.ramRomOs.subarray(start, start + RomBankBytes);
    }

    packedSidewaysRam() {
        const banks = new Map();
        this.model.swram.forEach((isRam, bank) => {
            if (isRam) banks.set(bank, this.romBank(bank));
        });
        return packSidewaysRam(banks);
    }

    restoreSidewaysRam(swram, swramBankMask) {
        let packedOffset = 0;
        for (let bank = 0; bank < NumRomBanks; ++bank) {
            if (!(swramBankMask & (1 << bank))) continue;
            this.romBank(bank).set(swram.subarray(packedOffset, packedOffset + RomBankBytes));
            packedOffset += RomBankBytes;
        }
    }

    restoreState(state) {
        ++this.zeroCycleChanges;
        // 1. Scheduler epoch first (so task offsets resolve correctly)
        this.scheduler.restoreState(state.scheduler);

        // 2. CPU registers
        this.a = state.a;
        this.x = state.x;
        this.y = state.y;
        this.s = state.s;
        this.pc = state.pc;
        this.p.setFromByte(state.p);
        // interrupt is rebuilt by sub-component restores (VIA updateIFR, ACIA updateIrq)
        this.interrupt = 0;
        this._nmiSources = 0;
        this.halted = state.halted;
        this.takeInt = state.takeInt;
        if (state.stoppedAtBreakpoint) this.debugInstruction.rememberUnseenStop();
        else this.debugInstruction.forgetStop();
        this.breakpoints.forgetSeen();

        // 3. Memory
        // Older snapshots saved 128KB of ram; only the first 64KB was ever mapped.
        this.ramRomOs.set(state.ram.subarray(0, this.romOffset));
        if (state.roms) {
            this.ramRomOs.set(state.roms.slice(0, NumRomBanks * RomBankBytes), this.romOffset);
        }
        if (state.swram) this.restoreSidewaysRam(state.swram, state.swramBankMask);
        this.videoDisplayPage = state.videoDisplayPage;
        this.music5000PageSel = state.music5000PageSel;

        // 4. Rebuild memStat/memLook from romsel/acccon
        this.romSelect(state.romsel);
        if (this.model.isMaster) this.writeAcccon(state.acccon);

        // 5. Cycle tracking
        this.currentCycles = state.currentCycles;
        this.targetCycles = state.targetCycles;
        this.cycleSeconds = state.cycleSeconds;
        this.peripheralCycles = state.peripheralCycles;
        this.videoCycles = state.videoCycles;

        // 6. Sub-components (these re-register scheduler tasks)
        this.sysvia.restoreState(state.sysvia);
        this.uservia.restoreState(state.uservia);
        this.video.restoreState(state.video);
        this.soundChip.restoreState(state.soundChip);
        this.acia.restoreState(state.acia);
        this.adconverter.restoreState(state.adc);
        if (this.teletextAdaptor && state.teletextAdaptor) this.teletextAdaptor.restoreState(state.teletextAdaptor);

        // Touchscreen state, added without a version bump. Absent from an older snapshot, whose
        // touchscreen keeps its current state, unpolled.
        if (state.touchScreen) this.touchScreen.restoreState(state.touchScreen);

        // FDC state (v2+). If absent (v1 snapshot), FDC keeps its current state, and the saved
        // level is the only record of its line.
        if (state.fdc) {
            this.fdc.restoreState(state.fdc);
        } else {
            this.setNmi(NmiSource.fdc, state.nmiLevel);
        }
        if (this.econet) this.updateEconetNmi();
        // After the devices have re-driven their lines, so a line coming back up is not an edge.
        this._nmiEdge = state.nmiEdge;

        // Tube state (v3+). Rather than leave the parasite running on state the host knows
        // nothing about, reset it; restoreSnapshot() rejects such a pairing before reaching here.
        if (this.hasTube) {
            if (state.tube) this.tube.restoreState(state.tube);
            else this.tube.reset(true);
        }
    }

    reset(hard) {
        if (hard) {
            this.setupMemoryMap();
            this.resetPeripherals(hard);
        } else {
            this.fdc.reset();
        }
        this.resetCpuState(hard);
    }

    // Override in subclasses for different memory maps.
    setupMemoryMap() {
        // On the Master, opcodes executing from 0xc000 - 0xdfff can optionally have their memory accesses
        // redirected to shadow RAM.
        this.memStatOffsetByIFetchBank = this.model.isMaster ? (1 << 0xc) | (1 << 0xd) : 0x0000;
        if (!this.model.isTest) {
            this.mapBothHalves(0, 0x80, 1, 0);
            this.romSelect(0);
            this.mapBothHalves(0xc0, 0x100, 2, this.osOffset - 0xc000);
            this.mapBothHalves(0xfc, 0xff, 0, 0);
        } else {
            // Test sets everything as RAM.
            this.mapBothHalves(0, 0x100, 1, 0);
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
        if (this.model.isMaster) this.writeAcccon(0);
    }

    // Override in subclasses for different peripheral sets.
    // Only called on hard reset.
    resetPeripherals() {
        if (this.config.printerPort)
            this.uservia.ca2changecallback = (level, output) => this.config.printerPort.outputStrobe(level, output);

        this.sysvia.reset();
        this.uservia.reset();
        this.acia.reset();
        this.serial.reset();
        this.ddNoise.spinDown();
        this.fdc.powerOnReset();
        this.adconverter.reset();

        this.touchScreen.reset();
    }

    // Universal CPU state reset. Shared by all machine types.
    resetCpuState(hard) {
        ++this.zeroCycleChanges;
        this.tube.reset(hard);
        if (hard) {
            this.targetCycles = 0;
            this.currentCycles = 0;
            this.cycleSeconds = 0;
        }
        this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
        this.p.i = true;
        this.s = (this.s - 3) & 0xff; // Simulate 3 dummy pushes during reset
        this._nmiEdge = false;
        this._nmiSources = 0;
        this.halted = false;
        this.debugInstruction.forgetStop();
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
        this.sysvia.setKeyLayout(this.keyLayout);
    }

    polltimeAddr(cycles, addr, isWrite) {
        cycles = cycles | 0;
        if (this.is1MHzAccess(addr, isWrite)) {
            cycles += 1 + ((cycles ^ this.currentCycles) & 1);
        }
        this.polltime(cycles);
    }

    // Bake in the 1MHz bus check at construction time. On the Master, ACCCON
    // TST (bit 6) remaps FRED, JIM, and SHEILA reads (&FC00-&FEFF) to the
    // internal 2MHz bus, but writes still go through the external 1MHz bus.
    // Non-Master machines just use the static address check with no ACCCON
    // awareness.
    buildIs1MHzAccess() {
        if (this.model.isMaster) {
            return (addr, isWrite) => {
                if (!isWrite && this.acccon & 0x40 && addr >= 0xfc00 && addr < 0xff00) return false;
                return is1MHzAccess(addr);
            };
        }
        return is1MHzAccess;
    }

    // Builds common code between polltimeSlow and polltimeFast
    buildPolltime() {
        const nop = (_cycles) => {};
        const tubeStuff = this.hasTube ? (cycles) => this.tube.execute(cycles) : nop;
        const teletextStuff = this.teletextAdaptor ? (cycles) => this.teletextAdaptor.polltime(cycles) : nop;
        const musicStuff = this.music5000 ? (cycles) => this.music5000.polltime(cycles) : nop;
        const econetStuff = this.econet
            ? (cycles) => {
                  const retrigger = this.econet.polltime(cycles);
                  if (retrigger) this.setNmi(NmiSource.econet, false);
                  this.updateEconetNmi();
                  this.filestore.polltime(cycles);
              }
            : nop;

        const commonStuff = (cycles) => {
            this.scheduler.polltime(cycles);
            tubeStuff(cycles);
            teletextStuff(cycles);
            musicStuff(cycles);
            econetStuff(cycles);
        };

        if (this.cpuMultiplier === 1 && this.videoCyclesBatch === 0) {
            // Simplest, common case where multiplier is 1 and batching is off.
            return (cycles) => {
                cycles |= 0;
                this.currentCycles += cycles;
                this.video.polltime(cycles);
                commonStuff(cycles);
            };
        } else {
            // Handle speedup case.
            return (cycles) => {
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
                commonStuff(cycles);
            };
        }
    }

    /**
     * Whether execute() runs executeInternalFast. Any tracing or debug hook needs the slower
     * executeInternal: the debug read or debug write might change tracing or other debugging while it runs.
     */
    get onFastPath() {
        return !(
            this.forceTracing ||
            this._debugInstruction ||
            this._debugRead ||
            this._debugWrite ||
            this._debugInterrupt
        );
    }

    execute(numCyclesToRun) {
        this.halted = false;
        this.targetCycles += numCyclesToRun;
        // To prevent issues with wrapping around / overflowing the accuracy that poxy Javascript numbers have,
        // find the smaller of the target and current cycles, and if that's over one second's worth; subtract
        // that from both, to keep the domain low (while accumulating seconds). Take care to preserve the bottom
        // bit though; as that encodes whether we're on an even or odd bus cycle.
        const smaller = Math.min(this.targetCycles, this.currentCycles) & 0xfffffffe;
        const cyclesPerSecond = this.model.cyclesPerSecond;
        if (smaller >= cyclesPerSecond) {
            this.targetCycles -= cyclesPerSecond;
            this.currentCycles -= cyclesPerSecond;
            this.cycleSeconds++;
        }
        if (!this.onFastPath) {
            return this.executeInternal();
        } else {
            if (this.currentCycles < this.targetCycles) this.debugInstruction.forgetStop();
            return this.executeInternalFast();
        }
    }

    executeInternal() {
        // Each instruction hook sees the instruction a debug stop halted before once, at the stop or on resume,
        // and none stops the machine at it again.
        let resuming = this.debugInstruction.stopped;
        while (!this.halted && this.currentCycles < this.targetCycles) {
            this.oldPcIndex = (this.oldPcIndex + 1) & 0xff;
            this.oldPcArray[this.oldPcIndex] = this.pc;
            this.memStatOffset = this.memStatOffsetByIFetchBank & (1 << (this.pc >>> 12)) ? 256 : 0;
            const opcode = this.readmem(this.pc);
            if (this._debugInstruction) {
                if (resuming) {
                    this.debugInstruction.callRemaining(this.pc, opcode);
                } else if (this._debugInstruction(this.pc, opcode)) {
                    return false;
                }
            }
            if (resuming) {
                this.debugInstruction.forgetStop();
                resuming = false;
            }
            this.incpc();
            this.runner.run(opcode);
            this.oldAArray[this.oldPcIndex] = this.a;
            this.oldXArray[this.oldPcIndex] = this.x;
            this.oldYArray[this.oldPcIndex] = this.y;
            if (opcode === BrkOpcode && this._debugInterrupt) this.checkBrkTakenByNmi(this.oldPcArray[this.oldPcIndex]);
            if (this.takeInt) {
                const returnsTo = this.pc;
                const taken = this.brk(true) === NmiVector ? "nmi" : "irq";
                // Stopped at the handler's first instruction, which no instruction hook then stops at again.
                if (this._debugInterrupt?.(taken, returnsTo)) this.debugInstruction.rememberUnseenStop();
            }
            if (!this.resetLine) this.reset(false);
        }
        return !this.halted;
    }

    /**
     * Tells the interrupt hook of an NMI that took over the BRK at `brkPc`, as one arriving part way through a BRK
     * does on the 6502: it shows as the BRK going to the NMI's handler rather than the IRQ's.
     */
    checkBrkTakenByNmi(brkPc) {
        const vectorAt = (address) => this.peekmem(address) | (this.peekmem(address + 1) << 8);
        const nmiHandler = vectorAt(NmiVector);
        if (this.pc !== nmiHandler || nmiHandler === vectorAt(IrqVector)) return;
        if (this._debugInterrupt("nmi", (brkPc + 2) & 0xffff)) this.debugInstruction.rememberUnseenStop();
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

    /** Runs `run` with every debug hook detached, so nothing it executes is seen by a hook or halts at one. */
    withoutDebugHooks(run) {
        const attached = [this._debugInstruction, this._debugRead, this._debugWrite, this._debugInterrupt];
        this._debugInstruction = this._debugRead = this._debugWrite = this._debugInterrupt = null;
        this.refreshLook();
        try {
            return run();
        } finally {
            [this._debugInstruction, this._debugRead, this._debugWrite, this._debugInterrupt] = attached;
            this.refreshLook();
        }
    }

    /** Changes the host key layout for the keyboard, and for every reset after it. */
    setKeyLayout(layout) {
        this.keyLayout = layout;
        this.sysvia.setKeyLayout(layout);
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
                    hexword(pc),
                    (dis + "                       ").substring(0, 15),
                    hexbyte(a),
                    hexbyte(x),
                    hexbyte(y),
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
        if (this.hasTube) {
            await this.tube.loadOs();
        }
        if (this.filestore) await this.filestore.load();
        this.reset(true);
        this.debugger.setCpu(this);
    }
}

// Acorn Atom memory map:
//   0x0000-0x7FFF  RAM (32KB, or 40KB with extensions up to 0x9FFF)
//   0x0A00-0x0AFF  FDC (8271) -- hole in RAM region
//   0x8000-0x9FFF  Video RAM (shared with MC6847 VDG)
//   0xA000-0xAFFF  Banked ROM/RAM (Branquart, 16 x 4KB banks via latch at 0xBFFF)
//   0xB000-0xB003  PPIA (8255)
//   0xB400-0xB40F  AtomMMC
//   0xB800-0xB80F  VIA (6522)
//   0xBFFF         Bank select latch (write-only)
//   0xC000-0xEFFF  ROM (BASIC, FP, DOS in 4KB blocks)
//   0xF000-0xFFFF  OS kernel ROM (4KB)
//
// Branquart banking: bits 0-3 of the latch at 0xBFFF select which 4KB
// bank is visible at 0xA000-0xAFFF. Banks can contain ROM or RAM.
// The latch is write-only; bit 6 is a lock bit.

const BranquartOffset = BbcMemoryBytes;
const BranquartBankSize = 0x1000; // 4KB per bank
const NumBranquartBanks = 16;
const AtomMemoryBytes = BranquartOffset + NumBranquartBanks * BranquartBankSize;
const AtomRomBlockSize = 0x1000; // 4KB

export class AtomCpu6502 extends Cpu6502 {
    get memoryBytes() {
        return AtomMemoryBytes;
    }

    setKeyLayout(layout) {
        this.keyLayout = layout;
        this.atomppia.setKeyLayout(layout);
    }

    constructor(model, options) {
        super(model, options);

        // Atom peripherals
        this.atomppia = new AtomPPIA(this, this.keyLayout, this.scheduler);
        this.atommc = new AtomMMC2(this);
        this.keyboardInterface = this.atomppia;
        this.tapeInterface = this.atomppia;

        // Branquart bank selection
        this.branquartLatch = 0;
        // Track which banks are ROM (false) vs RAM (true) for write protection.
        this.branquartRam = new Array(NumBranquartBanks).fill(true);

        // reset() and debugger.setCpu() are called by initialise() after loadOs().
    }

    // Select which Branquart bank is visible at 0xA000-0xAFFF by
    // updating the memLook table. This keeps reads on the fast path.
    selectBranquartBank(bank) {
        bank &= 0x0f;
        const offset = BranquartOffset + bank * BranquartBankSize - 0xa000;
        // ROM banks are read-only, RAM banks are writable
        const stat = this.branquartRam[bank] ? 1 : 2;
        this.mapBothHalves(0xa0, 0xb0, stat, offset);
    }

    setupMemoryMap() {
        this.memStatOffsetByIFetchBank = 0; // no shadow RAM on Atom

        // 0x0000-0x9FFF: RAM (including video RAM at 0x8000)
        this.mapBothHalves(0, 0xa0, 1, 0);

        // 0xA000-0xAFFF: Branquart banked region (set up via selectBranquartBank)
        this.branquartLatch = 0;
        this.selectBranquartBank(0);

        // 0xB000-0xBFFF: Device I/O (PPIA, MMC, VIA, bank latch)
        this.mapBothHalves(0xb0, 0xc0, 0, 0);

        // 0xC000-0xEFFF: ROM (4KB blocks loaded into romOffset area)
        this.mapBothHalves(0xc0, 0xf0, 2, this.romOffset - 0xa000);

        // 0xF000-0xFFFF: OS kernel ROM
        this.mapBothHalves(0xf0, 0x100, 2, this.osOffset - 0xf000);

        // FDC at 0x0A00 (device hole in RAM, if model uses FDC)
        if (this.model.Fdc) this.mapBothHalves(0x0a, 0x0b, 0, 0);

        // Randomise video RAM and seed bytes
        for (let i = 8; i < 13; ++i) this.ramRomOs[i] = (256 * Math.random()) | 0;
        for (let i = 0x8000; i < 0x9000; ++i) this.ramRomOs[i] = (256 * Math.random()) | 0;

        this.videoDisplayPage = 0;
    }

    resetPeripherals() {
        super.resetPeripherals();
        this.atomppia.reset();
        this.atommc.reset(true);
    }

    readDevice(addr) {
        addr &= 0xffff;
        switch (addr & ~0x0003) {
            case 0x0a00:
            case 0x0a04:
                return this.fdc.read(addr);
            case 0xb000:
            case 0xb004:
                return this.atomppia.read(addr);
            case 0xb008:
            case 0xb00c:
                return 0x00;
            case 0xb400:
            case 0xb404:
            case 0xb408:
            case 0xb40c:
                return this.atommc.read(addr);
            case 0xb800:
            case 0xb804:
            case 0xb808:
            case 0xb80c:
                return this.uservia.read(addr);
        }
        return addr >>> 8; // open bus
    }

    peekDevice(addr) {
        addr &= 0xffff;
        switch (addr & ~0x0003) {
            case 0x0a00:
            case 0x0a04:
                return this.fdc.peek(addr);
            case 0xb000:
            case 0xb004:
            case 0xb400:
            case 0xb404:
            case 0xb408:
            case 0xb40c:
                return UnpeekableDevice;
            case 0xb008:
            case 0xb00c:
                return 0x00;
            case 0xb800:
            case 0xb804:
            case 0xb808:
            case 0xb80c:
                return this.uservia.peek(addr);
        }
        return addr >>> 8;
    }

    writeDevice(addr, b) {
        addr &= 0xffff;
        b |= 0;
        switch (addr & ~0x0003) {
            case 0x0a00:
            case 0x0a04:
                return this.fdc.write(addr, b);
            case 0xb000:
            case 0xb004:
            case 0xb008:
            case 0xb00c:
                return this.atomppia.write(addr, b);
            case 0xb400:
            case 0xb404:
            case 0xb408:
            case 0xb40c:
                return this.atommc.write(addr, b);
            case 0xb800:
            case 0xb804:
            case 0xb808:
            case 0xb80c:
                return this.uservia.write(addr, b);
            case 0xbffc:
                if (addr === 0xbfff) {
                    this.branquartLatch = b & 0xff;
                    this.selectBranquartBank(b & 0x0f);
                }
                return;
        }
    }

    writemem(addr, b) {
        addr &= 0xffff;
        b |= 0;
        if (this._debugWrite) this._debugWrite(addr, b);
        const statOffset = this.memStatOffset + (addr >>> 8);
        const stat = this.memStat[statOffset];
        if (stat === 1) {
            // Notify VDG of CPU address bus activity for snow effect
            if (this.video.video6847) {
                this.video.video6847.cpuAddrAccess(addr);
            }
            const offset = this.memLook[statOffset];
            this.ramRomOs[offset + addr] = b;
            return;
        }
        if (stat === 2) return; // ROM: write ignored
        // Device page
        this.writeDevice(addr, b);
    }

    // Atom ROMs are 4KB, not 16KB like BBC.
    // OS layout: osOffset holds 4KB kernel at 0xF000.
    // Extra ROMs (BASIC, FP, DOS) are 4KB blocks at romOffset+0..romOffset+0x5000
    // mapped at 0xC000, 0xD000, 0xE000 etc.
    async loadOs(os) {
        if (this.config.bankRoms.length) throw new Error("The Atom has no sideways ROM banks to load a ROM into");
        const extraRoms = Array.prototype.slice
            .call(arguments, 1)
            .concat(this.config.fittedRoms, this.config.extraRoms);
        const bankRoms = this.model.banks || [];
        os = "roms/" + os;
        console.log(`Loading Atom OS from ${os}`);
        const data = await loadData(os);
        const len = data.length;

        if (len < AtomRomBlockSize || len % AtomRomBlockSize !== 0) {
            throw new Error(`Broken Atom ROM file (length=${len})`);
        }

        // Clear the OS area and load the kernel at osOffset (mapped to 0xF000)
        this.ramRomOs.fill(0x00, this.osOffset, this.osOffset + 0x4000);
        this.ramRomOs.set(data.subarray(0, AtomRomBlockSize), this.osOffset);

        // Load extra ROMs (BASIC, FP, DOS) into 4KB blocks.
        // romIndex counts down from 5: slot 4 maps to 0xE000 (romOffset+0x4000),
        // slot 3 to 0xD000 (romOffset+0x3000), slot 2 to 0xC000 (romOffset+0x2000).
        let romIndex = 5;
        const awaiting = [];
        for (const rom of extraRoms) {
            romIndex--;
            if (romIndex < 2)
                throw new Error("Too many extra ROMs for Atom (max 3 addressable slots at 0xC000-0xEFFF)");
            if (rom !== "") {
                awaiting.push(this.loadRom(rom, this.romOffset + romIndex * AtomRomBlockSize));
            }
        }

        // Load Branquart bank ROMs (max 16 banks)
        const numBanks = Math.min(bankRoms.length, NumBranquartBanks);
        for (let bankIndex = 0; bankIndex < numBanks; bankIndex++) {
            if (bankRoms[bankIndex] !== "") {
                awaiting.push(this.loadRom(bankRoms[bankIndex], BranquartOffset + bankIndex * BranquartBankSize));
                this.branquartRam[bankIndex] = false; // mark as ROM
            }
        }

        return await Promise.all(awaiting);
    }

    // Override loadRom to accept 4KB ROMs
    async loadRom(name, offset) {
        const data = await romImage(name);
        const len = data.length;
        if (len !== 16384 && len !== 8192 && len !== 4096) {
            throw new Error(`Broken ROM file ${name} (length=${len})`);
        }
        this.ramRomOs.set(data, offset);
    }

    // Atom key layout goes through PPIA, not SysVia
    updateKeyLayout() {
        this.atomppia.setKeyLayout(this.keyLayout);
    }

    snapshotState(options) {
        const state = super.snapshotState(options);
        // Atom-specific state
        state.branquartLatch = this.branquartLatch;
        state.branquartRam = [...this.branquartRam];
        // Save Branquart bank contents
        state.branquartBanks = this.ramRomOs.slice(
            BranquartOffset,
            BranquartOffset + NumBranquartBanks * BranquartBankSize,
        );
        state.atomppia = this.atomppia.snapshotState();
        return state;
    }

    // No-op: the Atom doesn't have BBC sideways ROM banking.
    // This prevents super.restoreState() from corrupting the Atom memory map.
    romSelect() {}

    restoreState(state) {
        super.restoreState(state);

        // Restore Atom-specific state after the parent has handled
        // CPU registers, memory, cycle tracking, and sub-components.
        if (state.branquartRam) this.branquartRam = [...state.branquartRam];
        if (state.branquartBanks) {
            this.ramRomOs.set(state.branquartBanks, BranquartOffset);
        }
        this.branquartLatch = state.branquartLatch || 0;
        this.selectBranquartBank(this.branquartLatch & 0x0f);
        if (state.atomppia) this.atomppia.restoreState(state.atomppia);
    }
}
