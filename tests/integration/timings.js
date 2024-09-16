import { describe, it } from "vitest";
import { TestMachine } from "../test-machine.js";
import assert from "assert";

describe("test timings", function () {
    const doTest = async (model) => {
        const testMachine = new TestMachine(model);
        await testMachine.initialise();
        await testMachine.loadDisc("discs/TestTimings.ssd");
        await testMachine.runUntilInput();
        await testMachine.type('CHAIN "TEST"');
        await testMachine.runUntilInput();
        const result = [];
        const num = testMachine.readbyte(0x71) + 1;
        for (let i = 0; i < num; ++i) {
            const irqAddr = (testMachine.readbyte(0x4300 + i) << 8) | testMachine.readbyte(0x4000 + i);
            const a = testMachine.readbyte(0x4100 + i);
            const b = testMachine.readbyte(0x4200 + i);
            result.push([irqAddr, a, b]);
        }
        return result;
    };
    it("should match expected values", async () => {
        const result = await doTest();
        // prettier-ignore
        assert.deepStrictEqual(result,
            [
                [0x4436, 0x00, 0xDD],
                [0x4443, 0x00, 0xDD],
                [0x4450, 0x00, 0xDD],
                [0x445E, 0x00, 0xDD],
                [0x0000, 0x00, 0x00],
                [0x0000, 0x00, 0x00],
                [0x4488, 0x00, 0xFF],
                [0x4497, 0x00, 0x00],
                [0x0000, 0x00, 0x00],
                [0x44B8, 0xC0, 0xFF],
                [0x44C5, 0xC0, 0xFF],
                [0x0000, 0x00, 0x00],
                [0x0000, 0x00, 0x00],
                [0x44F6, 0xC0, 0xDB],
                [0x4506, 0xC0, 0xDC],
                [0x4516, 0xC0, 0xFF],
                [0x4527, 0xC0, 0x00],
                [0x453A, 0xC0, 0x01],
                [0x454A, 0xC0, 0x01],
                [0x4559, 0xC0, 0x00],
                [0x4569, 0xC0, 0x00],
                [0x4578, 0xC0, 0x01],
                [0x458A, 0xC0, 0xFF],
                [0x4599, 0xC0, 0x00],
                [0x45A6, 0xC0, 0x00],
                [0x0000, 0x00, 0x00]
            ]);
    });
});
