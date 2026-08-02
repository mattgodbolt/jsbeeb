import { describe, it, expect } from "vitest";
import { allModels, basicOnly, findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";

describe("Model", () => {
    it("is frozen so per-session settings cannot be stored on it", () => {
        const master = findModel("Master");

        expect(Object.isFrozen(master)).toBe(true);
        expect(() => (master.hasEconet = true)).toThrow(TypeError);
    });

    it("freezes every model and its rom list", () => {
        for (const model of [...allModels, TEST_6502, TEST_65C02, TEST_65C12, basicOnly]) {
            expect(Object.isFrozen(model), `${model.name} should be frozen`).toBe(true);
            expect(Object.isFrozen(model.os), `${model.name} os should be frozen`).toBe(true);
        }
    });

    it("carries no per-session settings", () => {
        const master = findModel("Master");

        expect(master.tube).toBeUndefined();
        expect(master.hasEconet).toBeUndefined();
        expect(master.hasMusic5000).toBeUndefined();
        expect(master.hasTeletextAdaptor).toBeUndefined();
    });
});

const IncA = 0x1a; // Absent from the NMOS 6502, present on every CMOS part.
const Smb0Zp = 0x87; // Present only on Rockwell parts; a one-byte undefined NOP on the rest.
// Doubles as SMB0's operand and, on the parts where SMB0 is a one-byte NOP, as the NOP that
// then runs in its place, so the two cases differ only in the byte SMB0 would have touched.
const ScratchZp = 0xea;

/** Assemble `program` into the parasite's RAM and run it from a known register state. */
function runOnParasite(model, program, { a = 0, x = 0 } = {}) {
    const ProgramStart = 0x1000;
    const parasite = fake6502(findModel(model), { tube: true }).tube;
    parasite.romPaged = false;
    parasite.memory.fill(0xea); // NOP, so whatever follows the program is harmless
    parasite.memory[ScratchZp] = 0;
    parasite.memory.set(program, ProgramStart);
    parasite.pc = ProgramStart;
    parasite.a = a;
    parasite.x = x;
    // Tube6502.execute does nothing at all with fewer than three parasite cycles banked, so
    // ask for enough host cycles to clear that on the slower of the two parasite clocks.
    parasite.execute(4);
    return parasite;
}

describe("fake6502 tube handling", () => {
    it("attaches a tube when asked", () => {
        const cpu = fake6502(findModel("Master"), { tube: true });

        expect(cpu.hasTube).toBe(true);
        expect(cpu.tube.cpuMultiplier).toBe(1);
    });

    it("attaches no tube by default", () => {
        expect(fake6502(findModel("Master"), {}).hasTube).toBe(false);
    });

    it("does not leak the tube into later machines using the same model", () => {
        fake6502(findModel("Master"), { tube: true });

        expect(fake6502(findModel("Master"), {}).hasTube).toBe(false);
    });

    it("honours a tube cpu multiplier", () => {
        const cpu = fake6502(findModel("Master"), { tube: true, tubeCpuMultiplier: 4 });

        expect(cpu.tube.cpuMultiplier).toBe(4);
    });

    it("fits a Master with the 4MHz Turbo board", () => {
        const cpu = fake6502(findModel("Master"), { tube: true });

        expect(cpu.tube.cyclesPerHostCycle).toBe(2);
    });

    it("fits a BBC B with the 3MHz external second processor", () => {
        const cpu = fake6502(findModel("B-DFS1.2"), { tube: true });

        expect(cpu.tube.cyclesPerHostCycle).toBe(1.5);
    });

    it("gives both co-processors the CMOS additions", () => {
        expect(runOnParasite("B-DFS1.2", [IncA], { a: 0x41 }).a).toBe(0x42);
        expect(runOnParasite("Master", [IncA], { a: 0x41 }).a).toBe(0x42);
    });

    it("gives the Rockwell bit instructions to the Turbo alone", () => {
        // Same program either side, so the difference can only be the CPU. The Turbo keeps the
        // superset deliberately: real ADC06 boards are reported with both Rockwell and GTE parts.
        expect(runOnParasite("B-DFS1.2", [Smb0Zp, ScratchZp]).memory[ScratchZp]).toBe(0);
        expect(runOnParasite("Master", [Smb0Zp, ScratchZp]).memory[ScratchZp]).toBe(1);
    });

    it("runs the parasite the given multiple of its clock", () => {
        const nopsIn = (multiplier, hostCycles) => {
            const cpu = fake6502(findModel("Master"), { tube: true, tubeCpuMultiplier: multiplier });
            cpu.tube.memory.fill(0xea);
            cpu.tube.romPaged = false;
            cpu.tube.pc = 0x1000;
            cpu.tube.execute(hostCycles);
            return (cpu.tube.pc - 0x1000) & 0xffff;
        };

        // A NOP is two parasite cycles, so a 4MHz Turbo runs one per 2MHz host cycle.
        expect(nopsIn(1, 1000)).toBe(1000);
        expect(nopsIn(1.6, 1000)).toBe(1600);
    });
});
