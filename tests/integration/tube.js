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

    it("restores the parasite to exactly where it was", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const cpu = machine.processor;
        cpu.execute(200 * 1000);

        const state = cpu.snapshotState();
        cpu.execute(200 * 1000);
        cpu.restoreState(state);

        expect(cpu.snapshotState().tube).toEqual(state.tube);
    });

    it("keeps the parasite running identically after a restore", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const cpu = machine.processor;
        cpu.execute(200 * 1000);

        const state = cpu.snapshotState();
        cpu.execute(100 * 1000);
        const expected = { pc: cpu.tube.pc, memory: cpu.tube.memory.slice() };

        cpu.restoreState(state);
        cpu.execute(100 * 1000);

        expect(cpu.tube.pc).toBe(expected.pc);
        expect(cpu.tube.memory).toEqual(expected.memory);
    });

    it("resets the parasite when restoring state that has none", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const cpu = machine.processor;
        cpu.execute(200 * 1000);
        const state = cpu.snapshotState();
        delete state.tube; // as a pre-v3 snapshot would be

        cpu.restoreState(state);

        expect(cpu.tube.romPaged).toBe(true);
        expect(cpu.tube.pc).toBe(cpu.tube.readmem(0xfffc) | (cpu.tube.readmem(0xfffd) << 8));
    });

    it("runs the parasite at the requested multiple of the host clock", async () => {
        const machine = new TestMachine("Master", { tube: true, tubeCpuMultiplier: 4 });
        await machine.initialise();

        expect(machine.processor.tube.cpuMultiplier).toBe(4);
    });
});
