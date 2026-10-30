import { beforeAll, describe, expect, it } from "vitest";

import { fake6502, fake65C12 } from "../../src/fake6502.js";
import { tightLoopAt } from "../../src/tight-loop.js";

const Base = 0x2000;
const ClearedBytes = 0x80;

function loopIn(cpu, code, pc) {
    const padded = [...code, ...new Array(ClearedBytes - code.length).fill(0)];
    padded.forEach((byte, i) => cpu.writemem(Base + i, byte));
    return tightLoopAt(cpu.disassembler, pc);
}

const loop = (start, end, reads) => ({ start, end, reads });

describe("tightLoopAt", () => {
    let nmos;
    let cmos;

    beforeAll(async () => {
        [nmos, cmos] = [fake6502(), fake65C12()];
        await Promise.all([nmos.initialise(), cmos.initialise()]);
    });

    it.each([
        [
            "LDA &FE4D : AND #2 : BEQ back, a VIA flag wait",
            [0xad, 0x4d, 0xfe, 0x29, 0x02, 0xf0, 0xf9],
            0x2003,
            loop(0x2000, 0x2005, [0xfe4d]),
        ],
        [
            "BIT &FE80 : BMI back, stopped on the branch",
            [0x2c, 0x80, 0xfe, 0x30, 0xfb],
            0x2003,
            loop(0x2000, 0x2003, [0xfe80]),
        ],
        [
            "LDA &A2 : BPL out : LDA &FF : BPL back, the Master DFS's wait for its NMI or Escape",
            [0xa5, 0xa2, 0x10, 0x04, 0xa5, 0xff, 0x10, 0xf8],
            0x2004,
            loop(0x2000, 0x2006, [0xa2, 0xff]),
        ],
        [
            "a branch back from as far as a tight loop runs",
            [...new Array(0x20).fill(0xea), 0xd0, 0xde],
            0x2000,
            loop(0x2000, 0x2020, []),
        ],
        ["a JMP away part way round", [0xa5, 0x70, 0x4c, 0x00, 0x30, 0xad, 0x4d, 0xfe, 0xf0, 0xf6], 0x2005, undefined],
        [
            "LAX &70 : BEQ back, an undocumented load that settles",
            [0xa7, 0x70, 0xf0, 0xfc],
            0x2000,
            loop(0x2000, 0x2002, [0x70]),
        ],
        ["EOR &70 : BNE back, which toggles A", [0x45, 0x70, 0xd0, 0xfc], 0x2000, undefined],
        ["PLA : BEQ back, a stack operation", [0x68, 0xf0, 0xfd], 0x2000, undefined],
        ["an indirect read", [0xb1, 0x70, 0xf0, 0xfc], 0x2000, undefined],
        ["a store in it", [0xad, 0x4d, 0xfe, 0x8d, 0x00, 0x30, 0xf0, 0xf8], 0x2000, undefined],
        ["a call in it", [0x20, 0xe0, 0xff, 0xf0, 0xfb], 0x2003, undefined],
        ["DEX : BNE back, a delay that counts down", [0xca, 0xd0, 0xfd], 0x2000, undefined],
        ["an indexed read", [0xbd, 0x40, 0xfe, 0xf0, 0xfb], 0x2000, undefined],
        ["an opcode the CPU doesn't have", [0x02, 0xf0, 0xfd], 0x2000, undefined],
        ["only a branch forward before a return", [0xad, 0x4d, 0xfe, 0xf0, 0x00, 0x60], 0x2000, undefined],
        [
            "a branch back from further than a tight loop runs",
            [...new Array(0x40).fill(0xea), 0xd0, 0xbe],
            0x203f,
            undefined,
        ],
    ])("%s", (_, code, pc, expected) => {
        expect(loopIn(nmos, code, pc)).toEqual(expected);
    });

    it("finds no loop where the 65C12's BRA away comes before the branch back", () => {
        expect(loopIn(cmos, [0xa5, 0x70, 0x80, 0x02, 0xd0, 0xfa], 0x2000)).toBeUndefined();
    });
});
