import { describe, expect, it } from "vitest";

import { TestMachine } from "../../src/test-machine.js";
import { mode7Text } from "./helpers.js";

describe("TestMachine", () => {
    const fx19Loop = 'FOR I%=1 TO 5:OSCLI "FX19":NEXT:PRINT "SYN";"CED"';

    it("returns from *FX19", async () => {
        const machine = new TestMachine();
        await machine.initialise();
        await machine.runUntilInput();
        await machine.type(fx19Loop);
        await machine.runUntilInput(5);
        expect(mode7Text(machine)).toContain("SYNCED");
    });

    it("keeps each machine's vsync its own", async () => {
        const machine = new TestMachine();
        await machine.initialise();
        await new TestMachine().initialise();
        await machine.runUntilInput();
        await machine.type(fx19Loop);
        await machine.runUntilInput(5);
        expect(mode7Text(machine)).toContain("SYNCED");
    });

    it("boots a Master with ANFS, which waits for vsync, to a prompt", async () => {
        const machine = new TestMachine("MasterANFS", { econet: true });
        await machine.initialise();
        await machine.runUntilInput(10);
        expect(mode7Text(machine)).toContain("BASIC");
    });
});
