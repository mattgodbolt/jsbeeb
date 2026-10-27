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
        const loadStockOs = (extraRoms) =>
            new stock.Cpu(stock, { ...nullIo(), config: machineSpec() }).loadOs(
                "os.rom",
                ...Array(extraRoms).fill("BASIC.ROM"),
            );

        it("loads extra ROMs into all four sockets", async () => {
            await loadStockOs(4);
        });

        it("throws rather than load a ROM no ROMSEL value reaches", async () => {
            await expect(loadStockOs(5)).rejects.toThrow("Too many extra ROMs");
        });
    });
});
