import { describe, it, expect } from "vitest";
import { Cpu6502 } from "../../src/6502.js";
import { TEST_6502 } from "../../src/models.js";
import { FakeVideo } from "../../src/video.js";
import { FakeSoundChip } from "../../src/soundchip.js";
import { FakeDdNoise } from "../../src/ddnoise.js";
import { FakeMusic5000 } from "../../src/music5000.js";
import { Cmos } from "../../src/cmos.js";
import { machineSpec } from "../../src/machine-spec.js";

function makeCpu() {
    return new Cpu6502(TEST_6502, {
        dbgr: { setCpu: () => {} },
        video: new FakeVideo(),
        soundChip: new FakeSoundChip(),
        ddNoise: new FakeDdNoise(),
        music5000: new FakeMusic5000(),
        cmos: new Cmos(),
        config: machineSpec(),
    });
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
