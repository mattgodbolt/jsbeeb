import { describe, it, expect } from "vitest";
import { TestMachine } from "../../src/test-machine.js";

const resultAddress = 0x100;

// Replays beebjit make_timing_rom.c's "T2 counting when it's supporting shifting" block.
describe("T2 under shift-out-at-T2-rate", () => {
    it("matches beebjit's timing ROM", async () => {
        const tm = new TestMachine();
        await tm.initialise();
        await tm.runUntilInput();
        await tm.loadBasic(`
DIM MC% 200
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #0:STA &FE6B
LDA #&7F:STA &FE6E
LDA #7:STA &FE68
LDA #2:STA &FE69
LDA #&10:STA &FE6B
LDA &FE68:STA R%
LDA &FE68:STA R%+1
NOP
LDA &FE68
NOP
LDX &FE69
NOP:NOP
LDY &FE6D
STA R%+2:STX R%+3:STY R%+4
NOP:NOP
LDA #100:STA &FE69
LDA &FE69:STA R%+5
NOP:NOP
LDA &FE68:STA R%+6
LDA #0:STA &FE6B
LDA &FE68:STA R%+7
CLI
RTS
]
CALL MC%
`);
        await tm.type("RUN");
        await tm.runUntilInput();
        const got = [...Array(8)].map((_, i) => tm.readbyte(resultAddress + i));
        got[4] &= 0x20;
        expect(got).toEqual([1, 5, 0xff, 0x00, 0x20, 100, 7, 0xfe]);
    });
});
