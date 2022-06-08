import { describe, it } from "mocha";
import assert from "assert";
import * as Tokeniser from "../../basic-tokenise.js";
import * as utils from "../../utils.js";
import { TestMachine } from "./test-machine.js";

describe("test various NOP timings", function () {
    this.timeout(30000);
    it("should match the nops.bas code", async () => {
        const testMachine = new TestMachine("Master");
        await testMachine.initialise();
        await testMachine.runUntilInput();
        const tokeniser = await Tokeniser.create();
        const data = await utils.loadData("tests/integration/nops.bas");
        const tokenised = tokeniser.tokenise(utils.uint8ArrayToString(data));

        // TODO: dedupe from main.js
        const page = testMachine.readbyte(0x18) << 8;
        for (let i = 0; i < tokenised.length; ++i) {
            testMachine.writebyte(page + i, tokenised.charCodeAt(i));
        }
        // Set VARTOP (0x12/3) and TOP(0x02/3)
        const end = page + tokenised.length;
        const endLow = end & 0xff;
        const endHigh = (end >>> 8) & 0xff;
        testMachine.writebyte(0x02, endLow);
        testMachine.writebyte(0x03, endHigh);
        testMachine.writebyte(0x12, endLow);
        testMachine.writebyte(0x13, endHigh);

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
