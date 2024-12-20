import { describe, it } from "vitest";
import assert from "assert";
import * as utils from "../../src/utils.js";
import { TestMachine } from "../test-machine.js";

describe("test various NOP timings", { timeout: 30000 }, function () {
    it("should match the nops.bas code", async () => {
        const testMachine = new TestMachine("Master");
        await testMachine.initialise();
        await testMachine.runUntilInput();
        const data = await utils.loadData("tests/integration/nops.bas");
        await testMachine.loadBasic(utils.uint8ArrayToString(data));

        let numCaptures = 0;
        testMachine.captureText((elem) => {
            assert(elem.background !== 1, `Failure from test - ${JSON.stringify(elem)}`);
            console.log(`emulator output: ${elem.text}`);
            numCaptures++;
        });
        await testMachine.type("RUN");
        await testMachine.runUntilInput(2 * 60);
        assert(numCaptures === 97, "Missing output");
    });
});
