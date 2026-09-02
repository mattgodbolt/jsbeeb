import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fake6502 } from "../../src/fake6502.js";
import { findModel } from "../../src/models.js";
import * as utils from "../../src/utils.js";
import * as archive from "../../src/archive.js";

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
        const loadData = vi.spyOn(utils, "loadData").mockResolvedValue(new Uint8Array(AtomRomSize));
        const cpu = makeAtom();
        await cpu.loadRom("extra.rom", cpu.romOffset);
        expect(loadData).toHaveBeenCalledWith("roms/extra.rom");
    });

    it("loads http URLs without a roms/ prefix", async () => {
        const loadData = vi.spyOn(utils, "loadData").mockResolvedValue(new Uint8Array(AtomRomSize));
        const cpu = makeAtom();
        await cpu.loadRom("https://example.com/extra.rom", cpu.romOffset);
        expect(loadData).toHaveBeenCalledWith("https://example.com/extra.rom");
    });

    it("unzips zipped ROM images", async () => {
        const zipped = new Uint8Array(readFileSync(join(__dirname, "zip", "test-atom-rom.zip")));
        const loadData = vi.spyOn(utils, "loadData").mockResolvedValue(zipped);
        const unzip = vi.spyOn(archive, "unzipRomImage");
        const cpu = makeAtom();
        await expect(cpu.loadRom("extra.zip", cpu.romOffset)).resolves.toBeUndefined();
        expect(loadData).toHaveBeenCalledWith("roms/extra.zip");
        expect(unzip).toHaveBeenCalledOnce();
    });

    it("rejects ROMs of the wrong size", async () => {
        vi.spyOn(utils, "loadData").mockResolvedValue(new Uint8Array(24));
        const cpu = makeAtom();
        await expect(cpu.loadRom("extra.rom", cpu.romOffset)).rejects.toThrow("Broken ROM file");
    });
});
