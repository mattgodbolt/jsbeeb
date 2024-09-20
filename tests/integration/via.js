import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
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
        assert.equal(testMachine.readbyte(addr), expected, `mismatch at 0x${addr.toString(16)}`);
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
        expectArray(testMachine, [18]); // checked on a BBC Master
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
        expectArray(testMachine, [18]); // checked on a BBC Master
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
        expectArray(testMachine, [17]); // checked on a BBC Master
    });
    // TODO: check on a real BBC and update the `[13]` if that's not right
    it.skip("VIA.C4", async function () {
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
        expectArray(testMachine, [13]); // checked on a BBC Master
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
EQUB &03  \\ SLO ($50, X)
EQUB &50
LDA &FE64
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT ?&FE6A
?R% = ?&FE6A`);
        expectArray(testMachine, [12]); // TODO check this on a real BBC (opcode difference on master)
    });
    it("VIA.I1 - does T1LH write clear int in on-shot", async function () {
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
STA &FE64
STA &FE65
NOP
NOP
LDA &FE6D
STA R%
LDA #&00
STA &FE67
LDA &FE6D
STA R%+1
CLI
RTS
]
CALL MC%
PRINT "VIA TEST: DOES T1LH WRITE CLEAR INT IN ONE-SHOT?"
PRINT "REAL BBC: YES: 64, 0"
REM REAL BBC! YES: 64, 0
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [64, 0]);
    });
    it("VIA.I2 - does timer interrupt fire if IFR cleared at the same time?", async function () {
        const testMachine = await runViaProgram(`
DIM IRQ% 100
DIM MC% 256
R% = ${resultAddress}
DIM BAK% 3
P% = IRQ%
[
OPT 2
INC R%
RTI
]
P% = MC%
[
OPT 2
SEI
LDA #&00
STA R%
LDA &0204
STA BAK%
LDA &0205
STA BAK%+1
LDA &FE4E
STA BAK%+2
LDA #(IRQ% MOD 256)
STA &0204
LDA #(IRQ% DIV 256)
STA &0205
LDA #&7F
STA &FE6E
STA &FE4E
LDA #&C0
STA &FE6E
LDA #&00
STA &FE6B
LDA #&03
STA &FE64
LDA #&00
LDX #&7F
STA &FE65
NOP
NOP
STX &FE6D
LDA &FE6D
STA R%+1
CLI
SEI
LDA BAK%
STA &0204
LDA BAK%+1
STA &0205
LDA BAK%+2
STA &FE4E
LDA #&7F
STA &FE6E
CLI
RTS
]
PRINT ~MC%
PRINT ~IRQ%
CALL MC%
PRINT "VIA TEST: DOES TIMER INTERRUPT FIRE IF IFR CLEARED AT SAME TIME?"
PRINT "REAL BBC: YES: 1, 192"
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [1, 192]);
    });
    it("VIA.PB2 - does pb7 toggle if ACR not in PB7 mode?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 256
R% = ${resultAddress}
P% = MC%
[
OPT 3
SEI
LDA #&FF
STA &FE62
LDA #&00
STA &FE60
LDA #&7F
STA &FE6E
LDA #&80
STA &FE6B
LDA #&03
STA &FE64
LDA #&00
STA &FE65
STA &FE6B
NOP
NOP
LDA #&80
STA &FE6B
LDA &FE60
STA R%
CLI
RTS
]
CALL MC%
REM REAL BBC! YES: 128
PRINT ?(R%)`);
        expectArray(testMachine, [128]);
    });
    // @scarybeasts' original talks about "SYSVIA" below but this is the user VIA
    it("VIA.PB7 - user via checks", async function () {
        const testMachine = await runViaProgram(`
PRINT "RUN AFTER FRESH BOOT"
R% = ${resultAddress}
?R% = 0
PROCcheck(0, ?&FE62, "SYSVIA DDRB &FE62")
PROCcheck(255, ?&FE60, "SYSVIA PORT B &FE60")
?&FE62 = 255
PROCcheck(0, ?&FE60, "SYSVIA PORT B OUTPUT")
?&FE62 = 0
PROCcheck(255, ?&FE60, "SYSVIA PORT B INPUT")
PROCcheck(0, ?&FE6B, "SYSVIA ACR")
?&FE6B = 128
?&FE60 = 0
?&FE64 = 0
?&FE65 = 255
REM READ QUICKLY BEFORE TIMER HITS
A% = ?&FE60
REM TIMER EXPIRES IN 65MS
T%=TIME+10:REPEAT UNTIL TIME>T%
PROCcheck(127, A%, "SYSVIA PORT B INPUT PB7 LOW")
PROCcheck(255, ?&FE60, "SYSVIA PORT B INPUT PB7 HIGH")
?&FE62 = 255
PROCcheck(128, ?&FE60, "SYSVIA PORT B OUTPUT PB7 HIGH")
?&FE6B = 0
PROCcheck(0, ?&FE60, "SYSVIA PORT B OUTPUT")
?&FE60 = 0
?&FE62 = 0
END
DEF PROCcheck(E%, A%, N$)
R$ = "OK"
IF E% <> A% THEN R$ = "FAIL!"
IF E% <> A% THEN ?R% = 255
PRINT R$ + ": " + N$ + ": " + STR$(A%) + " (expected " + STR$(E%) + ")"
ENDPROC`);
        expectArray(testMachine, [0]);
    });
    it("VIA.T11 - How does T1 tick across expiry?", async function () {
        const testMachine = await runViaProgram(`
REM RESET ACR TO DEFAULT BOOT + MOS 1.2 STATE
R% = ${resultAddress}
PRINT "VIA TEST: HOW DOES T1 TICK ACROSS EXPIRY?"
PRINT "REAL BBC: 1, 0, 255, 4, 3, 2"
?&FE6B = 0
REM QUICK CHECKS TO SEE IF TIMERS ARE RUNNING ETC.
PRINT "USER VIA IFR: " + STR$(?&FE6D)
FOR A%=0 TO 1
PRINT "USER VIA T1CH: " + STR$(?&FE65)
PRINT "USER VIA T1CL: " + STR$(?&FE64)
NEXT
DIM MC% 100
PROCtimeit(1)
PROCtimeit(2)
PROCtimeit(3)
PROCtimeit(4)
PROCtimeit(5)
PROCtimeit(6)
END
DEF PROCtimeit(N%)
P% = MC%
[
OPT 0
SEI
LDX #0
LDY #0
LDA #4
STA &FE64
LDA #0
STA &FE65
]
FOR A%=1 TO N%
[
OPT 0
NOP
]
NEXT
[
OPT 0
LDA &FE64
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT "USER VIA T1CL: " + STR$(?&FE6A)
?R% = ?&FE6A
R% = R% + 1
ENDPROC`);
        expectArray(testMachine, [1, 0, 255, 4, 3, 2]);
    });
    it("VIA.T12 - When do T1L writes take effect vs. timer expiry?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = ${resultAddress}
P% = MC%
[
OPT 3
SEI
LDA #&00
STA &FE6B
LDA #&7F
STA &FE6E
LDA #&02
STA &FE64
LDA #&00
STA &FE65
LDA #&FF
STA &FE66
LDA &FE64
STA R%
LDA #&03
STA &FE64
LDA #&00
STA &FE65
NOP
NOP
LDA #&FF
STA &FE66
LDA &FE64
STA R%+1
CLI
RTS
]
CALL MC%
REM REAL BBC: 253, 0
PRINT "VIA TEST: WHEN DO T1L WRITES TAKE EFFECT VS. TIMER EXPIRY?"
PRINT "REAL BBC: 253, 0"
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [253, 0]);
    });
    it("VIA.T21 - user VIA T2 to pulse counting?", async function () {
        const testMachine = await runViaProgram(`
REM USER VIA T2 TO PULSE COUNTING
REM FREEZES T2
R% = ${resultAddress}
PRINT "VIA TEST: T2 IN PULSE COUNTING MODE"
PRINT "REAL BBC: 1, 255, 255"
?&FE6B = &20
?&FE68 = 1
?&FE69 = 0
R%?0 = ?&FE68
?&FE68 = &FF
?&FE69 = &FF
R%?1 = ?&FE68
R%?2 = ?&FE68
PRINT "USER VIA T2CL: " + STR$(R%?0)
PRINT "USER VIA T2CL: " + STR$(R%?1)
PRINT "USER VIA T2CL: " + STR$(R%?2)`);
        expectArray(testMachine, [1, 255, 255]);
    });
    it("VIA.T22 - T2 ticking past expiry", async function () {
        const testMachine = await runViaProgram(`
REM RESET ACR TO DEFAULT BOOT + MOS 1.2 STATE
R% = ${resultAddress}
PRINT "VIA TEST: T2 TICKING PAST EXPIRY"
PRINT "REAL BBC: 1, 0, 255, 254, 253, 252"
?&FE6B = 0
REM QUICK CHECKS TO SEE IF TIMERS ARE RUNNING ETC.
PRINT "USER VIA IFR: " + STR$(?&FE6D)
FOR A%=0 TO 1
PRINT "USER VIA T2CH: " + STR$(?&FE69)
PRINT "USER VIA T2CL: " + STR$(?&FE68)
NEXT
DIM MC% 100
PROCtimeit(1)
PROCtimeit(2)
PROCtimeit(3)
PROCtimeit(4)
PROCtimeit(5)
PROCtimeit(6)
END
DEF PROCtimeit(N%)
P% = MC%
[
OPT 0
SEI
LDX #0
LDY #0
LDA #4
STA &FE68
LDA #0
STA &FE69
]
FOR A%=1 TO N%
[
OPT 0
NOP
]
NEXT
[
OPT 0
LDA &FE68
STA &FE6A
CLI
RTS
]
CALL MC%
PRINT "USER VIA T2CL: " + STR$(?&FE6A)
?R% = ?&FE6A
R% = R% + 1
ENDPROC`);
        expectArray(testMachine, [1, 0, 255, 254, 253, 252]);
    });
    // Disabled, @scarybeasts comments:
    //  I fixed everything except VIA.T23, which doesn't seem important. It's tricky for code to really rely on T2
    //  values after toggling ACR 0x20 because results will vary depending on what is attached and generating pulses
    //  from external.
    // @mattgodbolt notes; the "real BBC" values agree with my BBC Master, so seems good to fix.
    // TODO: fix this eventually
    it.skip("VIA.T23 - what values do we get freezing and starting T2?", async function () {
        const testMachine = await runViaProgram(`
DIM MC% 100
R% = ${resultAddress}
P% = MC%
[
OPT 3
SEI
LDA #&40
STA &FE4B
LDA #&FF
STA &FE48
STA &FE49
LDA #&60
STA &FE4B
LDA &FE48
STA R%
LDA #&40
STA &FE4B
LDA &FE48
STA R%+1
LDA #&60
STA &FE4B
CLI
RTS
]
CALL MC%
REM REAL BBC: 251, 249
PRINT "VIA TEST: WHAT VALUES DO WE GET FREEZING AND STARTING T2?"
PRINT "REAL BBC: 251, 249"
PRINT ?(R%)
PRINT ?(R%+1)`);
        expectArray(testMachine, [251, 249]);
    });

    // @tom-seddon reported this one:
    it("T.VIA.PB6 - VIA T2 doesn't count manually-induced PB6 pulses", async function () {
        const testMachine = await runViaProgram(`
REM DISABLE IRQS
N%=0
R%=${resultAddress}
?&FE6E=&7F
?&FE6D=&7F
:
REM T2 PULSE COUNTING MODE
?&FE6B=?&FE6B OR&20
:
REM RESET T2
?&FE68=100
?&FE69=0
:
REM PB OUTPUTS
:
PROCP
PRINT"TOGGLE IN OUTPUT MODE"
?&FE62=0
?&FE6F=&40
PROCP
?&FE62=&FF
PROCP
?&FE6F=&40
PROCP
?&FE6F=&00
PROCP
PRINT"TOGGLE VIA DDRB"
?&FE62=0
PROCP
?&FE62=&FF
PROCP
?&FE62=0
PROCP
END
:
DEFPROCP:LOCALT2%
T2%=?&FE69*256+?&FE68
R%!N%=T2%
N%=N%+2
PRINT"T2=";T2%" (&";~T2%")"
ENDPROC`);
        // Expected output:
        // T2=100 (&64)
        // TOGGLE IN OUTPUT MODE
        // T2=100 (&64)
        // T2=99 (&63)
        // T2=99 (&63)
        // T2=99 (&63)
        // TOGGLE VIA DDRB
        // T2=99 (&63)
        // T2=98 (&62)
        // T2=98 (&62)
        expectArray(testMachine, [100, 0, 100, 0, 99, 0, 99, 0, 99, 0, 99, 0, 98, 0, 98, 0]);
    });
    // TODO: write more pb6 pulse tests, e.g. interrupt behaviour and underflow, and run on a real bbc.
});
