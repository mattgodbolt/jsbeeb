"use strict";
import * as utils from "./utils.js";

const hexword = utils.hexword;
const hexbyte = utils.hexbyte;
const signExtend = utils.signExtend;

function rotate(left, logical) {
    const lines = [];
    if (!left) {
        if (!logical) lines.push("const newTopBit = cpu.p.c ? 0x80 : 0x00;");
        lines.push("cpu.p.c = !!(REG & 0x01);");
        if (logical) {
            lines.push("REG >>>= 1;");
        } else {
            lines.push("REG = (REG >>> 1) | newTopBit;");
        }
    } else {
        if (!logical) lines.push("const newBotBit = cpu.p.c ? 0x01 : 0x00;");
        lines.push("cpu.p.c = !!(REG & 0x80);");
        if (logical) {
            lines.push("REG = (REG << 1) & 0xff;");
        } else {
            lines.push("REG = ((REG << 1) & 0xff) | newBotBit;");
        }
    }
    lines.push("cpu.p.setzn(REG);");
    return lines;
}

function pull(reg) {
    if (reg === "p") {
        return ["cpu.p.setFromByte(cpu.pull());"];
    }
    return [`cpu.${reg} = cpu.p.setzn(cpu.pull());`];
}

function push(reg) {
    if (reg === "p") return "cpu.push(cpu.p.asByte());";
    return `cpu.push(cpu.${reg});`;
}

class InstructionGen {
    constructor(is65c12) {
        this.is65c12 = is65c12;
        this.ops = {};
        this.cycle = 0;
    }

    appendOrPrepend(combiner, cycle, op, exact, addr) {
        if (op === undefined) {
            op = cycle;
            cycle = this.cycle;
        }
        exact = exact || false;
        if (typeof op === "string") op = [op];
        if (this.ops[cycle]) {
            this.ops[cycle].op = combiner(this.ops[cycle].op, op);
            if (exact) this.ops[cycle].exact = true;
            if (!this.ops[cycle].addr) this.ops[cycle].addr = addr;
        } else this.ops[cycle] = { op: op, exact: exact, addr: addr };
    }

    append(cycle, op, exact, addr) {
        this.appendOrPrepend((lhs, rhs) => lhs.concat(rhs), cycle, op, exact, addr);
    }

    prepend(cycle, op, exact, addr) {
        this.appendOrPrepend((lhs, rhs) => rhs.concat(lhs), cycle, op, exact, addr);
    }

    tick(cycles) {
        this.cycle += cycles || 1;
    }

    readOp(addr, reg, spurious) {
        this.cycle++;
        let op;
        if (reg) op = `${reg} = cpu.readmem(${addr});`;
        else op = `cpu.readmem(${addr});`;
        if (spurious) op += " // spurious";
        this.append(this.cycle, op, true, addr);
    }

    writeOp(addr, reg, spurious) {
        this.cycle++;
        let op = `cpu.writemem(${addr}, ${reg});`;
        if (spurious) op += " // spurious";
        this.append(this.cycle, op, true, addr);
    }

    zpReadOp(addr, reg) {
        this.cycle++;
        this.append(this.cycle, `${reg} = cpu.readmemZpStack(${addr});`, false);
    }

    zpWriteOp(addr, reg) {
        this.cycle++;
        this.append(this.cycle, `cpu.writememZpStack(${addr}, ${reg});`, true);
    }

    render(startCycle) {
        if (this.cycle < 2) this.cycle = 2;
        this.prepend(this.cycle - 1, "cpu.checkInt();", true);
        return this.renderInternal(startCycle);
    }

    spuriousOp(addr, reg) {
        if (this.is65c12) {
            this.readOp(addr, "", true);
        } else {
            this.writeOp(addr, reg, true);
        }
    }

    renderInternal(startCycle) {
        startCycle = startCycle || 0;
        let toSkip = 0;
        let out = [];
        for (let i = startCycle; i < this.cycle; ++i) {
            if (!this.ops[i]) {
                toSkip++;
                continue;
            }
            if (toSkip && this.ops[i].exact) {
                if (this.ops[i].addr) {
                    out.push(`cpu.polltimeAddr(${toSkip}, ${this.ops[i].addr});`);
                } else {
                    out.push(`cpu.polltime(${toSkip});`);
                }
                toSkip = 0;
            }
            out = out.concat(this.ops[i].op);
            toSkip++;
        }
        if (toSkip) {
            if (this.ops[this.cycle] && this.ops[this.cycle].addr) {
                out.push(`cpu.polltimeAddr(${toSkip}, ${this.ops[this.cycle].addr});`);
            } else {
                out.push(`cpu.polltime(${toSkip});`);
            }
        }
        if (this.ops[this.cycle]) out = out.concat(this.ops[this.cycle].op);
        return out.filter((l) => l);
    }

    split(condition) {
        return new SplitInstruction(this, condition, this.is65c12);
    }
}

class SplitInstruction {
    constructor(preamble, condition, is65c12) {
        this.preamble = preamble;
        this.condition = condition;
        this.ifTrue = new InstructionGen(is65c12);
        this.ifTrue.tick(preamble.cycle);
        this.ifFalse = new InstructionGen(is65c12);
        this.ifFalse.tick(preamble.cycle);

        ["append", "prepend", "readOp", "writeOp", "spuriousOp"].forEach((op) => {
            this[op] = (...args) => {
                this.ifTrue[op](...args);
                this.ifFalse[op](...args);
            };
        });
    }

    indent(lines) {
        return lines.map((line) => `  ${line}`);
    }

    render() {
        return this.preamble
            .renderInternal()
            .concat(`if (${this.condition}) {`)
            .concat(this.indent(this.ifTrue.render(this.preamble.cycle)))
            .concat("} else {")
            .concat(this.indent(this.ifFalse.render(this.preamble.cycle)))
            .concat("}");
    }
}

function getOp(op, arg) {
    switch (op) {
        case "NOP":
            return { op: "", read: arg !== undefined };
        case "BRK":
            return { op: "cpu.brk(false);" };
        case "CLC":
            return { op: "cpu.p.c = false;" };
        case "SEC":
            return { op: "cpu.p.c = true;" };
        case "CLD":
            return { op: "cpu.p.d = false;" };
        case "SED":
            return { op: "cpu.p.d = true;" };
        case "CLI":
            return { op: "cpu.p.i = false;" };
        case "SEI":
            return { op: "cpu.p.i = true;" };
        case "CLV":
            return { op: "cpu.p.v = false;" };
        case "LDA":
            return { op: ["cpu.a = cpu.p.setzn(REG);"], read: true };
        case "LDX":
            return { op: ["cpu.x = cpu.p.setzn(REG);"], read: true };
        case "LDY":
            return { op: ["cpu.y = cpu.p.setzn(REG);"], read: true };
        case "STA":
            return { op: "REG = cpu.a;", write: true };
        case "STX":
            return { op: "REG = cpu.x;", write: true };
        case "STY":
            return { op: "REG = cpu.y;", write: true };
        case "INC":
            return {
                op: ["REG = cpu.p.setzn(REG + 1);"],
                read: true,
                write: true,
            };
        case "DEC":
            return {
                op: ["REG = cpu.p.setzn(REG - 1);"],
                read: true,
                write: true,
            };
        case "INX":
            return { op: ["cpu.x = cpu.p.setzn(cpu.x + 1);"] };
        case "INY":
            return { op: ["cpu.y = cpu.p.setzn(cpu.y + 1);"] };
        case "DEX":
            return { op: ["cpu.x = cpu.p.setzn(cpu.x - 1);"] };
        case "DEY":
            return { op: ["cpu.y = cpu.p.setzn(cpu.y - 1);"] };
        case "ADC":
            return { op: "cpu.adc(REG);", read: true };
        case "SBC":
            return { op: "cpu.sbc(REG);", read: true };
        case "BIT":
            if (arg === "imm") {
                // According to: http://forum.6502.org/viewtopic.php?f=2&t=2241&p=27243#p27239
                // the v and n flags are unaffected by BIT #xx
                return { op: "cpu.p.z = !(cpu.a & REG);", read: true };
            }
            return {
                op: ["cpu.p.z = !(cpu.a & REG);", "cpu.p.v = !!(REG & 0x40);", "cpu.p.n = !!(REG & 0x80);"],
                read: true,
            };
        case "ROL":
            return { op: rotate(true, false), read: true, write: true, rotate: true };
        case "ROR":
            return {
                op: rotate(false, false),
                read: true,
                write: true,
                rotate: true,
            };
        case "ASL":
            return { op: rotate(true, true), read: true, write: true, rotate: true };
        case "LSR":
            return { op: rotate(false, true), read: true, write: true, rotate: true };
        case "EOR":
            return { op: ["cpu.a = cpu.p.setzn(cpu.a ^ REG);"], read: true };
        case "AND":
            return { op: ["cpu.a = cpu.p.setzn(cpu.a & REG);"], read: true };
        case "ORA":
            return { op: ["cpu.a = cpu.p.setzn(cpu.a | REG);"], read: true };
        case "CMP":
            return {
                op: ["cpu.p.setzn(cpu.a - REG);", "cpu.p.c = cpu.a >= REG;"],
                read: true,
            };
        case "CPX":
            return {
                op: ["cpu.p.setzn(cpu.x - REG);", "cpu.p.c = cpu.x >= REG;"],
                read: true,
            };
        case "CPY":
            return {
                op: ["cpu.p.setzn(cpu.y - REG);", "cpu.p.c = cpu.y >= REG;"],
                read: true,
            };
        case "TXA":
            return { op: ["cpu.a = cpu.p.setzn(cpu.x);"] };
        case "TAX":
            return { op: ["cpu.x = cpu.p.setzn(cpu.a);"] };
        case "TXS":
            return { op: "cpu.s = cpu.x;" };
        case "TSX":
            return { op: ["cpu.x = cpu.p.setzn(cpu.s);"] };
        case "TYA":
            return { op: ["cpu.a = cpu.p.setzn(cpu.y);"] };
        case "TAY":
            return { op: ["cpu.y = cpu.p.setzn(cpu.a);"] };
        case "BEQ":
            return { op: "cpu.branch(cpu.p.z);" };
        case "BNE":
            return { op: "cpu.branch(!cpu.p.z);" };
        case "BCS":
            return { op: "cpu.branch(cpu.p.c);" };
        case "BCC":
            return { op: "cpu.branch(!cpu.p.c);" };
        case "BMI":
            return { op: "cpu.branch(cpu.p.n);" };
        case "BPL":
            return { op: "cpu.branch(!cpu.p.n);" };
        case "BVS":
            return { op: "cpu.branch(cpu.p.v);" };
        case "BVC":
            return { op: "cpu.branch(!cpu.p.v);" };
        case "PLA":
            return { op: pull("a"), extra: 3 };
        case "PLP":
            return { op: pull("p"), extra: 3 };
        case "PLX":
            return { op: pull("x"), extra: 3 };
        case "PLY":
            return { op: pull("y"), extra: 3 };
        case "PHA":
            return { op: push("a"), extra: 2 };
        case "PHP":
            return { op: push("p"), extra: 2 };
        case "PHX":
            return { op: push("x"), extra: 2 };
        case "PHY":
            return { op: push("y"), extra: 2 };
        case "RTS":
            return {
                op: ["let temp = cpu.pull();", "temp |= cpu.pull() << 8;", "cpu.pc = (temp + 1) & 0xffff;"],
                extra: 5,
            };
        case "RTI":
            return {
                preop: [
                    "let temp = cpu.pull();",
                    "cpu.p.c = !!(temp & 0x01);",
                    "cpu.p.z = !!(temp & 0x02);",
                    "cpu.p.i = !!(temp & 0x04);",
                    "cpu.p.d = !!(temp & 0x08);",
                    "cpu.p.v = !!(temp & 0x40);",
                    "cpu.p.n = !!(temp & 0x80);",
                    "temp = cpu.pull();",
                    "cpu.pc = temp | (cpu.pull() << 8);",
                ],
                extra: 5,
            };
        case "JSR":
            return {
                op: [
                    "const pushAddr = cpu.pc - 1;",
                    "cpu.push(pushAddr >>> 8);",
                    "cpu.push(pushAddr & 0xff);",
                    "cpu.pc = addr;",
                ],
                extra: 3,
            };
        case "JMP":
            return { op: "cpu.pc = addr;" };

        // 65c12 opcodes
        case "TSB":
            return {
                op: ["cpu.p.z = !(REG & cpu.a);", "REG |= cpu.a;"],
                read: true,
                write: true,
            };
        case "TRB":
            return {
                op: ["cpu.p.z = !(REG & cpu.a);", "REG &= ~cpu.a;"],
                read: true,
                write: true,
            };
        case "BRA":
            return { op: "cpu.branch(true);" };
        case "STZ":
            return { op: "REG = 0;", write: true };

        // Undocumented opcodes.
        // first 3 used by Zalaga, http://stardot.org.uk/forums/viewtopic.php?f=2&t=3584&p=30514

        case "SAX": // stores (A AND X)
            return { op: "REG = cpu.a & cpu.x;", write: true };
        case "ASR": // aka ALR equivalent to AND #&AA:LSR A
            return {
                op: ["REG &= cpu.a;"].concat(rotate(false, true)).concat(["cpu.a = REG;"]),
            };
        case "SLO": // equivalent to ASL zp:ORA zp
            return {
                op: rotate(true, true).concat(["cpu.a |= REG;", "cpu.p.setzn(cpu.a);"]),
                read: true,
                write: true,
            };
        case "SHX":
            return { op: "REG = (cpu.x & ((addr >>> 8)+1)) & 0xff;", write: true, zpQuirk: true };
        case "SHY":
            return { op: "REG = (cpu.y & ((addr >>> 8)+1)) & 0xff;", write: true, zpQuirk: true };
        case "LAX": // NB uses the c64 value for the magic in the OR here. I don't know what would happen on a beeb.
            return {
                op: ["const magic = 0xff;", "cpu.a = cpu.x = cpu.p.setzn((cpu.a|magic) & REG);"],
                read: true,
            };
        case "LXA": // NB uses the c64 value for the magic in the OR here. I don't know what would happen on a beeb.
            return {
                op: ["const magic = 0xee;", "cpu.a = cpu.x = cpu.p.setzn((cpu.a|magic) & REG);"],
                read: true,
            };
        case "SRE":
            return {
                op: rotate(false, true).concat(["cpu.a = cpu.p.setzn(cpu.a ^ REG);"]),
                read: true,
                write: true,
            };
        case "RLA":
            return {
                op: rotate(true, false).concat(["cpu.a = cpu.p.setzn(cpu.a & REG);"]),
                read: true,
                write: true,
            };
        case "ANC":
            return {
                op: ["cpu.a = cpu.p.setzn(cpu.a & REG); cpu.p.c = cpu.p.n;"],
                read: true,
            };
        case "ANE":
            return {
                op: ["cpu.a = cpu.p.setzn((cpu.a | 0xee) & REG & cpu.x);"],
                read: true,
            };
        case "ARR":
            return { op: "cpu.arr(REG);", read: true };
        case "DCP":
            return {
                op: ["REG = cpu.p.setzn(REG - 1);", "cpu.p.setzn(cpu.a - REG);", "cpu.p.c = cpu.a >= REG;"],
                read: true,
                write: true,
            };
        case "LAS":
            return {
                op: ["cpu.a = cpu.x = cpu.s = cpu.p.setzn(cpu.s & REG);"],
                read: true,
            };
        case "RRA":
            return {
                op: rotate(false, false).concat(["cpu.adc(REG);"]),
                read: true,
                write: true,
            };
        case "SBX":
            return {
                op: ["const temp = cpu.a & cpu.x;", "cpu.p.c = temp >= REG;", "cpu.x = cpu.p.setzn(temp - REG);"],
                read: true,
            };
        case "SHA":
            return {
                op: ["REG = cpu.a & cpu.x & ((addr >>> 8) + 1) & 0xff;"],
                write: true,
                zpQuirk: true,
            };
        case "SHS":
            return {
                op: ["cpu.s = cpu.a & cpu.x;", "REG = cpu.a & cpu.x & ((addr >>> 8) + 1) & 0xff;"],
                write: true,
                zpQuirk: true,
            };
        case "ISB":
            return {
                op: ["REG = (REG + 1) & 0xff;", "cpu.sbc(REG);"],
                read: true,
                write: true,
            };
        case "RMB0":
        case "RMB1":
        case "RMB2":
        case "RMB3":
        case "RMB4":
        case "RMB5":
        case "RMB6":
        case "RMB7":
            return {
                op: [`REG = REG & (${~(1 << (op[3] - "0"))});`],
                read: true,
                write: true,
            };
        case "SMB0":
        case "SMB1":
        case "SMB2":
        case "SMB3":
        case "SMB4":
        case "SMB5":
        case "SMB6":
        case "SMB7":
            return {
                op: [`REG = REG | ${1 << (op[3] - "0")};`],
                read: true,
                write: true,
            };
        case "BBR0":
        case "BBR1":
        case "BBR2":
        case "BBR3":
        case "BBR4":
        case "BBR5":
        case "BBR6":
        case "BBR7":
            return { op: `cpu.branch(!(REG & ${1 << (op[3] - "0")}));`, read: true };
        case "BBS0":
        case "BBS1":
        case "BBS2":
        case "BBS3":
        case "BBS4":
        case "BBS5":
        case "BBS6":
        case "BBS7":
            return { op: `cpu.branch(REG & ${1 << (op[3] - "0")});`, read: true };
    }
    throw new Error(`Unrecognised operation '${op}'`);
}

const opcodes6502 = {
    0x00: "BRK",
    0x01: "ORA (,x)",
    0x03: "SLO (,x)",
    0x04: "NOP zp",
    0x05: "ORA zp",
    0x06: "ASL zp",
    0x07: "SLO zp",
    0x08: "PHP",
    0x09: "ORA imm",
    0x0a: "ASL A",
    0x0b: "ANC imm",
    0x0c: "NOP abs",
    0x0d: "ORA abs",
    0x0e: "ASL abs",
    0x0f: "SLO abs",
    0x10: "BPL branch",
    0x11: "ORA (),y",
    0x13: "SLO (),y",
    0x14: "NOP zp,x",
    0x15: "ORA zp,x",
    0x16: "ASL zp,x",
    0x17: "SLO zp,x",
    0x18: "CLC",
    0x19: "ORA abs,y",
    0x1a: "NOP",
    0x1b: "SLO abs,y",
    0x1c: "NOP abs,x",
    0x1d: "ORA abs,x",
    0x1e: "ASL abs,x",
    0x1f: "SLO abs,x",
    0x20: "JSR abs",
    0x21: "AND (,x)",
    0x23: "RLA (,x)",
    0x24: "BIT zp",
    0x25: "AND zp",
    0x26: "ROL zp",
    0x27: "RLA zp",
    0x28: "PLP",
    0x29: "AND imm",
    0x2a: "ROL A",
    0x2b: "ANC imm",
    0x2c: "BIT abs",
    0x2d: "AND abs",
    0x2e: "ROL abs",
    0x2f: "RLA abs",
    0x30: "BMI branch",
    0x31: "AND (),y",
    0x33: "RLA (),y",
    0x34: "NOP zp,x",
    0x35: "AND zp,x",
    0x36: "ROL zp,x",
    0x37: "RLA zp,x",
    0x38: "SEC",
    0x39: "AND abs,y",
    0x3a: "NOP",
    0x3b: "RLA abs,y",
    0x3c: "NOP abs,x",
    0x3d: "AND abs,x",
    0x3e: "ROL abs,x",
    0x3f: "RLA abs,x",
    0x40: "RTI",
    0x41: "EOR (,x)",
    0x43: "SRE (,x)",
    0x44: "NOP zp",
    0x45: "EOR zp",
    0x46: "LSR zp",
    0x47: "SRE zp",
    0x48: "PHA",
    0x49: "EOR imm",
    0x4a: "LSR A",
    0x4b: "ASR imm",
    0x4c: "JMP abs",
    0x4d: "EOR abs",
    0x4e: "LSR abs",
    0x4f: "SRE abs",
    0x50: "BVC branch",
    0x51: "EOR (),y",
    0x53: "SRE (),y",
    0x54: "NOP zp,x",
    0x55: "EOR zp,x",
    0x56: "LSR zp,x",
    0x57: "SRE zp,x",
    0x58: "CLI",
    0x59: "EOR abs,y",
    0x5a: "NOP",
    0x5b: "SRE abs,y",
    0x5c: "NOP abs,x",
    0x5d: "EOR abs,x",
    0x5e: "LSR abs,x",
    0x5f: "SRE abs,x",
    0x60: "RTS",
    0x61: "ADC (,x)",
    0x63: "RRA (,x)",
    0x64: "NOP zp",
    0x65: "ADC zp",
    0x66: "ROR zp",
    0x67: "RRA zp",
    0x68: "PLA",
    0x69: "ADC imm",
    0x6a: "ROR A",
    0x6b: "ARR imm",
    0x6c: "JMP (abs)",
    0x6d: "ADC abs",
    0x6e: "ROR abs",
    0x6f: "RRA abs",
    0x70: "BVS branch",
    0x71: "ADC (),y",
    0x73: "RRA (),y",
    0x74: "NOP zp,x",
    0x75: "ADC zp,x",
    0x76: "ROR zp,x",
    0x77: "RRA zp,x",
    0x78: "SEI",
    0x79: "ADC abs,y",
    0x7a: "NOP",
    0x7b: "RRA abs,y",
    0x7c: "NOP abs,x",
    0x7d: "ADC abs,x",
    0x7e: "ROR abs,x",
    0x7f: "RRA abs,x",
    0x80: "NOP imm",
    0x81: "STA (,x)",
    0x82: "NOP imm",
    0x83: "SAX (,x)",
    0x84: "STY zp",
    0x85: "STA zp",
    0x86: "STX zp",
    0x87: "SAX zp",
    0x88: "DEY",
    0x89: "NOP imm",
    0x8a: "TXA",
    0x8b: "ANE imm",
    0x8c: "STY abs",
    0x8d: "STA abs",
    0x8e: "STX abs",
    0x8f: "SAX abs",
    0x90: "BCC branch",
    0x91: "STA (),y",
    0x93: "SHA (),y",
    0x94: "STY zp,x",
    0x95: "STA zp,x",
    0x96: "STX zp,y",
    0x97: "SAX zp,y",
    0x98: "TYA",
    0x99: "STA abs,y",
    0x9a: "TXS",
    0x9b: "SHS abs,y",
    0x9c: "SHY abs,x",
    0x9d: "STA abs,x",
    0x9e: "SHX abs,y",
    0x9f: "SHA abs,y",
    0xa0: "LDY imm",
    0xa1: "LDA (,x)",
    0xa2: "LDX imm",
    0xa3: "LAX (,x)",
    0xa4: "LDY zp",
    0xa5: "LDA zp",
    0xa6: "LDX zp",
    0xa7: "LAX zp",
    0xa8: "TAY",
    0xa9: "LDA imm",
    0xaa: "TAX",
    0xab: "LXA imm",
    0xac: "LDY abs",
    0xad: "LDA abs",
    0xae: "LDX abs",
    0xaf: "LAX abs",
    0xb0: "BCS branch",
    0xb1: "LDA (),y",
    0xb3: "LAX (),y",
    0xb4: "LDY zp,x",
    0xb5: "LDA zp,x",
    0xb6: "LDX zp,y",
    0xb7: "LAX zp,y",
    0xb8: "CLV",
    0xb9: "LDA abs,y",
    0xba: "TSX",
    0xbb: "LAS abs,y",
    0xbc: "LDY abs,x",
    0xbd: "LDA abs,x",
    0xbe: "LDX abs,y",
    0xbf: "LAX abs,y",
    0xc0: "CPY imm",
    0xc1: "CMP (,x)",
    0xc2: "NOP imm",
    0xc3: "DCP (,x)",
    0xc4: "CPY zp",
    0xc5: "CMP zp",
    0xc6: "DEC zp",
    0xc7: "DCP zp",
    0xc8: "INY",
    0xc9: "CMP imm",
    0xca: "DEX",
    0xcb: "SBX imm",
    0xcc: "CPY abs",
    0xcd: "CMP abs",
    0xce: "DEC abs",
    0xcf: "DCP abs",
    0xd0: "BNE branch",
    0xd1: "CMP (),y",
    0xd3: "DCP (),y",
    0xd4: "NOP zp,x",
    0xd5: "CMP zp,x",
    0xd6: "DEC zp,x",
    0xd7: "DCP zp,x",
    0xd8: "CLD",
    0xd9: "CMP abs,y",
    0xda: "NOP",
    0xdb: "DCP abs,y",
    0xdc: "NOP abs,x",
    0xdd: "CMP abs,x",
    0xde: "DEC abs,x",
    0xdf: "DCP abs,x",
    0xe0: "CPX imm",
    0xe1: "SBC (,x)",
    0xe2: "NOP imm",
    0xe3: "ISB (,x)",
    0xe4: "CPX zp",
    0xe5: "SBC zp",
    0xe6: "INC zp",
    0xe7: "ISB zp",
    0xe8: "INX",
    0xe9: "SBC imm",
    0xea: "NOP",
    0xeb: "SBC imm",
    0xec: "CPX abs",
    0xed: "SBC abs",
    0xee: "INC abs",
    0xef: "ISB abs",
    0xf0: "BEQ branch",
    0xf1: "SBC (),y",
    0xf3: "ISB (),y",
    0xf4: "NOP zpx",
    0xf5: "SBC zp,x",
    0xf6: "INC zp,x",
    0xf7: "ISB zp,x",
    0xf8: "SED",
    0xf9: "SBC abs,y",
    0xfa: "NOP",
    0xfb: "ISB abs,y",
    0xfc: "NOP abs,x",
    0xfd: "SBC abs,x",
    0xfe: "INC abs,x",
    0xff: "ISB abs,x",
};

const opcodes65c12 = {
    0x00: "BRK",
    0x01: "ORA (,x)",
    0x04: "TSB zp",
    0x05: "ORA zp",
    0x06: "ASL zp",
    0x08: "PHP",
    0x09: "ORA imm",
    0x0a: "ASL A",
    0x0c: "TSB abs",
    0x0d: "ORA abs",
    0x0e: "ASL abs",
    0x10: "BPL branch",
    0x11: "ORA (),y",
    0x12: "ORA ()",
    0x14: "TRB zp",
    0x15: "ORA zp,x",
    0x16: "ASL zp,x",
    0x18: "CLC",
    0x19: "ORA abs,y",
    0x1a: "INC A",
    0x1c: "TRB abs",
    0x1d: "ORA abs,x",
    0x1e: "ASL abs,x",
    0x20: "JSR abs",
    0x21: "AND (,x)",
    0x24: "BIT zp",
    0x25: "AND zp",
    0x26: "ROL zp",
    0x28: "PLP",
    0x29: "AND imm",
    0x2a: "ROL A",
    0x2c: "BIT abs",
    0x2d: "AND abs",
    0x2e: "ROL abs",
    0x30: "BMI branch",
    0x31: "AND (),y",
    0x32: "AND ()",
    0x34: "BIT zp,x",
    0x35: "AND zp,x",
    0x36: "ROL zp,x",
    0x38: "SEC",
    0x39: "AND abs,y",
    0x3a: "DEC A",
    0x3c: "BIT abs,x",
    0x3d: "AND abs,x",
    0x3e: "ROL abs,x",
    0x40: "RTI",
    0x41: "EOR (,x)",
    0x45: "EOR zp",
    0x46: "LSR zp",
    0x48: "PHA",
    0x49: "EOR imm",
    0x4a: "LSR A",
    0x4c: "JMP abs",
    0x4d: "EOR abs",
    0x4e: "LSR abs",
    0x50: "BVC branch",
    0x51: "EOR (),y",
    0x52: "EOR ()",
    0x55: "EOR zp,x",
    0x56: "LSR zp,x",
    0x58: "CLI",
    0x59: "EOR abs,y",
    0x5a: "PHY",
    0x5d: "EOR abs,x",
    0x5e: "LSR abs,x",
    0x60: "RTS",
    0x61: "ADC (,x)",
    0x64: "STZ zp",
    0x65: "ADC zp",
    0x66: "ROR zp",
    0x68: "PLA",
    0x69: "ADC imm",
    0x6a: "ROR A",
    0x6c: "JMP (abs)",
    0x6d: "ADC abs",
    0x6e: "ROR abs",
    0x70: "BVS branch",
    0x71: "ADC (),y",
    0x72: "ADC ()",
    0x74: "STZ zp,x",
    0x75: "ADC zp,x",
    0x76: "ROR zp,x",
    0x78: "SEI",
    0x79: "ADC abs,y",
    0x7a: "PLY",
    0x7c: "JMP (abs,x)",
    0x7d: "ADC abs,x",
    0x7e: "ROR abs,x",
    0x80: "BRA branch",
    0x81: "STA (,x)",
    0x84: "STY zp",
    0x85: "STA zp",
    0x86: "STX zp",
    0x88: "DEY",
    0x89: "BIT imm",
    0x8a: "TXA",
    0x8c: "STY abs",
    0x8d: "STA abs",
    0x8e: "STX abs",
    0x90: "BCC branch",
    0x91: "STA (),y",
    0x92: "STA ()",
    0x94: "STY zp,x",
    0x95: "STA zp,x",
    0x96: "STX zp,y",
    0x98: "TYA",
    0x99: "STA abs,y",
    0x9a: "TXS",
    0x9c: "STZ abs",
    0x9d: "STA abs,x",
    0x9e: "STZ abs,x",
    0xa0: "LDY imm",
    0xa1: "LDA (,x)",
    0xa2: "LDX imm",
    0xa4: "LDY zp",
    0xa5: "LDA zp",
    0xa6: "LDX zp",
    0xa8: "TAY",
    0xa9: "LDA imm",
    0xaa: "TAX",
    0xac: "LDY abs",
    0xad: "LDA abs",
    0xae: "LDX abs",
    0xb0: "BCS branch",
    0xb1: "LDA (),y",
    0xb2: "LDA ()",
    0xb4: "LDY zp,x",
    0xb5: "LDA zp,x",
    0xb6: "LDX zp,y",
    0xb8: "CLV",
    0xb9: "LDA abs,y",
    0xba: "TSX",
    0xbc: "LDY abs,x",
    0xbd: "LDA abs,x",
    0xbe: "LDX abs,y",
    0xc0: "CPY imm",
    0xc1: "CMP (,x)",
    0xc4: "CPY zp",
    0xc5: "CMP zp",
    0xc6: "DEC zp",
    0xc8: "INY",
    0xc9: "CMP imm",
    0xca: "DEX",
    //0xCB: "WAI", // was "WAI" but testing by @tom-seddon indicate this isn't a 65c12 thing
    0xcc: "CPY abs",
    0xcd: "CMP abs",
    0xce: "DEC abs",
    0xd0: "BNE branch",
    0xd1: "CMP (),y",
    0xd2: "CMP ()",
    0xd5: "CMP zp,x",
    0xd6: "DEC zp,x",
    0xd8: "CLD",
    0xd9: "CMP abs,y",
    0xda: "PHX",
    0xdd: "CMP abs,x",
    0xde: "DEC abs,x",
    0xe0: "CPX imm",
    0xe1: "SBC (,x)",
    0xe4: "CPX zp",
    0xe5: "SBC zp",
    0xe6: "INC zp",
    0xe8: "INX",
    0xe9: "SBC imm",
    0xea: "NOP",
    0xec: "CPX abs",
    0xed: "SBC abs",
    0xee: "INC abs",
    0xf0: "BEQ branch",
    0xf1: "SBC (),y",
    0xf2: "SBC ()",
    0xf5: "SBC zp,x",
    0xf6: "INC zp,x",
    0xf8: "SED",
    0xf9: "SBC abs,y",
    0xfa: "PLX",
    0xfd: "SBC abs,x",
    0xfe: "INC abs,x",
};

const opcodes65c02 = {
    ...opcodes65c12,
    0x07: "RMB0 zp",
    0x17: "RMB1 zp",
    0x27: "RMB2 zp",
    0x37: "RMB3 zp",
    0x47: "RMB4 zp",
    0x57: "RMB5 zp",
    0x67: "RMB6 zp",
    0x77: "RMB7 zp",
    0x87: "SMB0 zp",
    0x97: "SMB1 zp",
    0xa7: "SMB2 zp",
    0xb7: "SMB3 zp",
    0xc7: "SMB4 zp",
    0xd7: "SMB5 zp",
    0xe7: "SMB6 zp",
    0xf7: "SMB7 zp",
    0x0f: "BBR0 zp,branch",
    0x1f: "BBR1 zp,branch",
    0x2f: "BBR2 zp,branch",
    0x3f: "BBR3 zp,branch",
    0x4f: "BBR4 zp,branch",
    0x5f: "BBR5 zp,branch",
    0x6f: "BBR6 zp,branch",
    0x7f: "BBR7 zp,branch",
    0x8f: "BBS0 zp,branch",
    0x9f: "BBS1 zp,branch",
    0xaf: "BBS2 zp,branch",
    0xbf: "BBS3 zp,branch",
    0xcf: "BBS4 zp,branch",
    0xdf: "BBS5 zp,branch",
    0xef: "BBS6 zp,branch",
    0xff: "BBS7 zp,branch",
};

class Disassemble6502 {
    constructor(cpu, opcodes) {
        this.cpu = cpu;
        this.opcodes = opcodes;
    }

    disassemble(addr, plain) {
        let formatAddr = (addr) => `<span class="instr_mem_ref" data-ref="${addr}">${hexword(addr)}</span>`;
        let formatJumpAddr = (addr) => `<span class="instr_instr_ref" data-ref="${addr}">${hexword(addr)}</span>`;
        if (plain) {
            formatAddr = hexword;
            formatJumpAddr = hexword;
        }
        const opcode = this.opcodes[this.cpu.peekmem(addr)];
        if (!opcode) {
            return ["???", addr + 1];
        }
        const split = opcode.split(" ");
        if (!split[1]) {
            return [opcode, addr + 1];
        }
        let param = split[1] || "";
        let suffix = "";
        let suffix2 = "";
        const index = param.match(/(.*),([xy])$/);
        if (index) {
            param = index[1];
            suffix = `,${index[2].toUpperCase()}`;
            suffix2 = ` + ${index[2].toUpperCase()}`;
        }
        switch (param) {
            case "imm":
                return [`${split[0]} #$${hexbyte(this.cpu.peekmem(addr + 1))}${suffix}`, addr + 2];
            case "abs": {
                const formatter = split[0] === "JMP" || split[0] === "JSR" ? formatJumpAddr : formatAddr;
                const destAddr = this.cpu.peekmem(addr + 1) | (this.cpu.peekmem(addr + 2) << 8);
                return [`${split[0]} $${formatter(destAddr)}${suffix}`, addr + 3, destAddr];
            }
            case "branch": {
                const destAddr = addr + signExtend(this.cpu.peekmem(addr + 1)) + 2;
                return [`${split[0]} $${formatJumpAddr(destAddr)}${suffix}`, addr + 2, destAddr];
            }
            case "zp":
                return [`${split[0]} $${hexbyte(this.cpu.peekmem(addr + 1))}${suffix}`, addr + 2];
            case "(,x)":
                return [`${split[0]} ($${hexbyte(this.cpu.peekmem(addr + 1))}, X)${suffix}`, addr + 2];
            case "()": {
                const zp = this.cpu.peekmem(addr + 1);
                const destAddr = this.cpu.peekmem(zp) | (this.cpu.peekmem(zp + 1) << 8);
                return [`${split[0]} ($${hexbyte(zp)})${suffix} ; $${utils.hexword(destAddr)}${suffix2}`, addr + 2];
            }
            case "(abs)": {
                const destAddr = this.cpu.peekmem(addr + 1) | (this.cpu.peekmem(addr + 2) << 8);
                const indDest = this.cpu.peekmem(destAddr) | (this.cpu.peekmem(destAddr + 1) << 8);
                return [
                    `${split[0]} ($${formatJumpAddr(destAddr)})${suffix} ; $${utils.hexword(indDest)}${suffix2}`,
                    addr + 3,
                    indDest,
                ];
            }
            case "(abs,x)": {
                const destAddr = this.cpu.peekmem(addr + 1) | (this.cpu.peekmem(addr + 2) << 8);
                const indDest = this.cpu.peekmem(destAddr) | (this.cpu.peekmem(destAddr + 1) << 8);
                return [`${split[0]} ($${formatJumpAddr(destAddr)},x)${suffix}`, addr + 3, indDest];
            }
        }
        return [opcode, addr + 1];
    }
}

function makeCpuFunctions(cpu, opcodes, is65c12) {
    function getInstruction(opcodeString, needsReg) {
        const split = opcodeString.split(" ");
        const opcode = split[0];
        const arg = split[1];
        const op = getOp(opcode, arg);
        if (!op) return null;

        let ig = new InstructionGen(is65c12);
        if (needsReg) ig.append("let REG = 0|0;");

        switch (arg) {
            case undefined:
                // Many of these ops need a little special casing.
                if (op.read || op.write) throw new Error(`Unsupported ${opcodeString}`);
                ig.append(op.preop);
                ig.tick(Math.max(2, 1 + (op.extra || 0)));
                ig.append(op.op);
                return ig.render();

            case "branch":
                return [op.op]; // special cased here, would be nice to pull out of cpu

            case "zp,branch":
                ig.tick(2);
                ig.append("const addr = cpu.getb() | 0;");
                if (op.read) {
                    ig.zpReadOp("addr", "REG");
                    if (op.write) {
                        ig.tick(1); // Spurious write
                    }
                }
                ig.append(op.op);
                if (op.write) ig.zpWriteOp("addr", "REG");
                return ig.render();

            case "zp":
            case "zpx": // Seems to be enough to keep tests happy, but needs investigation.
            case "zp,x":
            case "zp,y":
                if (arg === "zp") {
                    ig.tick(2);
                    ig.append("const addr = cpu.getb() | 0;");
                } else {
                    ig.tick(3);
                    ig.append(`const addr = (cpu.getb() + cpu.${arg[3]}) & 0xff;`);
                }
                if (op.read) {
                    ig.zpReadOp("addr", "REG");
                    if (op.write) {
                        ig.tick(1); // Spurious write
                    }
                }
                ig.append(op.op);
                if (op.write) ig.zpWriteOp("addr", "REG");
                return ig.render();

            case "abs":
                ig.tick(3 + (op.extra || 0));
                ig.append("const addr = cpu.getw() | 0;");
                if (op.read) {
                    ig.readOp("addr", "REG");
                    if (op.write) ig.spuriousOp("addr", "REG");
                }
                ig.append(op.op);
                if (op.write) ig.writeOp("addr", "REG");

                return ig.render();

            case "abs,x":
            case "abs,y":
                ig.append("const addr = cpu.getw() | 0;");
                ig.append(`let addrWithCarry = (addr + cpu.${arg[4]}) & 0xffff;`);
                ig.append("const addrNonCarry = (addr & 0xff00) | (addrWithCarry & 0xff);");
                ig.tick(3);
                ig = ig.split("addrWithCarry !== addrNonCarry");
                if (op.read && !op.write) {
                    if (is65c12) {
                        // the 65c12 reads the instruction byte again while it's carrying.
                        ig.ifTrue.tick(1);
                    } else {
                        // the 6502 reads the uncarried address
                        ig.ifTrue.readOp("addrNonCarry");
                    }
                    ig.readOp("addrWithCarry", "REG");
                } else if (op.read) {
                    if (is65c12) {
                        // RMWs on 65c12 burn a cycle reading the instruction byte again while carrying.
                        ig.ifTrue.tick(1);
                        // For anything but rotates, there's a bug: during carrying the CPU reads again.
                        // beebjit reads the carried address, but I can't see how that could be the case,
                        // so I read the non-carry here.
                        if (!op.rotate) ig.ifFalse.readOp("addrNonCarry", "REG");
                        ig.readOp("addrWithCarry", "REG");
                        ig.writeOp("addrWithCarry", "REG");
                    } else {
                        // For RMW we always have a spurious read and then a spurious read or write
                        ig.readOp("addrNonCarry");
                        ig.readOp("addrWithCarry", "REG");
                        ig.spuriousOp("addrWithCarry", "REG");
                    }
                } else if (op.write) {
                    if (is65c12) {
                        // Discovered on Stardot: https://stardot.org.uk/forums/viewtopic.php?f=55&t=25298&sid=86e65177447d407aa6510f1f98efca87&start=30
                        // With page crossing, the CPU re-reads the third byte of the instruction.
                        ig.ifTrue.tick(1);
                        // Without page crossing, the CPU still has the bug of reading the non-carried address(!)
                        ig.ifFalse.readOp("addrNonCarry");
                    } else {
                        // Pure stores still exhibit a read at the non-carried address.
                        ig.readOp("addrNonCarry");
                        if (op.zpQuirk) {
                            // with this quirk on undocumented instructions, a page crossing writes to 00XX
                            ig.append("if (addrWithCarry !== addrNonCarry) addrWithCarry &= 0xff;");
                        }
                    }
                }
                ig.append(op.op);
                if (op.write) ig.writeOp("addrWithCarry", "REG");
                return ig.render();

            case "imm":
                if (op.write) {
                    throw new Error("This isn't possible");
                }
                if (op.read) {
                    // NOP imm
                }
                ig.tick(2);
                ig.append("REG = cpu.getb() | 0;");
                ig.append(op.op);
                return ig.render();

            case "A":
                ig.tick(2);
                ig.append("REG = cpu.a;");
                ig.append(op.op);
                ig.append("cpu.a = REG;");
                return ig.render();

            case "(,x)":
                ig.tick(3); // two, plus one for the seemingly spurious extra read of zp
                ig.append("const zpAddr = (cpu.getb() + cpu.x) & 0xff;");
                ig.append("let lo, hi;");
                ig.zpReadOp("zpAddr", "lo");
                ig.zpReadOp("(zpAddr + 1) & 0xff", "hi");
                ig.append("const addr = lo | (hi << 8);");
                if (op.read) {
                    ig.readOp("addr", "REG");
                    if (op.write) ig.spuriousOp("addr", "REG");
                }
                ig.append(op.op);
                if (op.write) ig.writeOp("addr", "REG");
                return ig.render();

            case "(),y":
                ig.tick(2);
                ig.append("const zpAddr = cpu.getb() | 0;");
                ig.append("let lo, hi;");
                ig.zpReadOp("zpAddr", "lo");
                ig.zpReadOp("(zpAddr + 1) & 0xff", "hi");
                ig.append("const addr = lo | (hi << 8);");
                ig.append("let addrWithCarry = (addr + cpu.y) & 0xffff;");
                ig.append("const addrNonCarry = (addr & 0xff00) | (addrWithCarry & 0xff);");
                if (op.read && !op.write) {
                    // For non-RMW, we only pay the cost of the spurious read if the address carried on 6502
                    ig = ig.split("addrWithCarry !== addrNonCarry");
                    if (!is65c12) {
                        ig.ifTrue.readOp("addrNonCarry");
                    } else {
                        ig.ifTrue.tick(1);
                    }
                    ig.readOp("addrWithCarry", "REG");
                } else if (op.read) {
                    // For RMW we always have a spurious read and then a spurious read or write
                    ig.readOp("addrNonCarry");
                    ig.readOp("addrWithCarry", "REG");
                    ig.spuriousOp("addrWithCarry", "REG");
                } else if (op.write) {
                    // Pure stores still exhibit a read at the non-carried address.
                    ig.readOp("addrNonCarry");
                    if (op.zpQuirk) {
                        // with this quirk on undocumented instructions, a page crossing writes to 00XX
                        ig.append("if (addrWithCarry !== addrNonCarry) addrWithCarry &= 0xff;");
                    }
                }
                ig.append(op.op);
                if (op.write) ig.writeOp("addrWithCarry", "REG");
                return ig.render();

            case "(abs)":
                ig.tick(is65c12 ? 4 : 3);
                ig.append("const absAddr = cpu.getw() | 0;");
                if (is65c12) {
                    ig.append("const nextAddr = (absAddr + 1) & 0xffff;");
                } else {
                    ig.append("const nextAddr = ((absAddr + 1) & 0xff) | (absAddr & 0xff00);");
                }
                ig.append("let lo, hi;");
                ig.readOp("absAddr", "lo");
                ig.readOp("nextAddr", "hi");
                ig.append("const addr = lo | (hi << 8);");
                ig.append(op.op);
                return ig.render();

            case "(abs,x)":
                ig.tick(4);
                ig.append("const absAddr = (cpu.getw() + cpu.x) | 0;");
                ig.append("let lo, hi;");
                ig.readOp("absAddr", "lo");
                ig.readOp("(absAddr + 1) & 0xffff", "hi");
                ig.append("const addr = lo | (hi << 8);");
                ig.append(op.op);
                return ig.render();

            case "()":
                // Timing here is guessed at, but appears to be correct.
                ig.tick(2);
                ig.append("const zpAddr = cpu.getb() | 0;");
                ig.append("let lo, hi;");
                ig.zpReadOp("zpAddr", "lo");
                ig.zpReadOp("(zpAddr + 1) & 0xff", "hi");
                ig.append("const addr = lo | (hi << 8);");
                if (op.read) ig.readOp("addr", "REG");
                ig.append(op.op);
                if (op.write) ig.writeOp("addr", "REG");
                return ig.render();

            default:
                throw new Error(`Unknown arg type ${arg}`);
        }
    }

    function getIndentedSource(indent, opcodeNum, needsReg) {
        const opcode = opcodes[opcodeNum];
        return (
            indent +
            [
                '"use strict";',
                `// ${utils.hexbyte(opcodeNum)} - ${opcode}
`,
            ].concat(
                opcode
                    ? getInstruction(opcode, !!needsReg)
                    : [`this.invalidOpcode(cpu, 0x${utils.hexbyte(opcodeNum)});`],
            ).join(`
${indent}`)
        );
    }

    // Empty to hold prototypical stuff.
    function Runner() {}

    function generate6502JumpTable() {
        const funcs = [];
        for (let opcodeNum = 0; opcodeNum < 256; ++opcodeNum) {
            const opcodeFunc = new Function("cpu", getIndentedSource("  ", opcodeNum, true));
            let funcName = `exec_${utils.hexbyte(opcodeNum)}_`;
            if (opcodes[opcodeNum]) {
                const instrName = opcodes[opcodeNum]
                    .replace("()", "ind")
                    .replace("(,x)", "ind_x")
                    .replace("(abs)", "ind_abs")
                    .replace(/[^A-Za-z0-9]/g, "_")
                    .toLowerCase();
                funcName += instrName;
            } else funcName += "undef";
            Object.defineProperty(opcodeFunc, "name", { writable: true, value: funcName });
            funcs[opcodeNum] = opcodeFunc;
        }
        return function exec(opcode) {
            return funcs[opcode].call(this, this.cpu);
        };
    }

    function invalidOpcode(cpu, opcode) {
        if (is65c12) {
            // All undefined opcodes are NOPs on 65c12 (of varying lengths)
            // http://6502.org/tutorials/65c02opcodes.html has a list.
            // The default case is to treat them as one-cycle NOPs. Anything more than this is picked up below.
            switch (opcode) {
                case 0x02:
                case 0x22:
                case 0x42:
                case 0x62:
                case 0x82:
                case 0xc2:
                case 0xe2:
                    // two bytes, two cycles
                    cpu.getb();
                    cpu.polltime(2);
                    break;

                case 0x44:
                    // two bytes, three cycles
                    cpu.getb();
                    cpu.polltime(3);
                    break;

                case 0x54:
                case 0xd4:
                case 0xf4:
                    // two bytes, four cycles
                    cpu.getb();
                    cpu.polltime(4);
                    break;

                case 0x5c:
                    // three bytes, eight cycles
                    cpu.getw();
                    cpu.polltime(8);
                    break;

                case 0xdc:
                case 0xfc:
                    // three bytes, four cycles (plus a memory access)
                    cpu.polltimeAddr(4, cpu.getw());
                    break;

                default:
                    // one byte one cycle
                    cpu.polltime(1);
                    break;
            }
            return;
        }
        // Anything else is a HLT. Just hang forever...
        cpu.pc--; // Account for the fact we've already incremented pc.
        cpu.polltime(1); // Take up some time though. Else we'll spin forever
    }

    Runner.prototype.invalidOpcode = invalidOpcode;
    Runner.prototype.cpu = cpu;
    // We used to use jump tables for Firefox, and binary search for everything else.
    // Chrome used to have a problem with 256 entries in a switch, but that seems to have been fixed.
    // We now use a jump table for everything.
    Runner.prototype.run = generate6502JumpTable();

    return {
        disassembler: new Disassemble6502(cpu, opcodes),
        runInstruction: new Runner(),
        opcodes: opcodes,
        getInstruction: getInstruction,
    };
}

export function Cpu6502(cpu) {
    return makeCpuFunctions(cpu, opcodes6502, false);
}

export function Cpu65c12(cpu) {
    return makeCpuFunctions(cpu, opcodes65c12, true);
}

export function Cpu65c02(cpu) {
    return makeCpuFunctions(cpu, opcodes65c02, true);
}
