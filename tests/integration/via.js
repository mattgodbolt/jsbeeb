import { describe, it } from "mocha";
import { TestMachine } from "./test-machine.js";
import assert from "assert";

async function runViaProgram(source) {
    const testMachine = new TestMachine();
    await testMachine.initialise();
    await testMachine.runUntilInput();
    await testMachine.loadBasic(source);

    testMachine.captureText((elem) => console.log(`emulator output: ${elem.text}`));
    await testMachine.type("RUN");
    await testMachine.runUntilInput();
    return testMachine;
}

describe("should pass scarybeasts' VIA tests", function () {
    // Code here extracted and paraphrased from the SSD zipfile from https://github.com/mattgodbolt/jsbeeb/issues/179
    it("VIA.AC1 - Does ACR write restart timer?", async function () {
        // Real BBC: 64, 0, 0, 128
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = &200
P% = MC%
[
OPT 2
SEI
LDA #&FF
STA &FE62
LDA #&00
STA &FE60
LDA #&7F
STA &FE6E
LDA #&80
STA &FE6B
LDA #&04
STA &FE64
LDA #&00
STA &FE65
NOP
NOP
NOP
LDA &FE6D
STA R%
NOP
NOP
LDA #&C0
STA &FE6B
LDA &FE64
STA R%+1
LDA &FE6D
STA R%+2
LDA &FE60
STA R%+3
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: DOES ACR WRITE RESTART TIMER?"
PRINT "REAL BBC: 64, 0, 0, 128"
PRINT ?(R%)
PRINT ?(R%+1)
PRINT ?(R%+2)
PRINT ?(R%+3)`);
        assert.equal(testMachine.readbyte(0x200), 64);
        assert.equal(testMachine.readbyte(0x201), 0);
        assert.equal(testMachine.readbyte(0x202), 0);
        assert.equal(testMachine.readbyte(0x203), 128);
    });
});
