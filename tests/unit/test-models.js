import { describe, it, expect } from "vitest";
import { allModels, basicOnly, DefaultModel, findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";
import { guessModelFromHostname } from "../../src/url-params.js";

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

    it("reports its clock in cycles per second", () => {
        expect(findModel("Master").cyclesPerSecond).toBe(2 * 1000 * 1000);
        expect(findModel("Atom").cyclesPerSecond).toBe(1 * 1000 * 1000);
    });

    it("carries no per-session settings", () => {
        const master = findModel("Master");

        expect(master.tube).toBeUndefined();
        expect(master.hasEconet).toBeUndefined();
        expect(master.hasMusic5000).toBeUndefined();
        expect(master.hasTeletextAdaptor).toBeUndefined();
    });
});

describe("findModel", () => {
    it("finds models by name and by synonym", () => {
        expect(findModel("BBC Master 128 (DFS)").name).toBe("BBC Master 128 (DFS)");
        expect(findModel("master")).toBe(findModel("BBC Master 128 (DFS)"));
    });

    it("has nothing for a name it does not know", () => {
        expect(findModel("bbcb")).toBeNull();
    });

    it("has a default to fall back on", () => {
        expect(findModel(DefaultModel.name)).toBe(DefaultModel);
    });

    it("knows every model the hostname can ask for", () => {
        for (const hostname of ["bbc.xania.org", "master.example.com", "atom.example.com", "localhost"])
            expect(findModel(guessModelFromHostname(hostname)), hostname).not.toBeNull();
    });
});

const IncA = 0x1a;
const Smb0Zp = 0x87; // A Rockwell instruction; a one-byte NOP on the base CMOS parts.
// Chosen to be NOP, so it is harmless when read as an opcode rather than as SMB0's operand.
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
    parasite.execute(4); // Below three parasite cycles, execute does nothing at all.
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
        // Same program either side, so the difference can only be the CPU.
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
