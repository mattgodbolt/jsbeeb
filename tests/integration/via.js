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

const resultAddress = 0x100;

function expectArray(testMachine, array) {
    let addr = resultAddress;
    for (const expected of array) {
        assert.equal(testMachine.readbyte(addr), expected);
        addr++;
    }
}

describe("should pass scarybeasts' VIA tests", function () {
    // Code here extracted and paraphrased from the SSD zipfile from https://github.com/mattgodbolt/jsbeeb/issues/179
    it("VIA.AC1 - Does ACR write restart timer?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = ${resultAddress}
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
        expectArray(testMachine, [64, 0, 0, 128]);
    });
    it("VIA.AC2 - Does ACR write at timer expiry affect behaviour #1?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&7F
STA &FE6E
LDA #&00
STA &FE6B
LDA #&02
STA &FE64
LDA #&00
STA &FE65
LDA #&40
STA &FE6B
LDA &FE64
STA R%
LDA &FE6D
STA R%+1
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: DOES ACR WRITE AT TIMER EXPIRY AFFECT BEHAVIOR #1?"
PRINT "REAL BBC: 0, 0"
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [0, 0]);
    });
    it("VIA.AC3 - Does ACR write at timer expiry affect behaviour #2?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&7F
STA &FE6E
LDA #&40
STA &FE6B
LDA #&02
STA &FE64
LDA #&00
STA &FE65
LDA #&00
STA &FE6B
LDA &FE64
STA R%
LDA &FE6D
STA R%+1
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: DOES ACR WRITE AT TIMER EXPIRY AFFECT BEHAVIOR #2?"
PRINT "REAL BBC: 0, 0"
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [0, 0]);
    });
    it("VIA.AC4 - flip ACR mode to one-shot after expiry, does it IRQ?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&7F
STA &FE6E
LDA #&40
STA &FE6B
LDA #10
STA &FE64
LDA #&00
STA &FE65
LDA &FE6D
STA R%
LDA &FE64
STA R%+1
NOP
NOP
LDA &FE6D
STA R%+2
LDA &FE64
STA R%+3
NOP
NOP
LDA &FE6D
STA R%+4
LDA &FE64
STA R%+5
NOP
NOP
LDA #&00
STA &FE6B
NOP
NOP
NOP
NOP
NOP
NOP
NOP
NOP
LDA &FE6D
STA R%+6
LDA &FE64
STA R%+7
NOP
NOP
LDA &FE6D
STA R%+8
LDA &FE64
STA R%+9
CLI
RTS
]
CALL MC%
REM REAL BBC! 0, 3, 64, 3, 64, 3, 64, 3, 0, 3
PRINT "VIA TEST: FLIP ACR MODE TO ONE-SHOT AFTER EXPIRY, DOES IT IRQ?"
PRINT "REAL BBC: 0, 3, 64, 3, 64, 3, 64, 3, 0, 3"
PRINT ?(R%)
PRINT ?(R%+1)
PRINT ?(R%+2)
PRINT ?(R%+3)
PRINT ?(R%+4)
PRINT ?(R%+5)
PRINT ?(R%+6)
PRINT ?(R%+7)
PRINT ?(R%+8)
PRINT ?(R%+9)`);
        expectArray(testMachine, [0, 3, 64, 3, 64, 3, 64, 3, 0, 3]);
    });
    it("VIA.AC5 - flip ACR mode to continuous after expiry, does it IRQ?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&7F
STA &FE6E
LDA #&00
STA &FE6B
LDA #10
STA &FE64
LDA #&00
STA &FE65
LDA &FE6D
STA R%
LDA &FE64
STA R%+1
NOP
NOP
LDA &FE6D
STA R%+2
LDA &FE64
STA R%+3
NOP
NOP
LDA &FE6D
STA R%+4
LDA &FE64
STA R%+5
NOP
NOP
LDA #&40
STA &FE6B
NOP
NOP
NOP
NOP
NOP
NOP
NOP
NOP
LDA &FE6D
STA R%+6
LDA &FE64
STA R%+7
NOP
NOP
LDA &FE6D
STA R%+8
LDA &FE64
STA R%+9
CLI
RTS
]
CALL MC%
REM REAL BBC! 0, 3, 64, 3, 0, 3, 0, 3, 0, 3
PRINT "VIA TEST: FLIP ACR MODE TO CONT AFTER EXPIRY, DOES IT IRQ?"
PRINT "REAL BBC: 0, 3, 64, 3, 0, 3, 0, 3, 0, 3"
PRINT ?(R%)
PRINT ?(R%+1)
PRINT ?(R%+2)
PRINT ?(R%+3)
PRINT ?(R%+4)
PRINT ?(R%+5)
PRINT ?(R%+6)
PRINT ?(R%+7)
PRINT ?(R%+8)
PRINT ?(R%+9)`);
        expectArray(testMachine, [0, 3, 64, 3, 0, 3, 0, 3, 0, 3]);
    });
    it("VIA.AC6 - getting to the bottom of ACR write at IRQ time #1", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 0
SEI
LDA #&7F
STA &FE6E
LDA #6
STA &FE64

LDA #&40
STA &FE6B
LDA #&00
STA &FE65

LDA #&00
STA &FE6B
NOP : NOP : NOP : NOP
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%
STX R%+1
STY R%+2

LDA #&40
STA &FE6B
LDA #&00
STA &FE65

LDA #&00
NOP : NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+3
STX R%+4
STY R%+5

LDA #&40
STA &FE6B
LDA #&00
STA &FE65

LDA #&00
NOP : NOP : NOP
STA &FE6B
NOP
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+6
STX R%+7
STY R%+8

LDA #&40
STA &FE6B
LDA #&00
STA &FE65

LDA #&00
LDX &00
NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+9
STX R%+10
STY R%+11

LDA #&40
STA &FE6B
LDA #&00
STA &FE65

LDA #&C0
NOP : NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+12
STX R%+13
STY R%+14
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: GETTING TO THE BOTTOM OF ACR WRITE AT IRQ TIME #1"
PRINT "REAL BBC: 64, 0, 1, 64, 0, 1, 64, 0, 1, 64, 0, 1, 64, 64, 1"
PRINT "40 -> 00 IMMEDIATE"
REM REAL BBC! 64, 0, 1
PRINT ?(R%)
PRINT ?(R%+1)
PRINT ?(R%+2)
PRINT "40 -> 00 AT -1"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+3)
PRINT ?(R%+4)
PRINT ?(R%+5)
PRINT "40 -> 00 AT 0"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+6)
PRINT ?(R%+7)
PRINT ?(R%+8)
PRINT "40 -> 00 AT -1, 2 CYCLE STORE"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+9)
PRINT ?(R%+10)
PRINT ?(R%+11)
PRINT "40 -> C0 AT -1"
REM REAL BBC! 64, 64, 1
PRINT ?(R%+12)
PRINT ?(R%+13)
PRINT ?(R%+14)`);
        expectArray(testMachine, [64, 0, 1, 64, 0, 1, 64, 0, 1, 64, 0, 1, 64, 64, 1]);
    });
    it("VIA.AC7 - getting to the bottom of ACR write at IRQ time #2", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 0
SEI
LDA #&7F
STA &FE6E
LDA #6
STA &FE64

LDA #&00
STA &FE6B
LDA #&00
STA &FE65

LDA #&40
STA &FE6B
NOP : NOP : NOP : NOP
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%
STX R%+1
STY R%+2

LDA #&00
STA &FE6B
LDA #&00
STA &FE65

LDA #&40
NOP : NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+3
STX R%+4
STY R%+5

LDA #&00
STA &FE6B
LDA #&00
STA &FE65

LDA #&40
NOP : NOP : NOP
STA &FE6B
NOP
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+6
STX R%+7
STY R%+8

LDA #&00
STA &FE6B
LDA #&00
STA &FE65

LDA #&40
LDX &00
NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+9
STX R%+10
STY R%+11

LDA #&00
STA &FE6B
LDA #&00
STA &FE65

LDA #&C0
NOP : NOP : NOP : NOP
STA &FE6B
LDA &FE6D
LDY &FE64
NOP : NOP
LDX &FE6D
LDY &FE64
STA R%+12
STX R%+13
STY R%+14
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: GETTING TO THE BOTTOM OF ACR WRITE AT IRQ TIME #2"
PRINT "REAL BBC: 64, 64, 1, 64, 0, 1, 64, 64, 1, 64, 0, 1, 64, 0, 1"
PRINT "00 -> 40 IMMEDIATE"
REM REAL BBC! 64, 64, 1
PRINT ?(R%)
PRINT ?(R%+1)
PRINT ?(R%+2)
PRINT "00 -> 40 AT -1"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+3)
PRINT ?(R%+4)
PRINT ?(R%+5)
PRINT "00 -> 40 AT 0"
REM REAL BBC! 64, 64, 1
PRINT ?(R%+6)
PRINT ?(R%+7)
PRINT ?(R%+8)
PRINT "00 -> 40 AT -1, 2 CYCLE STORE"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+9)
PRINT ?(R%+10)
PRINT ?(R%+11)
PRINT "00 -> C0 AT -1"
REM REAL BBC! 64, 0, 1
PRINT ?(R%+12)
PRINT ?(R%+13)
PRINT ?(R%+14)`);
        expectArray(testMachine, [64, 64, 1, 64, 0, 1, 64, 64, 1, 64, 0, 1, 64, 0, 1]);
    });
    it("VIA.C1", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDX #0
LDY #0
LDA #20
STA &FE64
LDA #0
STA &FE65
LDA &FE64
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [18]); // TODO check this on a real BBC
    });
    it("VIA.C2", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&64
STA &50
LDA #&FE
STA &51
LDX #0
LDY #0
LDA #20
STA &FE64
LDA #0
STA &FE65
LDA (&50),Y
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [18]); // TODO check this on a real BBC
    });
    it("VIA.C3", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&64
STA &50
LDA #&FE
STA &51
LDX #0
LDY #0
LDA #20
STA &FE64
LDA #0
STA &FE65
LDA (&50,X)
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [17]); // TODO check this on a real BBC
    });
    it("VIA.C4", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDX #0
LDY #0
LDA #20
STA &FE64
LDA #0
STA &FE65
ASL &FE64,X
LDA &FE64
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [12]); // TODO check this on a real BBC
    });
    it("VIA.C5", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 2
SEI
LDA #&64
STA &50
LDA #&FE
STA &51
LDX #0
LDY #0
LDA #20
STA &FE64
LDA #0
STA &FE65
EQUB &03
EQUB &50
LDA &FE64
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [12]); // TODO check this on a real BBC
    });
});
