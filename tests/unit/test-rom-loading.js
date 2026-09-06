import { describe, it, expect } from "vitest";
import { TEST_6502 } from "../../src/models.js";
import { buildMachine, machineSpec, nullIo } from "../../src/build-machine.js";

function makeCpu() {
    return buildMachine({ model: TEST_6502, spec: machineSpec(), io: nullIo() });
}

// TEST_6502 has eight sideways RAM banks, leaving eight for extra ROMs.
const NumFreeRomBanks = 8;

describe("Cpu6502 extra ROM loading", () => {
    it("loads extra ROMs into every free sideways bank", async () => {
        const cpu = makeCpu();
        await cpu.loadOs("os.rom", ...Array(NumFreeRomBanks).fill("BASIC.ROM"));
    });

    it("throws when extra ROMs exceed the free sideways banks", async () => {
        const cpu = makeCpu();
        await expect(cpu.loadOs("os.rom", ...Array(NumFreeRomBanks + 1).fill("BASIC.ROM"))).rejects.toThrow(
            "Too many extra ROMs",
        );
    });
});
