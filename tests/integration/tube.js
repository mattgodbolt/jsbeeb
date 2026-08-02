import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

// The ULA's M flag, which lets pending R3 data raise the parasite's NMI.
const TubeStatusEnableParasiteNmiFromR3 = 0x08;

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

    it("raises a parasite NMI the restored state was owed but had not seen", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const cpu = machine.processor;
        cpu.execute(200 * 1000);
        const state = cpu.snapshotState();

        // As an imported snapshot can be: the ULA has R3 data pending with NMI enabled, but the
        // parasite's own idea of the line predates it.
        state.tube.nmiLevel = false;
        state.tube.nmiEdge = false;
        state.tube.ula.internalStatusRegister |= TubeStatusEnableParasiteNmiFromR3;
        state.tube.ula.parasiteToHostFifoByteCount3 = 0;

        cpu.restoreState(state);

        expect(cpu.tube._nmiLevel).toBe(true);
        expect(cpu.tube._nmiEdge).toBe(true);
    });

    it("does not take a latched NMI across a parasite reset", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        const parasite = machine.processor.tube;
        parasite.NMI(true);
        expect(parasite._nmiEdge).toBe(true);

        parasite.reset(true);

        expect(parasite._nmiEdge).toBe(false);
        expect(parasite.takeInt).toBe(false);
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

    it("boots the language across the tube at the default speed", async () => {
        const machine = new TestMachine("Master", { tube: true });
        await machine.initialise();
        machine.startCapture();

        await machine.runFor(4 * 1000 * 1000);

        // The prompt only arrives if the parasite kept up with the MOS's unhandshaken R3
        // transfer: the ULA drops bytes the host never re-checks, and a part-copied BASIC hangs.
        expect(machine.drainText({ raw: true })).toContain("BASIC\n\n>");
    });

    it("boots the language across the external second processor", async () => {
        const machine = new TestMachine("B-DFS1.2", { tube: true });
        await machine.initialise();
        machine.startCapture();

        await machine.runFor(4 * 1000 * 1000);

        // The client ROM's boot uses none of the opcodes the CPU variants disagree about, so
        // this only guards against the wedge breaking outright, not against the wrong variant.
        const text = machine.drainText({ raw: true });
        expect(text).toContain("Acorn TUBE 6502 64K");
        expect(text).toContain("BASIC\n\n>");
    });

    it("passes the requested multiplier on to the parasite", async () => {
        const machine = new TestMachine("Master", { tube: true, tubeCpuMultiplier: 4 });
        await machine.initialise();

        expect(machine.processor.tube.cpuMultiplier).toBe(4);
    });
});
