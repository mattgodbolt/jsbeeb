import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";

describe("test Kevin Edwards' gnarly protection system", { timeout: 10000 }, function () {
    const doTest = async (name) => {
        const testMachine = new TestMachine();
        await testMachine.initialise();
        await testMachine.loadDisc("discs/Protection.ssd");
        await testMachine.runUntilInput();
        await testMachine.type(`CHAIN "B.${name}"`);
        const hook = testMachine.processor.debugInstruction.add((addr) => {
            return addr === 0xfff4 && testMachine.processor.a === 200 && testMachine.processor.x === 3;
        });
        await testMachine.runUntilAddress(0xe00, 20);
        hook.remove();
    };
    it("should decode Alien8", async () => {
        await doTest("ALIEN8");
    });
    it("should decode Nightshade", async () => {
        await doTest("NIGHTSH");
    });
    it("should decode Lunar Jetman", async () => {
        await doTest("JETMAN");
    });
});
