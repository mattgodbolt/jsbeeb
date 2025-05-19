import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
import assert from "assert";

describe("test dp111's timing tests", { timeout: 30000 }, function () {
    const doTest = async (disc, machine) => {
        const testMachine = new TestMachine(machine);
        await testMachine.initialise();
        await testMachine.loadDisc(`tests/integration/dp111_6502Timing/${disc}.ssd`);
        await testMachine.runUntilInput();
        let output = "";
        testMachine.captureText((elem) => {
            output += `${elem.text}\n`;
        });
        await testMachine.type("*RUN 6502TIM");
        let numFailedTests = null;
        const hook = testMachine.processor.debugWrite.add((addr, value) => {
            if (addr === 0xfcd0) {
                numFailedTests = value;
            }
        });
        await testMachine.runUntilInput();
        hook.remove();
        if (numFailedTests) {
            console.log(`Test failed, output:\n${output}`);
        }
        assert.equal(numFailedTests, 0);
    };
    it("should handle 6502timing", async () => {
        await doTest("6502timing");
    });
    it("should handle 6502timing with 1MHz bus", async () => {
        await doTest("6502timing1M");
    });

    it("should handle 65C12timing", async () => {
        await doTest("65C12timing", "Master");
    });
    it("should handle 65C12timing with 1MHz bus", async () => {
        await doTest("65C12timing1M", "Master");
    });
});
