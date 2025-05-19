import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
import assert from "assert";

describe("test binary coded decimal behaviour", { timeout: 30000 }, function () {
    const doTest = async (model) => {
        const testMachine = new TestMachine(model);
        await testMachine.initialise();
        await testMachine.loadDisc("discs/bcdtest.ssd");
        await testMachine.runUntilInput();
        await testMachine.type("*BCDTEST");
        let output = "";
        testMachine.captureText((elem) => (output += elem.text));
        await testMachine.runUntilInput();
        assert(output.indexOf("PASSED") >= 0, `Failed with ${output}`);
    };
    it("should match on 65C12", async () => {
        await doTest("Master");
    });
    it("should match on 6502", async () => {
        await doTest();
    });
});
