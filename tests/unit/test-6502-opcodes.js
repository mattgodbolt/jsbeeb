import { beforeEach, describe, expect, it } from "vitest";

import {
    Cpu6502 as cpu6502Opcodes,
    Cpu65c02 as cpu65c02Opcodes,
    Cpu65c12 as cpu65c12Opcodes,
} from "../../src/6502.opcodes.js";

describe("Disassemble6502", () => {
    const mem = new Uint8Array(0x10000);
    const disassembler = cpu6502Opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;

    beforeEach(() => {
        mem.fill(0xea);
    });

    it("steps forward by the instruction's length", () => {
        mem[0x2000] = 0xad;
        expect(disassembler.nextInstruction(0x2000)).toBe(0x2003);
        expect(disassembler.nextInstruction(0x2003)).toBe(0x2004);
    });

    it("wraps round from the bottom of memory", () => {
        expect(disassembler.prevInstruction(0x0000, 0x1000)).toBe(0xffff);
    });

    it("counts ORA as a common instruction", () => {
        for (let i = 0; i < 5; i++) {
            mem[0x1ff6 + i * 2] = 0x09;
            mem[0x1ff7 + i * 2] = 0x41;
        }
        expect(disassembler.prevInstruction(0x2000, 0x0000)).toBe(0x1ffe);
    });

    it("prefers any run that lands on the target over none, even one scoring nothing", () => {
        for (let i = 0; i < 8; i++) mem.set([0x9d, 0x00, 0x30], 0x1fe8 + i * 3);
        expect(disassembler.prevInstruction(0x2000, 0x0000)).toBe(0x1ffd);
    });

    it("discards runs through undocumented opcodes", () => {
        mem.set([0xa5, 0x41, 0xa5, 0xa9, 0x0f, 0xa9, 0x41], 0x1ff9);
        expect(disassembler.prevInstruction(0x2000, 0x0000)).toBe(0x1ffe);
    });

    it("keeps a run ending in a documented 65C02 instruction", () => {
        const disassembler65c02 = cpu65c02Opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
        mem.set([0x07, 0x41], 0x1ffe);
        expect(disassembler65c02.disassemble(0x1ffe)[0]).toMatch(/^RMB0/);
        expect(disassembler65c02.prevInstruction(0x2000, 0x0000)).toBe(0x1ffe);
    });

    describe("operands in the debugger's listing", () => {
        const memRef = (address, hex) => `<span class="instr_mem_ref" data-ref="${address}">$${hex}</span>`;
        const instrRef = (address, hex) => `<span class="instr_instr_ref" data-ref="${address}">$${hex}</span>`;

        it.each([
            ["absolute", [0x8d, 0x40, 0xfe], `STA ${memRef(0xfe40, "fe40")}`],
            ["zero page", [0xa5, 0xf2], `LDA ${memRef(0xf2, "f2")}`],
            ["zero page indexed", [0xb5, 0x70], `LDA ${memRef(0x70, "70")},X`],
            ["indexed indirect", [0xa1, 0x70], `LDA (${memRef(0x70, "70")}, X)`],
            ["indirect indexed", [0xb1, 0xf2], `LDA (${memRef(0xf2, "f2")}),Y ; $eaea + Y`],
            ["a call", [0x20, 0xee, 0xff], `JSR ${instrRef(0xffee, "ffee")}`],
            ["an indirect jump", [0x6c, 0x0e, 0x02], `JMP (${instrRef(0x20e, "020e")}) ; $eaea`],
            ["a branch", [0xd0, 0x10], `BNE ${instrRef(0x2012, "2012")}`],
        ])("wraps a reference round the whole of %s operand", (_, bytes, listing) => {
            mem.set(bytes, 0x2000);
            expect(disassembler.disassemble(0x2000)[0]).toBe(listing);
        });

        it("wraps a branch's target round the top of memory, as the CPU does", () => {
            mem.set([0xd0, 0x10], 0xfff8);
            expect(disassembler.disassemble(0xfff8)).toEqual([`BNE ${instrRef(0x0a, "000a")}`, 0xfffa, 0x0a]);
        });

        it("keeps references out of the plain listing", () => {
            mem.set([0xb1, 0xf2], 0x2000);
            expect(disassembler.disassemble(0x2000, true)[0]).toBe("LDA ($f2),Y ; $eaea + Y");
        });
    });

    describe("what an instruction does", () => {
        const at = (mnemonic, mode, length, accesses, flow, extra) => ({
            mnemonic,
            mode,
            length,
            accesses,
            flow,
            next: 0x2000 + length,
            ...extra,
        });

        it.each([
            ["LDA #", cpu6502Opcodes, [0xa9, 0x41], at("LDA", "imm", 2, [], "next")],
            ["LDA zp", cpu6502Opcodes, [0xa5, 0x41], at("LDA", "zp", 2, ["read"], "next", { address: 0x41 })],
            [
                "STA abs",
                cpu6502Opcodes,
                [0x8d, 0x40, 0xfe],
                at("STA", "abs", 3, ["write"], "next", { address: 0xfe40 }),
            ],
            ["INC abs,X", cpu6502Opcodes, [0xfe, 0x40, 0xfe], at("INC", "abs,x", 3, ["read", "write"], "next")],
            ["ASL A", cpu6502Opcodes, [0x0a], at("ASL", "A", 1, [], "next")],
            ["*NOP zp,X", cpu6502Opcodes, [0x14, 0x41], at("NOP", "zp,x", 2, ["read"], "next")],
            ["BNE", cpu6502Opcodes, [0xd0, 0xfe], at("BNE", "branch", 2, [], "branch", { target: 0x2000 })],
            ["JMP abs", cpu6502Opcodes, [0x4c, 0xee, 0xff], at("JMP", "abs", 3, [], "jump", { target: 0xffee })],
            ["JMP (abs)", cpu6502Opcodes, [0x6c, 0x0e, 0x02], at("JMP", "(abs)", 3, [], "jump")],
            ["JSR", cpu6502Opcodes, [0x20, 0xee, 0xff], at("JSR", "abs", 3, [], "call", { target: 0xffee })],
            ["RTS", cpu6502Opcodes, [0x60], at("RTS", "implied", 1, [], "return")],
            ["RTI", cpu6502Opcodes, [0x40], at("RTI", "implied", 1, [], "return")],
            ["BRK", cpu6502Opcodes, [0x00], at("BRK", "implied", 1, [], "interrupt")],
            ["an unknown opcode", cpu6502Opcodes, [0x02], at("???", "implied", 1, [], "next")],
            ["BRA", cpu65c12Opcodes, [0x80, 0x10], at("BRA", "branch", 2, [], "branch", { target: 0x2012 })],
            ["RMB0", cpu65c02Opcodes, [0x07, 0x41], at("RMB0", "zp", 2, ["read", "write"], "next", { address: 0x41 })],
            [
                "BBR0",
                cpu65c02Opcodes,
                [0x0f, 0x41, 0x10],
                at("BBR0", "zp,branch", 3, ["read"], "branch", { address: 0x41, target: 0x2013 }),
            ],
        ])("describes %s from the emulation's own tables", (_, opcodes, bytes, expected) => {
            mem.set(bytes, 0x2000);
            const dis = opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
            const { registers: _registers, idempotent: _idempotent, ...instruction } = dis.instructionAt(0x2000);
            expect(instruction).toEqual(expected);
        });

        it.each([
            ["LDA abs,Y", cpu6502Opcodes, 0xb9, "y", "anz", true],
            ["TAX", cpu6502Opcodes, 0xaa, "a", "xnz", true],
            ["CMP #", cpu6502Opcodes, 0xc9, "a", "nzc", true],
            ["BIT zp", cpu6502Opcodes, 0x24, "a", "nvz", true],
            ["AND #", cpu6502Opcodes, 0x29, "a", "anz", true],
            ["SEC", cpu6502Opcodes, 0x38, "", "c", true],
            ["BEQ", cpu6502Opcodes, 0xf0, "z", "", true],
            ["STA zp,X", cpu6502Opcodes, 0x95, "ax", "", true],
            ["EOR #", cpu6502Opcodes, 0x49, "a", "anz", false],
            ["INX", cpu6502Opcodes, 0xe8, "x", "xnz", false],
            ["ADC #", cpu6502Opcodes, 0x69, "adc", "anvzc", false],
            ["ROL A", cpu6502Opcodes, 0x2a, "ac", "anzc", false],
            ["INC zp", cpu6502Opcodes, 0xe6, "", "nz", false],
            ["PHA", cpu6502Opcodes, 0x48, "as", "s", false],
            ["PLP", cpu6502Opcodes, 0x28, "s", "snvdizc", false],
            ["JSR", cpu6502Opcodes, 0x20, "s", "s", false],
            ["SMB0", cpu65c02Opcodes, 0x87, "", "", true],
        ])("says what %s reads and writes, and whether it settles", (_, opcodes, opcode, reads, writes, idempotent) => {
            const dis = opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
            expect(dis.describeOpcode(opcode)).toMatchObject({
                registers: { reads: [...reads], writes: [...writes] },
                idempotent,
            });
        });
    });

    describe("documented and undocumented opcodes", () => {
        const countDocumented = (dis) => {
            let count = 0;
            for (let op = 0; op < 256; op++) {
                mem[0] = op;
                if (dis.isDocumented(0)) count++;
            }
            return count;
        };

        it("marks the NMOS part's undocumented instructions in the listing", () => {
            mem.set([0x03, 0x41], 0x2000);
            expect(disassembler.disassemble(0x2000)[0]).toMatch(/^\*SLO/);
            mem.set([0xeb, 0x41], 0x2000);
            expect(disassembler.disassemble(0x2000)[0]).toMatch(/^\*SBC/);
            mem.set([0xe9, 0x41], 0x2000);
            expect(disassembler.disassemble(0x2000)[0]).toMatch(/^SBC/);
        });

        it("marks one-byte and zero-page,X undocumented NOPs and sizes them correctly", () => {
            mem.set([0x1a, 0xf4, 0x41], 0x2000);
            expect(disassembler.disassemble(0x2000)).toEqual(["*NOP", 0x2001]);
            expect(disassembler.disassemble(0x2001, true)).toEqual(["*NOP $41,X", 0x2003]);
        });

        it("knows the NMOS part has 151 documented opcodes", () => {
            expect(countDocumented(disassembler)).toBe(151);
            mem[0] = 0x02;
            expect(disassembler.isDocumented(0)).toBe(false);
        });

        it("disassembles the 65C02 bit branches as three bytes", () => {
            const disassembler65c02 = cpu65c02Opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
            mem.set([0x0f, 0x41, 0x10], 0x2000);
            expect(disassembler65c02.disassemble(0x2000, true)).toEqual(["BBR0 $41, $2013", 0x2003, 0x2013]);
        });

        it("treats every listed 65C02 opcode as documented", () => {
            const disassembler65c02 = cpu65c02Opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
            for (let op = 0; op < 256; op++) {
                mem[0] = op;
                const text = disassembler65c02.disassemble(0)[0];
                expect(disassembler65c02.isDocumented(0)).toBe(text !== "???");
            }
        });
    });

    it.each([
        ["a BRK", cpu6502Opcodes, 0x1ffd, [0xad, 0x00, 0x60], "LDA $6000", 0x1ffd],
        ["a TSB", cpu65c12Opcodes, 0x1ffd, [0x0e, 0x04, 0x04], "ASL $0404", 0x1ffd],
        ["a BBR0", cpu65c02Opcodes, 0x1ffc, [0xc0, 0x0f, 0xe0, 0x41], "CPY #$0f", 0x1ffe],
    ])(
        "does not count %s parsed out of an operand as a common instruction",
        (_, opcodes, at, bytes, listing, expected) => {
            const dis = opcodes({ peekmem: (addr) => mem[addr & 0xffff] }).disassembler;
            mem.set(bytes, at);
            expect(dis.disassemble(at, true)[0]).toBe(listing);
            expect(dis.prevInstruction(0x2000, 0x0000)).toBe(expected);
        },
    );

    it("counts BIT as a common instruction", () => {
        // The CPY run starts first, so it would win the 1-1 tie were BIT not to score.
        mem.fill(0x02, 0x1fc0, 0x1ff9);
        mem.set([0xc0, 0x2c, 0x08, 0xa9, 0xad, 0x08, 0x28], 0x1ff9);
        expect(disassembler.disassemble(0x1ffa, true)[0]).toBe("BIT $a908");
        expect(disassembler.prevInstruction(0x2000, 0x0000)).toBe(0x1ffd);
    });

    it("returns the previous instruction in an unambiguous run", () => {
        expect(disassembler.prevInstruction(0x2002, 0x1000)).toBe(0x2001);
    });

    it("prefers the run of instructions that passes through the program counter", () => {
        // Five LDA $41 pairs then $ad give a misaligned parse whose LDA $41a9 swallows
        // the real LDA #$41 at 2000; only the boost for a run through pc outscores it.
        mem[0x2000] = 0xa9;
        mem[0x2001] = 0x41;
        for (let i = 0; i < 5; i++) {
            mem[0x1ff5 + i * 2] = 0xa5;
            mem[0x1ff6 + i * 2] = 0x41;
        }
        mem[0x1fff] = 0xad;
        expect(disassembler.prevInstruction(0x2002, 0x2000)).toBe(0x2000);
    });

    it.each([
        ["the earliest-starting run on a tie, here through JSR $41A9", 0x1ffd, [0x20, 0xa9, 0x41], undefined, 0x1ffd],
        ["the overlapping LDA #$41 when pc is on it", 0x1ffd, [0x20, 0xa9, 0x41], 0x1ffe, 0x1ffe],
        ["an instruction whose operand is data", 0x1ffd, [0x8d, 0x02, 0x02], undefined, 0x1ffd],
        ["the byte before when the only runs overrun the target", 0x1fff, [0x20], 0x1fff, 0x1fff],
        ["the byte before when nothing in the window decodes", 0x1fc0, new Array(0x40).fill(0x02), undefined, 0x1fff],
    ])("before $2000 picks %s", (_, at, bytes, pc, expected) => {
        mem.set(bytes, at);
        expect(disassembler.prevInstruction(0x2000, pc)).toBe(expected);
    });
});
