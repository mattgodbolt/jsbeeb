import * as utils from "../../src/utils.js";
import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
import assert from "assert";

describe("test read-modify-write behaviour", function () {
    const doTest = async (model) => {
        const testMachine = new TestMachine(model);
        await testMachine.initialise();
        await testMachine.loadDisc("discs/RmwX.ssd");
        await testMachine.runUntilInput();
        await testMachine.type("*TIMINGS");
        await testMachine.runUntilInput();
        let result = "";
        for (let i = 0x100; i < 0x110; i += 4) {
            if (i !== 0x100) result += " ";
            for (let j = 3; j >= 0; --j) {
                result += utils.hexbyte(testMachine.readbyte(i + j));
            }
        }
        return result;
    };
    it("should match on 65C12", async () => {
        const result = await doTest("Master");
        assert.strictEqual(result, "f4ff0a16 eaeadee9 f2fe0a16 c3ced9e5");
    });
    it("should match on 6502", async () => {
        const result = await doTest();
        assert.strictEqual(result, "f2fe0a16 eaeadae6 f2fe0a16 c1cdd9e5");
    });
});

describe("should pass scarybeasts' RMW test on master", function () {
    it("should match", async function () {
        // https://stardot.org.uk/forums/viewtopic.php?f=4&t=23131
        const source = `
P%=&2000
[OPT0
SEI
LDA #0:STA &FE68
LDA #1:STA &FE69
LDA #&7F:STA &FE6D
LDA #1:STA &FE68
LDA #0:STA &FE69
DEC &FE68
LDA &FE6D
AND #&20
STA &71
LDA #0:STA &FE69
LDA &FE68
STA &70
CLI
RTS
]
?&70=0
?&71=0
CALL &2000`;
        const testMachine = new TestMachine("Master");
        await testMachine.initialise();
        await testMachine.runUntilInput();
        await testMachine.loadBasic(source);

        testMachine.captureText((elem) => console.log(`emulator output: ${elem.text}`));
        await testMachine.type("RUN");
        await testMachine.runUntilInput();
        assert.equal(testMachine.readbyte(0x70), 252);
        assert.equal(testMachine.readbyte(0x71), 0);
    });
});
