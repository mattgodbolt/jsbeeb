import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { findModel, TEST_6502 } from "../../src/models.js";
import { machineSpec, nullIo } from "../../src/machine-spec.js";

function makeCpu() {
    return new TEST_6502.Cpu(TEST_6502, { ...nullIo(), config: machineSpec() });
}

const romTitle = (cpu, bank) => String.fromCharCode(...cpu.romBank(bank).subarray(9, 12));

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
        const loadStock = async (extraRoms, spec) => {
            const cpu = new stock.Cpu(stock, { ...nullIo(), config: machineSpec({ ...spec, extraRoms }) });
            await cpu.loadOs(...stock.os);
            return cpu;
        };

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

        it("throws, starting no load, rather than load a ROM no ROMSEL value reaches", async () => {
            await expect(loadStock(["missing.rom", "ats-3.0.rom", "ample.rom"])).rejects.toThrow("Too many extra ROMs");
        });

        it("puts a named ROM in an AUX socket, a fitting's in the other and an extra ROM nowhere", async () => {
            const spec = { fittedRoms: ["ats-3.0.rom"], bankRoms: [{ bank: 14, rom: "ample.rom" }] };
            const cpu = await loadStock([], spec);
            expect([14, 15].map((bank) => romTitle(cpu, bank))).toEqual(["AMP", "ATS"]);
            await expect(loadStock(["ample.rom"], spec)).rejects.toThrow("Too many extra ROMs");
        });

        it.each([
            [8, "has 4 ROM sockets, banks 12 to 15"],
            [12, "which already holds BASIC.ROM"],
        ])("refuses to name bank %i", async (bank, reason) => {
            await expect(loadStock([], { bankRoms: [{ bank, rom: "ample.rom" }] })).rejects.toThrow(reason);
        });
    });
});

describe("Cpu6502 ROM loading into a named bank", () => {
    afterEach(() => vi.restoreAllMocks());

    const load = async (modelName, spec) => {
        const model = findModel(modelName);
        const cpu = new model.Cpu(model, { ...nullIo(), config: machineSpec(spec) });
        await cpu.loadOs(...model.os);
        return cpu;
    };
    const pagedByteAfterWrite = (cpu, bank) => {
        cpu.romSelect(bank);
        cpu.writemem(0x8000, cpu.readmem(0x8000) ^ 0xff);
        return cpu.readmem(0x8000);
    };

    it("loads it there, and the extra ROMs into the highest banks left after it and the fittings' ROMs", async () => {
        const cpu = await load("B-DFS1.2", {
            fittedRoms: ["ats-3.0.rom"],
            bankRoms: [{ bank: 12, rom: "ample.rom" }],
            extraRoms: ["ats-3.0.rom"],
        });
        expect([13, 12, 11].map((bank) => romTitle(cpu, bank))).toEqual(["ATS", "AMP", "ATS"]);
    });

    it("keeps a ROM in a sideways RAM bank writable, and one in a ROM bank not", async () => {
        const cpu = await load("Master", {
            bankRoms: [
                { bank: 7, rom: "ample.rom" },
                { bank: 8, rom: "ats-3.0.rom" },
            ],
        });
        expect([7, 8].map((bank) => romTitle(cpu, bank))).toEqual(["AMP", "ATS"]);
        const [ramByte, romByte] = [cpu.romBank(7)[0], cpu.romBank(8)[0]];
        expect(pagedByteAfterWrite(cpu, 7)).toBe(ramByte ^ 0xff);
        expect(pagedByteAfterWrite(cpu, 8)).toBe(romByte);
    });

    it.each([
        ["B-DFS1.2", 15, {}, "BASIC.ROM"],
        ["Master", 12, {}, "a ROM from roms/master/mos3.20"],
        ["Master", 8, { fittedRoms: ["master/anfs-4.25.rom"] }, "master/anfs-4.25.rom"],
    ])("refuses a bank the %s fills already, a fitting's ROM included", async (modelName, bank, spec, holder) => {
        await expect(load(modelName, { ...spec, bankRoms: [{ bank, rom: "ample.rom" }] })).rejects.toThrow(
            `Can't load ample.rom into ROM bank ${bank}, which already holds ${holder}`,
        );
    });

    it("refuses bank 16, which no ROMSEL value names", async () => {
        await expect(load("B-DFS1.2", { bankRoms: [{ bank: 16, rom: "ample.rom" }] })).rejects.toThrow(
            "ROM bank 16: the BBC B with 8271 (DFS 1.2) has 16 ROM sockets, banks 0 to 15",
        );
    });

    it("refuses a bank named twice", async () => {
        const bankRoms = [
            { bank: 7, rom: "missing.rom" },
            { bank: 7, rom: "ats-3.0.rom" },
        ];
        await expect(load("B-DFS1.2", { bankRoms })).rejects.toThrow(
            "Can't load ats-3.0.rom into ROM bank 7, which already holds missing.rom",
        );
    });

    it("refuses on the Atom, which has no sideways banks", async () => {
        await expect(load("Atom", { bankRoms: [{ bank: 7, rom: "ample.rom" }] })).rejects.toThrow(
            "The Atom has no sideways ROM banks",
        );
    });

    it("fetches a github: reference from the repo's raw file", async () => {
        const image = new Uint8Array(readFileSync("public/roms/ample.rom"));
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(image));
        const cpu = await load("Master", { bankRoms: [{ bank: 7, rom: "github:mattgodbolt/xmos/original.rom" }] });
        expect(fetch).toHaveBeenCalledWith("https://raw.githubusercontent.com/mattgodbolt/xmos/HEAD/original.rom");
        expect(cpu.romBank(7)).toEqual(image);
    });
});
