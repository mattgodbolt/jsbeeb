define(['./utils', './6502.opcodes', './via', './acia', './serial', './tube', './adc', './scheduler', './touchscreen'],
    function (utils, opcodesAll, via, Acia, Serial, Tube, Adc, scheduler, TouchScreen) {
        "use strict";
        var hexword = utils.hexword;
        var signExtend = utils.signExtend;

        function Flags() {
            this.reset = function () {
                this.c = this.z = this.i = this.d = this.v = this.n = false;
            };
            this.debugString = function () {
                return (this.n ? "N" : "n") +
                    (this.v ? "V" : "v") +
                    "xx" +
                    (this.d ? "D" : "d") +
                    (this.i ? "I" : "i") +
                    (this.z ? "Z" : "z") +
                    (this.c ? "C" : "c");
            };

            this.asByte = function () {
                var temp = 0x30;
                if (this.c) temp |= 0x01;
                if (this.z) temp |= 0x02;
                if (this.i) temp |= 0x04;
                if (this.d) temp |= 0x08;
                if (this.v) temp |= 0x40;
                if (this.n) temp |= 0x80;
                return temp;
            };

            this.reset();
        }

        function base6502(cpu, model) {
            cpu.model = model;
            cpu.a = cpu.x = cpu.y = cpu.s = 0;
            cpu.pc = 0;
            cpu.opcodes = model.nmos ? opcodesAll.cpu6502(cpu) : opcodesAll.cpu65c12(cpu);
            cpu.disassembler = new cpu.opcodes.Disassemble(cpu);
            cpu.tracing = false;

            cpu.incpc = function () {
                cpu.pc = (cpu.pc + 1) & 0xffff;
            };

            cpu.getb = function () {
                var result = cpu.readmem(cpu.pc);
                cpu.incpc();
                return result | 0;
            };

            cpu.getw = function () {
                var result = cpu.readmem(cpu.pc) | 0;
                cpu.incpc();
                result |= (cpu.readmem(cpu.pc) | 0) << 8;
                cpu.incpc();
                return result | 0;
            };

            cpu.checkInt = function () {
                cpu.takeInt = !!(cpu.interrupt && !cpu.p.i);
                cpu.takeInt |= cpu.nmi;
            };

            cpu.setzn = function (v) {
                v &= 0xff;
                cpu.p.z = !v;
                cpu.p.n = !!(v & 0x80);
                return v | 0;
            };

            cpu.push = function (v) {
                cpu.writememZpStack(0x100 + cpu.s, v);
                cpu.s = (cpu.s - 1) & 0xff;
            };

            cpu.pull = function () {
                cpu.s = (cpu.s + 1) & 0xff;
                return cpu.readmemZpStack(0x100 + cpu.s);
            };

            cpu.NMI = function (nmi) {
                cpu.nmi = !!nmi;
            };

            cpu.brk = function (isIrq) {
                // Behavior here generally discovered via Visual 6502 analysis.
                // 6502 has a quirky BRK; it was sanitized in 65c12.
                // See also https://wiki.nesdev.com/w/index.php/CPU_interrupts
                var pushAddr = cpu.pc;
                if (!isIrq) pushAddr = (pushAddr + 1) & 0xffff;
                cpu.readmem(pushAddr);

                cpu.push(pushAddr >>> 8);
                cpu.push(pushAddr & 0xff);
                var pushFlags = cpu.p.asByte();
                if (isIrq) pushFlags &= ~0x10;
                cpu.push(pushFlags);

                // NMI status is determined part way through the BRK / IRQ
                // sequence, and yes, on 6502, an NMI can redirect the vector
                // for a half-way done BRK instruction.
                cpu.polltime(4);
                var vector = 0xfffe;
                if ((model.nmos || isIrq) && this.nmi) {
                    vector = 0xfffa;
                    cpu.nmi = false;
                }
                cpu.takeInt = false;
                cpu.pc = cpu.readmem(vector) | (cpu.readmem(vector + 1) << 8);
                cpu.p.i = true;
                if (model.nmos) {
                    cpu.polltime(3);
                } else {
                    cpu.p.d = false;
                    if (isIrq) {
                        cpu.polltime(3);
                    } else {
                        cpu.polltime(2);
                        // TODO: check 65c12 BRK interrupt poll timing.
                        cpu.checkInt();
                        cpu.polltime(1);
                    }
                }
            };

            cpu.branch = function (taken) {
                var offset = signExtend(cpu.getb());
                if (!taken) {
                    cpu.polltime(1);
                    cpu.checkInt();
                    cpu.polltime(1);
                    return;
                }
                var newPc = (cpu.pc + offset) & 0xffff;
                var pageCrossed = !!((cpu.pc & 0xff00) ^ (newPc & 0xff00));
                cpu.pc = newPc;
                if (!model.nmos) {
                    cpu.polltime(2 + pageCrossed);
                    cpu.checkInt();
                    cpu.polltime(1);
                } else if (!pageCrossed) {
                    cpu.polltime(1);
                    cpu.checkInt();
                    cpu.polltime(2);
                } else {
                    // 6502 polls twice during a taken branch with page
                    // crossing and either is sufficient to trigger IRQ.
                    // See https://wiki.nesdev.com/w/index.php/CPU_interrupts
                    cpu.polltime(1);
                    cpu.checkInt();
                    var sawInt = cpu.takeInt;
                    cpu.polltime(2);
                    cpu.checkInt();
                    cpu.takeInt |= sawInt;
                    cpu.polltime(1);
                }
            };

            function adcNonBCD(addend) {
                var result = (cpu.a + addend + (cpu.p.c ? 1 : 0));
                cpu.p.v = !!((cpu.a ^ result) & (addend ^ result) & 0x80);
                cpu.p.c = !!(result & 0x100);
                cpu.a = result & 0xff;
                cpu.setzn(cpu.a);
            }

            // For flags and stuff see URLs like:
            // http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f86911eaeaea&steps=16
            function adcBCD(addend) {
                var ah = 0;
                var tempb = (cpu.a + addend + (cpu.p.c ? 1 : 0)) & 0xff;
                cpu.p.z = !tempb;
                var al = (cpu.a & 0xf) + (addend & 0xf) + (cpu.p.c ? 1 : 0);
                if (al > 9) {
                    al -= 10;
                    al &= 0xf;
                    ah = 1;
                }
                ah += (cpu.a >>> 4) + (addend >>> 4);
                cpu.p.n = !!(ah & 8);
                cpu.p.v = !((cpu.a ^ addend) & 0x80) && !!((cpu.a ^ (ah << 4)) & 0x80);
                cpu.p.c = false;
                if (ah > 9) {
                    cpu.p.c = true;
                    ah -= 10;
                    ah &= 0xf;
                }
                cpu.a = ((al & 0xf) | (ah << 4)) & 0xff;
            }

            // With reference to c64doc: http://vice-emu.sourceforge.net/plain/64doc.txt
            // and http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f8e988eaeaea&steps=18
            function sbcBCD(subend) {
                var carry = cpu.p.c ? 0 : 1;
                var al = (cpu.a & 0xf) - (subend & 0xf) - carry;
                var ah = (cpu.a >>> 4) - (subend >>> 4);
                if (al & 0x10) {
                    al = (al - 6) & 0xf;
                    ah--;
                }
                if (ah & 0x10) {
                    ah = (ah - 6) & 0xf;
                }

                var result = cpu.a - subend - carry;
                cpu.p.n = !!(result & 0x80);
                cpu.p.z = !(result & 0xff);
                cpu.p.v = !!((cpu.a ^ result) & (subend ^ cpu.a) & 0x80);
                cpu.p.c = !(result & 0x100);
                cpu.a = al | (ah << 4);
            }

            function adcBCDcmos(addend) {
                cpu.polltime(1); // One more cycle, apparently
                var carry = cpu.p.c ? 1 : 0;
                var al = (cpu.a & 0xf) + (addend & 0xf) + carry;
                var ah = (cpu.a >>> 4) + (addend >>> 4);
                if (al > 9) {
                    al = (al - 10) & 0xf;
                    ah++;
                }
                cpu.p.v = !((cpu.a ^ addend) & 0x80) && !!((cpu.a ^ (ah << 4)) & 0x80);
                cpu.p.c = false;
                if (ah > 9) {
                    ah = (ah - 10) & 0xf;
                    cpu.p.c = true;
                }
                cpu.a = cpu.setzn(al | (ah << 4));
            }

            function sbcBCDcmos(subend) {
                cpu.polltime(1); // One more cycle, apparently
                var carry = cpu.p.c ? 0 : 1;
                var al = (cpu.a & 0xf) - (subend & 0xf) - carry;
                var result = cpu.a - subend - carry;
                if (result < 0) {
                    result -= 0x60;
                }
                if (al < 0) result -= 0x06;

                adcNonBCD(subend ^ 0xff); // For flags
                cpu.a = cpu.setzn(result);
            }

            if (model.nmos) {
                cpu.adc = function (addend) {
                    if (!cpu.p.d) {
                        adcNonBCD(addend);
                    } else {
                        adcBCD(addend);
                    }
                };

                cpu.sbc = function (subend) {
                    if (!cpu.p.d) {
                        adcNonBCD(subend ^ 0xff);
                    } else {
                        sbcBCD(subend);
                    }
                };
            } else {
                cpu.adc = function (addend) {
                    if (!cpu.p.d) {
                        adcNonBCD(addend);
                    } else {
                        adcBCDcmos(addend);
                    }
                };

                cpu.sbc = function (subend) {
                    if (!cpu.p.d) {
                        adcNonBCD(subend ^ 0xff);
                    } else {
                        sbcBCDcmos(subend);
                    }
                };
            }

            cpu.arr = function (arg) {
                // Insane instruction. I started with b-em source, but ended up using:
                // http://www.6502.org/users/andre/petindex/local/64doc.txt as reference,
                // tidying up as needed and fixing a couple of typos.
                if (cpu.p.d) {
                    var temp = cpu.a & arg;

                    var ah = temp >>> 4;
                    var al = temp & 0x0f;

                    cpu.p.n = cpu.p.c;
                    cpu.a = (temp >>> 1) | (cpu.p.c ? 0x80 : 0x00);
                    cpu.p.z = !cpu.a;
                    cpu.p.v = (temp ^ cpu.a) & 0x40;

                    if ((al + (al & 1)) > 5)
                        cpu.a = (cpu.a & 0xf0) | ((cpu.a + 6) & 0xf);

                    cpu.p.c = (ah + (ah & 1)) > 5;
                    if (cpu.p.c)
                        cpu.a = (cpu.a + 0x60) & 0xff;
                } else {
                    cpu.a = cpu.a & arg;
                    cpu.p.v = !!(((cpu.a >>> 7) ^ (cpu.a >>> 6)) & 0x01);
                    cpu.a >>>= 1;
                    if (cpu.p.c) cpu.a |= 0x80;
                    cpu.setzn(cpu.a);
                    cpu.p.c = !!(cpu.a & 0x40);
                }
            };

            cpu.runner = cpu.opcodes.runInstruction;
        }

        function Tube6502(model, cpu) {
            base6502(this, model);

            this.cycles = 0;
            this.romPaged = true;
            this.memory = new Uint8Array(65536);
            this.rom = new Uint8Array(4096);
            this.p = new Flags();

            this.tube = new Tube(cpu, this);

            this.reset = function (hard) {
                this.romPaged = true;
                this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
                this.p.i = true;
                this.tube.reset(hard);
            };

            this.readmem = function (offset) {
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
            };
            this.readmemZpStack = function (offset) {
                return this.memory[offset & 0xffff];
            };
            this.writemem = function (addr, b) {
                if ((addr & 0xfff8) === 0xfef8) {
                    return this.tube.parasiteWrite(addr, b);
                }
                this.memory[addr & 0xffff] = b;
            };
            this.writememZpStack = function (addr, b) {
                this.memory[addr & 0xffff] = b;
            };

            this.polltime = function (cycles) {
                this.cycles -= cycles;
            };
            this.polltimeAddr = this.polltime;

            this.read = function (addr) {
                return this.tube.hostRead(addr);
            };

            this.write = function (addr, b) {
                this.tube.hostWrite(addr, b);
            };

            this.execute = function (cycles) {
                this.cycles += cycles * 2;
                if (this.cycles < 3) return;
                while (this.cycles > 0) {
                    var opcode = this.readmem(this.pc);
                    this.incpc();
                    this.runner.run(opcode);
                    if (this.takeInt) this.brk(true);
                }
            };

            this.loadOs = function () {
                console.log("Loading tube rom from roms/" + model.os);
                var tubeRom = this.rom;
                return utils.loadData("roms/" + model.os).then(function (data) {
                    var len = data.length;
                    if (len !== 2048) throw new Error("Broken ROM file (length=" + len + ")");
                    for (var i = 0; i < len; ++i) {
                        tubeRom[i + 2048] = data[i];
                    }
                });
            };
        }

        function FakeTube() {
            this.read = function () {
                return 0xfe;
            };
            this.write = function () {
            };
            this.execute = function () {
            };
            this.reset = function () {
            };
        }

        function FakeUserPort() {
            return {
                write: function (val) {
                },
                read: function () {
                    return 0xff;
                }
            };
        }

        function fixUpConfig(config) {
            if (config === undefined) config = {};
            if (!config.keyLayout)
                config.keyLayout = "physical";
            if (!config.cpuMultiplier)
                config.cpuMultiplier = 1;
            if (!config.userPort)
                config.userPort = new FakeUserPort();
            if (config.printerPort === undefined)
                config.printerPort = null;
            config.extraRoms = config.extraRoms || [];
            return config;
        }

        return function Cpu6502(model, dbgr, video_, soundChip_, ddNoise_, cmos, config) {
            config = fixUpConfig(config);

            base6502(this, model);

            this.video = video_;
            this.soundChip = soundChip_;
            this.ddNoise = ddNoise_;
            this.memStatOffsetByIFetchBank = new Uint32Array(16);  // helps in master map of LYNNE for non-opcode read/writes
            this.memStatOffset = 0;
            this.memStat = new Uint8Array(512);
            this.memLook = new Int32Array(512);  // Cannot be unsigned as we use negative offsets
            this.ramRomOs = new Uint8Array(128 * 1024 + 17 * 16 * 16384);
            this.romOffset = 128 * 1024;
            this.osOffset = this.romOffset + 16 * 16 * 1024;
            this.romsel = 0;
            this.acccon = 0;
            this.interrupt = 0;
            this.FEslowdown = [true, false, true, true, false, false, true, false];
            this.oldPcArray = new Uint16Array(256);
            this.oldAArray = new Uint8Array(256);
            this.oldXArray = new Uint8Array(256);
            this.oldYArray = new Uint8Array(256);
            this.oldPcIndex = 0;
            this.resetLine = true;
            this.cpuMultiplier = config.cpuMultiplier;
            this.videoCyclesBatch = config.videoCyclesBatch | 0;
            this.peripheralCyclesPerSecond = 2 * 1000 * 1000;
            this.getPrevPc = function (index) {
                if (!this.tracing) throw new Error("Tracing not enabled");
                return this.oldPcArray[(this.oldPcIndex - index) & 0xff];
            };
            this.tube = model.tube ? new Tube6502(model.tube, this) : new FakeTube();

            // BBC Master memory map (within ramRomOs array):
            // 00000 - 08000 -> base 32KB RAM
            // 08000 - 09000 -> ANDY - 4KB
            // 09000 - 0b000 -> HAZEL - 8KB
            // 0b000 - 10000 -> LYNNE - 20KB

            this.romSelect = function (b) {
                var c;
                this.romsel = b;
                var bankOffset = ((b & 15) << 14) + this.romOffset;
                var offset = bankOffset - 0x8000;
                for (c = 128; c < 192; ++c) this.memLook[c] = this.memLook[256 + c] = offset;
                var swram = model.swram[b & 15] ? 1 : 2;
                for (c = 128; c < 192; ++c) this.memStat[c] = this.memStat[256 + c] = swram;
                if (model.isMaster && (b & 0x80)) {
                    // 4Kb RAM (private RAM - ANDY)
                    // Zero offset as 0x8000 mapped to 0x8000
                    for (c = 128; c < 144; ++c) {
                        this.memLook[c] = this.memLook[256 + c] = 0;
                        this.memStat[c] = this.memStat[256 + c] = 1;
                    }
                }
            };

            this.writeAcccon = function (b) {
                this.acccon = b;
                // ACCCON is
                // IRR TST IJF ITU  Y  X  E  D
                //  7   6   5   4   3  2  1  0

                // Video offset (to LYNNE) is controlled by the "D" bit of ACCCON.
                // LYNNE lives at 0xb000 in our map, but the offset we use here is 0x8000
                // as the video circuitry will already be looking at 0x3000 or so above
                // the offset.
                this.videoDisplayPage = (b & 1) ? 0x8000 : 0x0000;

                var bitE = !!(b & 2);
                var bitX = !!(b & 4);
                var bitY = !!(b & 8);
                var i;
                // The "X" bit controls the "illegal" paging 20KB region overlay of LYNNE.
                // This loop rewires which paged RAM 0x3000 - 0x7fff hits.
                for (i = 48; i < 128; ++i) {
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
                var hazelRAM = bitY ? 1 : 2;
                var hazelOff = bitY ? -0x3000 : this.osOffset - 0xc000;
                for (i = 192; i < 224; ++i) {
                    this.memLook[i] = this.memLook[i + 256] = hazelOff;
                    this.memStat[i] = this.memStat[i + 256] = hazelRAM;
                }
            };

            this._debugRead = this._debugWrite = this._debugInstruction = null;

            // Works for unpaged RAM only (ie stack and zp)
            this.readmemZpStack = function (addr) {
                addr &= 0xffff;
                var res = this.ramRomOs[addr];
                if (this._debugRead) this._debugRead(addr, 0, res);
                return res | 0;
            };
            this.writememZpStack = function (addr, b) {
                addr &= 0xffff;
                b |= 0;
                if (this._debugWrite) this._debugWrite(addr, b);
                this.ramRomOs[addr] = b;
            };

            // Handy debug function to read a string zero or \n terminated.
            this.readString = function (addr) {
                var s = "";
                for (; ;) {
                    var b = this.readmem(addr);
                    addr++;
                    if (b === 0 || b === 13) break;
                    s += String.fromCharCode(b);
                }
                return s;
            };

            this.findString = function (string, addr) {
                addr = addr | 0;
                for (; addr < 0xffff; ++addr) {
                    for (var i = 0; i < string.length; ++i) {
                        if (this.readmem(addr + i) !== string.charCodeAt(i)) break;
                    }
                    if (i === string.length) {
                        return addr;
                    }
                }
                return null;
            };

            this.readArea = function (addr, len) {
                var str = "";
                for (var i = 0; i < len; ++i) {
                    str += utils.hexbyte(this.readmem(addr + i));
                }
                return str;
            };

            this.is1MHzAccess = function (addr) {
                addr &= 0xffff;
                return (addr >= 0xfc00 && addr < 0xff00 && (addr < 0xfe00 || this.FEslowdown[(addr >>> 5) & 7]));
            };

            this.readDevice = function (addr) {
                if (model.isMaster && (this.acccon & 0x40)) {
                    // TST bit of ACCCON
                    return this.ramRomOs[this.osOffset + (addr & 0x3fff)];
                }
                addr &= 0xffff;
                switch (addr & ~0x0003) {
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
                        if (model.isMaster) return this.adconverter.read(addr);
                        break;
                    case 0xfe24:
                    case 0xfe28:
                        if (model.isMaster) return this.fdc.read(addr);
                        break;
                    case 0xfe30:
                        if (model.isMaster) return this.romsel & 0x8f;
                        break;
                    case 0xfe34:
                        if (model.isMaster) return this.acccon;
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
                        if (!model.isMaster)
                            return this.fdc.read(addr);
                        break;
                    case 0xfec0:
                    case 0xfec4:
                    case 0xfec8:
                    case 0xfecc:
                    case 0xfed0:
                    case 0xfed4:
                    case 0xfed8:
                    case 0xfedc:
                        if (!model.isMaster) return this.adconverter.read(addr);
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
                if (addr >= 0xfc00 && addr < 0xfe00) return 0xff;
                return addr >>> 8;
            };

            this.videoRead = function (addr) {
                return this.ramRomOs[addr | this.videoDisplayPage] | 0;
            };

            this.readmem = function (addr) {
                addr &= 0xffff;
                var res = 0;
                if (this.memStat[this.memStatOffset + (addr >>> 8)]) {
                    var offset = this.memLook[this.memStatOffset + (addr >>> 8)];
                    res = this.ramRomOs[offset + addr];
                    if (this._debugRead) this._debugRead(addr, res, offset);
                    return res | 0;
                } else {
                    res = this.readDevice(addr);
                    if (this._debugRead) this._debugRead(addr, res, 0);
                    return res | 0;
                }
            };

            this.peekmem = function (addr) {
                if (this.memStat[this.memStatOffset + (addr >>> 8)]) {
                    var offset = this.memLook[this.memStatOffset + (addr >>> 8)];
                    return this.ramRomOs[offset + addr];
                } else {
                    return 0xff;// TODO; peekDevice -- this.peekDevice(addr);
                }
            };

            this.writemem = function (addr, b) {
                addr &= 0xffff;
                b |= 0;
                if (this._debugWrite) this._debugWrite(addr, b);
                if (this.memStat[this.memStatOffset + (addr >>> 8)] === 1) {
                    var offset = this.memLook[this.memStatOffset + (addr >>> 8)];
                    this.ramRomOs[offset + addr] = b;
                    return;
                }
                if (addr < 0xfc00 || addr >= 0xff00) return;
                this.writeDevice(addr, b);
            };
            this.writeDevice = function (addr, b) {
                b |= 0;
                switch (addr & ~0x0003) {
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
                        if (this.isMaster)
                            return this.adconverter.write(addr, b);
                        break;
                    case 0xfe20:
                        return this.ula.write(addr, b);
                    case 0xfe24:
                    case 0xfe28:
                        if (model.isMaster) {
                            return this.fdc.write(addr, b);
                        }
                        return this.ula.write(addr, b);
                    case 0xfe2c:
                        if (!model.isMaster) {
                            return this.ula.write(addr, b);
                        }
                        break;
                    case 0xfe30:
                        return this.romSelect(b);
                    case 0xfe34:
                        if (model.isMaster) {
                            return this.writeAcccon(b);
                        }
                        return this.romSelect(b);
                    case 0xfe38:
                    case 0xfe3c:
                        if (!model.isMaster) {
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
                        if (!model.isMaster)
                            return this.fdc.write(addr, b);
                        break;
                    case 0xfec0:
                    case 0xfec4:
                    case 0xfec8:
                    case 0xfecc:
                    case 0xfed0:
                    case 0xfed4:
                    case 0xfed8:
                    case 0xfedc:
                        if (!model.isMaster)
                            return this.adconverter.write(addr, b);
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
            };

            this.loadRom = function (name, offset) {
                if (name.indexOf('http') !== 0)
                    name = "roms/" + name;
                console.log("Loading ROM from " + name);
                var ramRomOs = this.ramRomOs;
                return utils.loadData(name).then(function (data) {
                    var len = data.length;
                    if (len !== 16384 && len !== 8192) {
                        throw new Error("Broken rom file");
                    }
                    for (var i = 0; i < len; ++i) {
                        ramRomOs[offset + i] = data[i];
                    }
                });
            };

            this.loadOs = function (os) {
                var i;
                var extraRoms = Array.prototype.slice.call(arguments, 1).concat(config.extraRoms);
                os = "roms/" + os;
                console.log("Loading OS from " + os);
                var ramRomOs = this.ramRomOs;
                var capturedThis = this;
                return utils.loadData(os).then(function (data) {
                    var len = data.length;
                    if (len < 0x4000 || (len & 0x3fff)) throw new Error("Broken ROM file (length=" + len + ")");
                    for (i = 0; i < 0x4000; ++i) {
                        ramRomOs[capturedThis.osOffset + i] = data[i];
                    }
                    var numExtraBanks = (len - 0x4000) / 0x4000;
                    var romIndex = 16 - numExtraBanks;
                    for (i = 0; i < numExtraBanks; ++i) {
                        var srcBase = 0x4000 + 0x4000 * i;
                        var destBase = capturedThis.romOffset + (romIndex + i) * 0x4000;
                        for (var j = 0; j < 0x4000; ++j) {
                            ramRomOs[destBase + j] = data[srcBase + j];
                        }
                    }
                    var awaiting = [];

                    for (i = 0; i < extraRoms.length; ++i) {
                        romIndex--;
                        awaiting.push(capturedThis.loadRom(extraRoms[i], capturedThis.romOffset + romIndex * 0x4000));
                    }
                    return Promise.all(awaiting);
                });
            };

            this.setReset = function (resetOn) {
                this.resetLine = !resetOn;
            };

            this.reset = function (hard) {
                var i;
                if (hard) {
                    for (i = 0; i < 16; ++i) this.memStatOffsetByIFetchBank[i] = 0;
                    if (model.isMaster) {
                        // On the Master, opcodes exeucting from 0xc000 - 0xdfff
                        // can have optionally have their memory accesses
                        // redirected to shadow RAM.
                        this.memStatOffsetByIFetchBank[0xc] = 256;
                        this.memStatOffsetByIFetchBank[0xd] = 256;
                    }
                    if (!model.isTest) {
                        for (i = 0; i < 128; ++i) this.memStat[i] = this.memStat[256 + i] = 1;
                        for (i = 128; i < 256; ++i) this.memStat[i] = this.memStat[256 + i] = 2;
                        for (i = 0; i < 128; ++i) this.memLook[i] = this.memLook[256 + i] = 0;
                        for (i = 128; i < 192; ++i) this.memLook[i] = this.memLook[256 + i] = this.romOffset - 0x8000;
                        for (i = 192; i < 256; ++i) this.memLook[i] = this.memLook[256 + i] = this.osOffset - 0xc000;

                        for (i = 0xfc; i < 0xff; ++i) this.memStat[i] = this.memStat[256 + i] = 0;
                    } else {
                        // Test sets everything as RAM.
                        for (i = 0; i < 256; ++i) {
                            this.memStat[i] = this.memStat[256 + i] = 1;
                            this.memLook[i] = this.memLook[256 + i] = 0;
                        }
                    }
                    // DRAM content is not guaranteed to contain any particular
                    // value on start up, so we choose values that help avoid
                    // bugs in various games.
                    for (i = 0; i < this.romOffset; ++i) {
                        if (i < 0x100) {
                            // For Clogger.
                            this.ramRomOs[i] = 0x00;
                        } else {
                            // For Eagle Empire.
                            this.ramRomOs[i] = 0xff;
                        }
                    }
                    this.videoDisplayPage = 0;
                    this.scheduler = new scheduler.Scheduler();
                    this.soundChip.setScheduler(this.scheduler);
                    this.sysvia = via.SysVia(this, this.video, this.soundChip, cmos, model.isMaster, config.keyLayout);
                    this.uservia = via.UserVia(this, model.isMaster, config.userPort);
                    if (config.printerPort)
                        this.uservia.ca2changecallback = config.printerPort.outputStrobe;
                    this.touchScreen = new TouchScreen(this.scheduler);
                    this.acia = new Acia(this, this.soundChip.toneGenerator, this.scheduler, this.touchScreen);
                    this.serial = new Serial(this.acia);
                    this.ddNoise.spinDown();
                    this.fdc = new model.Fdc(this, this.ddNoise, this.scheduler);
                    this.crtc = this.video.crtc;
                    this.ula = this.video.ula;
                    this.adconverter = new Adc(this.sysvia, this.scheduler);
                    this.sysvia.reset(hard);
                    this.uservia.reset(hard);
                }
                this.tube.reset(hard);
                if (hard) {
                    this.targetCycles = 0;
                    this.currentCycles = 0;
                    this.cycleSeconds = 0;
                }
                this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
                this.p = new Flags();
                this.p.i = true;
                this.nmi = false;
                this.halted = false;
                this.video.reset(this, this.sysvia, hard);
                if (hard) this.soundChip.reset(hard);
            };

            this.updateKeyLayout = function () {
                this.sysvia.setKeyLayout(config.keyLayout);
            };

            this.polltimeAddr = function (cycles, addr) {
                cycles = cycles | 0;
                if (this.is1MHzAccess(addr)) {
                    cycles += 1 + ((cycles ^ this.currentCycles) & 1);
                }
                this.polltime(cycles);
            };

            this.peripheralCycles = 0;
            this.videoCycles = 0;

            // Slow version allows video batching and cpu multipliers
            this.polltimeSlow = function (cycles) {
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
                this.sysvia.polltime(cycles);
                this.uservia.polltime(cycles);
                this.scheduler.polltime(cycles);
                this.tube.execute(cycles);
            };

            // Faster, but more limited version
            this.polltimeFast = function (cycles) {
                cycles |= 0;
                this.currentCycles += cycles;
                this.video.polltime(cycles);
                this.sysvia.polltime(cycles);
                this.uservia.polltime(cycles);
                this.scheduler.polltime(cycles);
                this.tube.execute(cycles);
            };

            if (this.cpuMultiplier === 1 && this.videoCyclesBatch === 0) {
                this.polltime = this.polltimeFast;
            } else {
                this.polltime = this.polltimeSlow;
            }

            this.execute = function (numCyclesToRun) {
                this.halted = false;
                this.targetCycles += numCyclesToRun;
                // To prevent issues with wrapping around / overflowing the accuracy that poxy Javascript numbers have,
                // find the smaller of the target and current cycles, and if that's over one second's worth; subtract
                // that from both, to keep the domain low (while accumulating seconds). Take care to preserve the bottom
                // bit though; as that encodes whether we're on an even or odd bus cycle.
                var smaller = Math.min(this.targetCycles, this.currentCycles) & 0xfffffffe;
                if (smaller >= 2 * 1000 * 1000) {
                    this.targetCycles -= 2 * 1000 * 1000;
                    this.currentCycles -= 2 * 1000 * 1000;
                    this.cycleSeconds++;
                }
                // Any tracing or debugging means we need to run the potentially slower version: the debug read or
                // debug write might change tracing or other debugging while we're running.
                if (this.tracing || this._debugInstruction || this._debugRead || this._debugWrite) {
                    return this.executeInternal();
                } else {
                    return this.executeInternalFast();
                }
            };
            this.executeInternal = function () {
                var first = true;
                while (!this.halted && this.currentCycles < this.targetCycles) {
                    if (this.tracing) {
                        this.oldPcIndex = (this.oldPcIndex + 1) & 0xff;
                        this.oldPcArray[this.oldPcIndex] = this.pc;
                    }
                    this.memStatOffset = this.memStatOffsetByIFetchBank[this.pc >>> 12];
                    var opcode = this.readmem(this.pc);
                    if (this._debugInstruction && !first && this._debugInstruction(this.pc, opcode)) {
                        return false;
                    }
                    first = false;
                    this.incpc();
                    this.runner.run(opcode);
                    if (this.tracing) {
                        this.oldAArray[this.oldPcIndex] = this.a;
                        this.oldXArray[this.oldPcIndex] = this.x;
                        this.oldYArray[this.oldPcIndex] = this.y;
                    }
                    if (this.takeInt) this.brk(true);
                    if (!this.resetLine) this.reset(false);
                }
                return true;
            };
            this.executeInternalFast = function () {
                while (!this.halted && this.currentCycles < this.targetCycles) {
                    this.memStatOffset = this.memStatOffsetByIFetchBank[this.pc >>> 12];
                    var opcode = this.readmem(this.pc);
                    this.incpc();
                    this.runner.run(opcode);
                    if (this.takeInt) this.brk(true);
                    if (!this.resetLine) this.reset(false);
                }
                return true;
            };

            this.stop = function () {
                this.halted = true;
            };

            function DebugHook(cpu, functionName) {
                this.cpu = cpu;
                this.functionName = functionName;
                this.handlers = [];
                this.add = function (handler) {
                    var self = this;
                    this.handlers.push(handler);
                    if (!this.cpu[this.functionName]) {
                        this.cpu[this.functionName] = function () {
                            for (var i = 0; i < self.handlers.length; ++i) {
                                var handler = self.handlers[i];
                                if (handler.apply(handler, arguments)) {
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
                };
                this.remove = function (handler) {
                    var i = this.handlers.indexOf(handler);
                    if (i < 0) throw "Unable to find debug hook handler";
                    this.handlers = this.handlers.slice(0, i).concat(this.handlers.slice(i + 1));
                    if (this.handlers.length === 0) {
                        this.cpu[this.functionName] = null;
                    }
                };
            }

            this.debugInstruction = new DebugHook(this, '_debugInstruction');
            this.debugRead = new DebugHook(this, '_debugRead');
            this.debugWrite = new DebugHook(this, '_debugWrite');

            this.dumpTime = function (maxToShow, func) {
                if (!maxToShow) maxToShow = 256;
                if (maxToShow > 256) maxToShow = 256;
                var disassembler = this.disassembler;
                func = func || function (pc, a, x, y) {
                    var dis = disassembler.disassemble(pc, true)[0];
                    console.log(utils.hexword(pc),
                        (dis + "                       ").substr(0, 15),
                        utils.hexbyte(a),
                        utils.hexbyte(x),
                        utils.hexbyte(y));
                };
                for (var i = maxToShow - 2; i >= 0; --i) {
                    var j = (this.oldPcIndex - i) & 255;
                    func(this.oldPcArray[j], this.oldAArray[j], this.oldXArray[j], this.oldYArray[j]);
                }
                func(this.pc, this.a, this.x, this.y);
            };

            this.initialise = function () {
                var loadOsPromise = Promise.resolve();
                if (model.os.length) {
                    loadOsPromise = this.loadOs.apply(this, model.os);
                }
                var capturedThis = this;
                if (model.tube) {
                    loadOsPromise = loadOsPromise.then(function () {
                        return capturedThis.tube.loadOs();
                    });
                }
                return loadOsPromise.then(function () {
                    capturedThis.reset(true);
                    dbgr.setCpu(capturedThis);
                });
            };
        };
    }
);
