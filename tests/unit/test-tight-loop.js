import { describe, expect, it } from "vitest";

import { Cpu6502, Cpu65c02 } from "../../src/6502.opcodes.js";
import { tightLoopAt } from "../../src/tight-loop.js";

const Base = 0x2000;

const opcodesOf = (Cpu) => Cpu({ peekmem: () => 0 }).disassembler.opcodes;
const Nmos = opcodesOf(Cpu6502);
const Cmos = opcodesOf(Cpu65c02);

function loopIn(opcodes, code, pc) {
    const memory = new Uint8Array(0x10000);
    memory.set(code, Base);
    return tightLoopAt(opcodes, (address) => memory[address], pc);
}

const loop = (start, end, reads) => ({ start, end, reads });

describe("tightLoopAt", () => {
    it.each([
        [
            "LDA &FE4D : AND #2 : BEQ back, a VIA flag wait",
            Nmos,
            [0xad, 0x4d, 0xfe, 0x29, 0x02, 0xf0, 0xf9],
            0x2003,
            loop(0x2000, 0x2005, [0xfe4d]),
        ],
        [
            "BIT &FE80 : BMI back, stopped on the branch",
            Nmos,
            [0x2c, 0x80, 0xfe, 0x30, 0xfb],
            0x2003,
            loop(0x2000, 0x2003, [0xfe80]),
        ],
        [
            "CLI : SEI : CMP &240 : BEQ back, OSBYTE 19's wait for the vsync count to move",
            Nmos,
            [0x58, 0x78, 0xcd, 0x40, 0x02, 0xf0, 0xf9],
            0x2000,
            loop(0x2000, 0x2005, [0x0240]),
        ],
        [
            "LDA &A2 : BPL out : LDA &FF : BPL back, the Master DFS's wait for its NMI or Escape",
            Nmos,
            [0xa5, 0xa2, 0x10, 0x04, 0xa5, 0xff, 0x10, 0xf8],
            0x2004,
            loop(0x2000, 0x2006, [0xa2, 0xff]),
        ],
        ["JMP to itself, reading nothing", Nmos, [0x4c, 0x00, 0x20], 0x2000, loop(0x2000, 0x2000, [])],
        ["BBR0 &70, back to itself", Cmos, [0x0f, 0x70, 0xfd], 0x2000, loop(0x2000, 0x2000, [0x70])],
        ["a store in it", Nmos, [0xad, 0x4d, 0xfe, 0x8d, 0x00, 0x30, 0xf0, 0xf8], 0x2000, undefined],
        ["a call in it", Nmos, [0x20, 0xe0, 0xff, 0xf0, 0xfb], 0x2003, undefined],
        ["DEX : BNE back, a delay that counts down", Nmos, [0xca, 0xd0, 0xfd], 0x2000, undefined],
        ["an indexed read", Nmos, [0xbd, 0x40, 0xfe, 0xf0, 0xfb], 0x2000, undefined],
        ["only a branch forward before a return", Nmos, [0xad, 0x4d, 0xfe, 0xf0, 0x00, 0x60], 0x2000, undefined],
        [
            "a branch back from further than a tight loop runs",
            Nmos,
            [...new Array(0x40).fill(0xea), 0xd0, 0xbe],
            0x203f,
            undefined,
        ],
    ])("%s", (_, opcodes, code, pc, expected) => {
        expect(loopIn(opcodes, code, pc)).toEqual(expected);
    });
});
