import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import * as loader from "../../src/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const AtomRomSize = 4096;

function makeAtom() {
    return fake6502(findModel("Atom"));
}

describe("AtomCpu6502 loadRom", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prefixes local ROM names with roms/", async () => {
        const loadData = vi.spyOn(loader, "loadData").mockResolvedValue(new Uint8Array(AtomRomSize));
        const cpu = makeAtom();
        await cpu.loadRom("extra.rom", cpu.romOffset);
        expect(loadData).toHaveBeenCalledWith("roms/extra.rom");
    });

    it("loads http URLs without a roms/ prefix", async () => {
        const loadData = vi.spyOn(loader, "loadData").mockResolvedValue(new Uint8Array(AtomRomSize));
        const cpu = makeAtom();
        await cpu.loadRom("https://example.com/extra.rom", cpu.romOffset);
        expect(loadData).toHaveBeenCalledWith("https://example.com/extra.rom");
    });

    it("unzips zipped ROM images", async () => {
        const zipped = new Uint8Array(readFileSync(join(__dirname, "zip", "test-atom-rom.zip")));
        const loadData = vi.spyOn(loader, "loadData").mockResolvedValue(zipped);
        const cpu = makeAtom();
        await cpu.loadRom("extra.zip", cpu.romOffset);
        expect(loadData).toHaveBeenCalledWith("roms/extra.zip");
        expect([...cpu.ramRomOs.subarray(cpu.romOffset, cpu.romOffset + 4)]).toEqual([0x00, 0x07, 0x0e, 0x15]);
    });

    it("rejects ROMs of the wrong size", async () => {
        vi.spyOn(loader, "loadData").mockResolvedValue(new Uint8Array(24));
        const cpu = makeAtom();
        await expect(cpu.loadRom("extra.rom", cpu.romOffset)).rejects.toThrow("Broken ROM file");
    });
});
