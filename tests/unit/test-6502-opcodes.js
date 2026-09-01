import { beforeEach, describe, expect, it } from "vitest";

import { Cpu6502 as cpu6502Opcodes } from "../../src/6502.opcodes.js";

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
