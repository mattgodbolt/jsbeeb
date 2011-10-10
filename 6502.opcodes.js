function replaceReg(lines, reg) {
    return lines.map(function(line) { return line.replace('REG', reg); });
}

function compileLoad(reg, arg) {
    // TODO: work out if this is valid for LDX and LDY. checkint/polltime differs in b-em.
    if (arg == 'imm') {
        return replaceReg([
            "cpu.REG = cpu.getb();",
            "cpu.setzn(cpu.REG);",
            "cpu.polltime(1);",
            "cpu.checkInt();",
            "cpu.polltime(1);",
        ], reg);
    } else if (arg == 'abs') {
        return replaceReg([
            "var addr = cpu.getw();",
            "cpu.polltime(4);",
            "cpu.checkInt();",
            "cpu.REG = cpu.readmem(addr);",
            "cpu.setzn(cpu.REG);"
        ], reg);
    }
}

function compileStore(reg, arg) {
    if (arg == 'abs') {
        return replaceReg([
                "var addr = cpu.getw();",
                "cpu.polltime(4);",
                "cpu.checkInt();",
                "cpu.writemem(addr, cpu.REG);"
                ], reg);
    }
}

function compileTransfer(from, to) {
    lines = ["cpu." + from + " = cpu." + to + ";"];
    if (to != "s") lines.push("cpu.setzn(" + to + ");");
    lines.push("cpu.polltime(2);");
    lines.push("cpu.checkInt();");
    return lines;
}

function compileAsl(arg) {
    if (arg == 'A') {
        return [
            "cpu.p.c = !!(cpu.a & 0x80);",
            "cpu.a = (cpu.a << 1) & 0xff;",
            "cpu.setzn(cpu.a);",
            "cpu.polltime(2);",
            "cpu.checkInt();"
                ];
    }
}

function compilePush(reg) {
    lines = [];
    if (reg == 'p') {
        lines.concat([
                "var temp = 0x30;",
                "if (cpu.p.c) temp |= 0x01;",
                "if (cpu.p.z) temp |= 0x02;",
                "if (cpu.p.i) temp |= 0x04;",
                "if (cpu.p.d) temp |= 0x08;",
                "if (cpu.p.v) temp |= 0x40;",
                "if (cpu.p.n) temp |= 0x80;"]);
        reg = 'temp';
    } else {
        reg = 'cpu.' + reg;
    }
    return lines.concat(replaceReg([
        "cpu.push(REG);",
        "cpu.polltime(3);",
        "cpu.checkInt()",  // TODO - PHY PHX don't check ints in b-em. bug?
        ], reg));
}

function compileBranch(condition) {
    switch (condition) {
    case "eq":
        return ["cpu.branch(cpu.p.z);"];
    case "ne":
        return ["cpu.branch(!cpu.p.z);"];
    }
}

function compileInstruction(opcodeString) {
    var split = opcodeString.split(' ');
    var opcode = split[0];
    var arg = split[1];
    var lines = null;
    var reg = opcode[2].toLowerCase();
    if (opcode.match(/^LD/)) {
        lines = compileLoad(reg, arg);
    } else if (opcode.match(/^ST/)) {
        lines = compileStore(reg, arg);
    } else if (opcode == "SEI") {
        lines = ["cpu.polltime(2);", "cpu.checkInt();", "cpu.p.i = true;"];
    } else if (opcode == "CLD") {
        lines = ["cpu.p.d = false;", "cpu.polltime(2);", "cpu.checkInt();"]
    } else if (opcode[0] == 'T') {
        lines = compileTransfer(opcode[1].toLowerCase(), opcode[2].toLowerCase());
    } else if (opcode == 'ASL') {
        lines = compileAsl(arg);
    } else if (opcode.match(/^PH/)) {
        lines = compilePush(reg);
    } else if (opcode == "BRK" || opcode == "BIT") {
        // todo
    } else if (opcode[0] == 'B') {
        lines = compileBranch(opcode.substr(1,2).toLowerCase());
    }
    if (!lines) return null;
    text = "compiled = function(cpu) {\n    " + lines.join("\n    ") + "\n}\n";
    console.log(text);
    eval(text);
    return compiled;
}

var opcodes6502 = {
    0x00: "BRK",
    0x01: "ORA (,x)",
    0x03: "SLO (,x)",
    0x04: "NOP zp",
    0x05: "ORA zp",
    0x06: "ASL zp",
    0x07: "SLO zp",
    0x08: "PHP",
    0x09: "ORA imm",
    0x0A: "ASL A",
    0x0B: "ANC imm",
    0x0C: "NOP abs",
    0x0D: "ORA abs",
    0x0E: "ASL abs",
    0x0F: "SLO abs",
    0x10: "BPL branch",
    0x11: "ORA (),y",
    0x13: "SLO (),y",
    0x14: "NOP zp,x",
    0x15: "ORA zp,x",
    0x16: "ASL zp,x",
    0x17: "SLO zp,x",
    0x18: "CLC",
    0x19: "ORA abs,y",
    0x1A: "NOP",
    0x1B: "SLO abs,y",
    0x1C: "NOP abs,x",
    0x1D: "ORA abs,x",
    0x1E: "ASL abs,x",
    0x1F: "SLO abs,x",
    0x20: "JSR",
    0x21: "AND (,x)",
    0x23: "RLA (,x)",
    0x24: "BIT zp",
    0x25: "AND zp",
    0x26: "ROL zp",
    0x27: "RLA zp",
    0x28: "PLP",
    0x29: "AND",
    0x2A: "ROL A",
    0x2B: "ANC imm",
    0x2C: "BIT abs",
    0x2D: "AND abs",
    0x2E: "ROL abs",
    0x2F: "RLA abs",
    0x30: "BMI branch",
    0x31: "AND (),y",
    0x33: "RLA (),y",
    0x34: "NOP zp,x",
    0x35: "AND zp,x",
    0x36: "ROL zp,x",
    0x37: "RLA zp,x",
    0x38: "SEC",
    0x39: "AND abs,y",
    0x3A: "NOP",
    0x3B: "RLA abs,y",
    0x3C: "NOP abs,x",
    0x3D: "AND abs,x",
    0x3E: "ROL abs,x",
    0x3F: "RLA abs,x",
    0x40: "RTI",
    0x41: "EOR (,x)",
    0x43: "SRE (,x)",
    0x44: "NOP zp",
    0x45: "EOR zp",
    0x46: "LSR zp",
    0x47: "SRE zp",
    0x48: "PHA",
    0x49: "EOR imm",
    0x4A: "LSR A",
    0x4B: "ASR imm",
    0x4C: "JMP",
    0x4D: "EOR abs",
    0x4E: "LSR abs",
    0x4F: "SRE abs",
    0x50: "BVC branch",
    0x51: "EOR (),y",
    0x53: "SRE (),y",
    0x54: "NOP zp,x",
    0x55: "EOR zp,x",
    0x56: "LSR zp,x",
    0x57: "SRE zp,x",
    0x58: "CLI",
    0x59: "EOR abs,y",
    0x5A: "NOP",
    0x5B: "SRE abs,y",
    0x5C: "NOP abs,x",
    0x5D: "EOR abs,x",
    0x5E: "LSR abs,x",
    0x5F: "SRE abs,x",
    0x60: "RTS",
    0x61: "ADC (,x)",
    0x63: "RRA (,x)",
    0x64: "NOP zp",
    0x65: "ADC zp",
    0x66: "ROR zp",
    0x67: "RRA zp",
    0x68: "PLA",
    0x69: "ADC imm",
    0x6A: "ROR A",
    0x6B: "ARR",
    0x6C: "JMP ()",
    0x6D: "ADC abs",
    0x6E: "ROR abs",
    0x6F: "RRA abs",
    0x70: "BVS branch",
    0x71: "ADC (),y",
    0x73: "RRA (,y)",
    0x74: "NOP zp,x",
    0x75: "ADC zp,x",
    0x76: "ROR zp,x",
    0x77: "RRA zp,x",
    0x78: "SEI",
    0x79: "ADC abs,y",
    0x7A: "NOP",
    0x7B: "RRA abs,y",
    0x7D: "ADC abs,x",
    0x7E: "ROR abs,x",
    0x7F: "RRA abs,x",
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
    0x8A: "TXA",
    0x8B: "ANE",
    0x8C: "STY abs",
    0x8D: "STA abs",
    0x8E: "STX abs",
    0x8F: "SAX abs",
    0x90: "BCC branch",
    0x91: "STA (),y",
    0x93: "SHA (),y",
    0x94: "STY zp,x",
    0x95: "STA zp,x",
    0x96: "STX zp,y",
    0x97: "SAX zp,y",
    0x98: "TYA",
    0x99: "STA abs,y",
    0x9A: "TXS",
    0x9B: "SHS abs,y",
    0x9C: "SHY abs,x",
    0x9D: "STA abs,x",
    0x9E: "SHX abs,y",
    0x9F: "SHA abs,y",
    0xA0: "LDY imm",
    0xA1: "LDA (,x)",
    0xA2: "LDX imm",
    0xA3: "LAX (,y)",
    0xA4: "LDY zp",
    0xA5: "LDA zp",
    0xA6: "LDX zp",
    0xA7: "LAX zp",
    0xA8: "TAY",
    0xA9: "LDA imm",
    0xAA: "TAX",
    0xAB: "LAX",
    0xAC: "LDY abs",
    0xAD: "LDA abs",
    0xAE: "LDX abs",
    0xAF: "LAX abs",
    0xB0: "BCS branch",
    0xB1: "LDA (),y",
    0xB3: "LAX (),y",
    0xB4: "LDY zp,x",
    0xB5: "LDA zp,x",
    0xB6: "LDX zp,y",
    0xB7: "LAX zp,y",
    0xB8: "CLV",
    0xB9: "LDA abs,y",
    0xBA: "TSX",
    0xBB: "LAS abs,y",
    0xBC: "LDY abs,x",
    0xBD: "LDA abs,x",
    0xBE: "LDX abs,y",
    0xBF: "LAX abs,y",
    0xC0: "CPY imm",
    0xC1: "CMP (,x)",
    0xC2: "NOP imm",
    0xC3: "DCP (,x)",
    0xC4: "CPY zp",
    0xC5: "CMP zp",
    0xC6: "DEC zp",
    0xC7: "DCP zp",
    0xC8: "INY",
    0xC9: "CMP imm",
    0xCA: "DEX",
    0xCB: "SBX imm",
    0xCC: "CPY abs",
    0xCD: "CMP abs",
    0xCE: "DEC abs",
    0xCF: "DCP abs",
    0xD0: "BNE branch",
    0xD1: "CMP (),y",
    0xD3: "DCP (),y",
    0xD4: "NOP zp,x",
    0xD5: "CMP zp,x",
    0xD6: "DEC zp,x",
    0xD7: "DCP zp,x",
    0xD8: "CLD",
    0xD9: "CMP abs,y",
    0xDA: "NOP",
    0xDB: "DCP abs,y",
    0xDC: "NOP abs,x",
    0xDD: "CMP abs,x",
    0xDE: "DEC abs,x",
    0xDF: "DCP abs,x",
    0xE0: "CPX imm",
    0xE1: "SBC (,x)",
    0xE2: "NOP imm",
    0xE3: "ISB (,x)",
    0xE4: "CPX zp",
    0xE5: "SBC zp",
    0xE6: "INC zp",
    0xE7: "ISB zp",
    0xE8: "INX",
    0xE9: "SBC imm",
    0xEA: "NOP",
    0xEB: "SBC imm",
    0xEC: "CPX abs",
    0xED: "SBC abs",
    0xEE: "INC abs",
    0xEF: "ISB abs",
    0xF0: "BEQ branch",
    0xF1: "SBC (),y",
    0xF3: "ISB (),y",
    0xF4: "NOP zpx",
    0xF5: "SBC zp,x",
    0xF6: "INC zp,x",
    0xF7: "ISB zp,x",
    0xF8: "SED",
    0xF9: "SBC abs,y",
    0xFA: "NOP",
    0xFB: "ISB abs,y",
    0xFC: "NOP abs,x",
    0xFD: "SBC abs,x",
    0xFE: "INC abs,x",
    0xFF: "ISB abs,x",
};

function generate6502() {
    functions = [];
    for (var i = 0; i < 256; ++i) {
        var opcode = opcodes6502[i];
        if (opcode) functions[i] = compileInstruction(opcode);
    }
    return functions;
}

function disassemble6502(addr) {
    var opcode = opcodes6502[this.readmem(addr)];
    if (!opcode) { return ["???", addr + 1]; }
    var split = opcode.split(" ");
    if (!split[1]) {
        return [opcode, addr + 1];
    }
    switch (split[1]) {
    case "imm":
        return [split[0] + " #$" + hexbyte(this.readmem(addr + 1)), addr + 2];
    case "abs":
        return [split[0] + " $" + hexword(this.readmem(addr + 1) | (this.readmem(addr+2)<<8)),
               addr + 3];
    case "branch":
        return [split[0] + " $" + hexword(addr + signExtend(this.readmem(addr + 1)) + 2),
               addr + 2];
    }
    return [opcode, addr + 1];
}
