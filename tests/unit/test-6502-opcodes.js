import { beforeEach, describe, expect, it } from "vitest";

import { Cpu6502 as cpu6502Opcodes, Cpu65c02 as cpu65c02Opcodes } from "../../src/6502.opcodes.js";

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

        it("knows the NMOS part has 151 documented opcodes", () => {
            expect(countDocumented(disassembler)).toBe(151);
            mem[0] = 0x02;
            expect(disassembler.isDocumented(0)).toBe(false);
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
});
