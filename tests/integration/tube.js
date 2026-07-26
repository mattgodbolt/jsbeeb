import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

describe("Tube co-processor", () => {
    it("runs the parasite processor alongside the host", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const parasite = machine.processor.tube;
        const startPc = parasite.pc;

        machine.processor.execute(200 * 1000);

        expect(machine.processor.hasTube).toBe(true);
        expect(parasite.pc).not.toBe(startPc);
    });

    it("leaves the parasite absent when no co-processor is fitted", async () => {
        const machine = new TestMachine("Master");
        await machine.initialise();

        machine.processor.execute(200 * 1000);

        expect(machine.processor.hasTube).toBe(false);
        expect(machine.processor.tube.pc).toBeUndefined();
    });

    it("runs the parasite at the requested multiple of the host clock", async () => {
        const machine = new TestMachine("Master", { tube: true, tubeCpuMultiplier: 4 });
        await machine.initialise();

        expect(machine.processor.tube.cpuMultiplier).toBe(4);
    });
});
