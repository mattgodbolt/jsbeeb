import { describe, it, expect } from "vitest";
import { findModel, TEST_6502 } from "../../src/models.js";
import { machineSpec, nullIo } from "../../src/machine-spec.js";

function makeCpu() {
    return new TEST_6502.Cpu(TEST_6502, { ...nullIo(), config: machineSpec() });
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

    describe("on the stock BBC B", () => {
        const stock = findModel("B-stock");
        const loadStock = async (extraRoms) => {
            const cpu = new stock.Cpu(stock, { ...nullIo(), config: machineSpec({ extraRoms }) });
            await cpu.loadOs(...stock.os);
            return cpu;
        };
        const romTitle = (cpu, bank) => String.fromCharCode(...cpu.romBank(bank).subarray(9, 12));

        it("puts BASIC in IC52 and the DFS in IC88, and extra ROMs in the two AUX sockets", async () => {
            const cpu = await loadStock(["ample.rom", "ats-3.0.rom"]);
            expect([12, 13, 14, 15].map((bank) => romTitle(cpu, bank))).toEqual(["BAS", "DFS", "ATS", "AMP"]);
        });

        const pagedTitle = (cpu) =>
            String.fromCharCode(...[9, 10, 11, 12, 13].map((offset) => cpu.readmem(0x8000 + offset)));

        it("powers on with IC52, BASIC, at &8000", async () => {
            const cpu = await loadStock([]);
            cpu.reset(true);
            expect(pagedTitle(cpu)).toBe("BASIC");
        });

        it("keeps BASIC paged when a program writes the Master's ACCCON value to &FE34", async () => {
            const cpu = await loadStock([]);
            cpu.writemem(0xfe34, 0x18);
            expect(pagedTitle(cpu)).toBe("BASIC");
        });

        it("throws rather than load a ROM no ROMSEL value reaches", async () => {
            await expect(loadStock(["ample.rom", "ats-3.0.rom", "ample.rom"])).rejects.toThrow("Too many extra ROMs");
        });
    });
});
