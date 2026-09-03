import { describe, expect, it } from "vitest";

import { TestMachine } from "../test-machine.js";
import { mode7Text } from "./helpers.js";

describe("reset", () => {
    const booted = async () => {
        const machine = new TestMachine();
        await machine.initialise();
        await machine.runUntilInput();
        await machine.type('10 PRINT "KEPT"');
        await machine.runUntilInput();
        return machine;
    };

    it("comes back to the prompt from a soft reset with the program still in memory", async () => {
        const machine = await booted();
        machine.reset(false);
        await machine.runUntilInput();
        expect(mode7Text(machine)).toContain("BASIC");
        await machine.type("OLD");
        await machine.runUntilInput();
        await machine.type("LIST");
        await machine.runUntilInput();
        expect(mode7Text(machine)).toContain('10 PRINT "KEPT"');
    });

    it("comes back to the prompt from a hard reset with the screen cleared", async () => {
        const machine = await booted();
        expect(mode7Text(machine)).toContain("KEPT");
        machine.reset(true);
        await machine.runUntilInput();
        expect(mode7Text(machine)).toContain("BASIC");
        expect(mode7Text(machine)).not.toContain("KEPT");
    });
});
