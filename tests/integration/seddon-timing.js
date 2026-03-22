import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

// Tom Seddon's 6502/65C02 timing tests.
// Source: https://github.com/tom-seddon/beeb_6502_timing_tests
// Tests edge cases in dead cycles, page boundary crossing, and 1MHz bus timing.
describe("test tom-seddon's timing tests", { timeout: 60000 }, function () {
    const doTest = async (machine) => {
        const testMachine = new TestMachine(machine);
        await testMachine.initialise();
        await testMachine.loadDisc("discs/beeb_6502_timing_tests.ssd");
        await testMachine.runUntilInput();
        let output = "";
        testMachine.captureText((elem) => {
            output += `${elem.text}\n`;
        });
        await testMachine.type('CHAIN "TIMINGS"');
        await testMachine.runUntilInput();
        if (output.includes("FAILED")) {
            console.log(`Test failed, output:\n${output}`);
        }
        expect(output).not.toContain("FAILED");
    };

    it("should pass 6502 timing tests on BBC B", async () => {
        await doTest();
    });

    it("should pass 65C12 timing tests on Master", async () => {
        await doTest("Master");
    });
});
