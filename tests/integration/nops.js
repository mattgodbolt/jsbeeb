import { describe, it } from "vitest";
import assert from "assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TestMachine } from "../test-machine.js";
import { RepoRoot } from "./helpers.js";

describe("test various NOP timings", function () {
    it("should match the nops.bas code", async () => {
        const testMachine = new TestMachine("Master");
        await testMachine.initialise();
        await testMachine.runUntilInput();
        await testMachine.loadBasic(readFileSync(path.join(RepoRoot, "tests/integration/nops.bas"), "latin1"));

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
