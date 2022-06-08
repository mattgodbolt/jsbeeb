import * as utils from "../../utils.js";
import { describe, it } from "mocha";
import { TestMachine } from "./test-machine.js";
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
