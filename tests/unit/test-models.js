import { describe, it, expect } from "vitest";
import { allModels, basicOnly, findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";
import { DefaultTubeCpuMultiplier } from "../../src/6502.js";

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

describe("fake6502 tube handling", () => {
    it("attaches a tube when asked", () => {
        const cpu = fake6502(findModel("Master"), { tube: true });

        expect(cpu.hasTube).toBe(true);
        expect(cpu.tube.cpuMultiplier).toBe(DefaultTubeCpuMultiplier);
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
});

describe("tube cpu speed", () => {
    /** @returns {number} how many two-cycle NOPs the parasite gets through in `hostCycles`, run one at a time. */
    function nopsRun(multiplier, hostCycles) {
        const tube = fake6502(findModel("Master"), { tube: true, tubeCpuMultiplier: multiplier }).tube;
        tube.romPaged = false;
        tube.memory.fill(0xea);
        tube.pc = 0x1000;
        for (let i = 0; i < hostCycles; ++i) tube.execute(1);
        return tube.pc - 0x1000;
    }

    it("carries the half cycles the 3MHz parasite is owed each host cycle", () => {
        expect(nopsRun(1, 2000)).toBe(1500);
    });

    it("carries the part cycles a fractional multiplier leaves over", () => {
        // 5MHz is two and a half parasite cycles per host cycle: 1200 of them is exactly 1500 NOPs.
        expect(nopsRun(5 / 3, 1200)).toBe(1500);
    });

    it("gets a third more done at the Master Turbo's 4MHz", () => {
        expect(nopsRun(4 / 3, 3000)).toBe(3000);
        expect(nopsRun(1, 3000)).toBe(2250);
    });
});
