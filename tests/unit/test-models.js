import { describe, it, expect } from "vitest";
import { allModels, basicOnly, DefaultModel, findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "../../src/models.js";
import { fake6502 } from "../../src/fake6502.js";
import { guessModelFromHostname } from "../../src/url-params.js";
import { AtomCpu6502, Cpu6502 } from "../../src/6502.js";
import { BBC } from "../../src/keymap.js";
import { ATOM } from "../../src/keymap-atom.js";

describe("Model", () => {
    it("freezes every model and its rom list", () => {
        for (const model of [...allModels, TEST_6502, TEST_65C02, TEST_65C12, basicOnly]) {
            expect(Object.isFrozen(model), `${model.name} should be frozen`).toBe(true);
            expect(Object.isFrozen(model.os), `${model.name} os should be frozen`).toBe(true);
        }
    });

    it("gives the Atom no sideways RAM", () => {
        for (const model of allModels.filter(({ isAtom }) => isAtom)) {
            expect(
                model.swram.some((isRam) => isRam),
                model.name,
            ).toBe(false);
        }
    });

    it("reports its clock in cycles per second", () => {
        expect(findModel("Master").cyclesPerSecond).toBe(2 * 1000 * 1000);
        expect(findModel("Atom").cyclesPerSecond).toBe(1 * 1000 * 1000);
    });

    it("has a short name for the top bar, and every selectable model has one", () => {
        const shortNames = Object.fromEntries(allModels.map((model) => [model.name, model.shortName]));
        expect(shortNames).toEqual({
            "BBC B with 8271 (DFS 1.2)": "BBC B",
            "BBC B with 8271 (DFS 0.9)": "BBC B",
            "BBC B with 1770 (DFS)": "BBC B",
            "BBC B with 1770 (ADFS)": "BBC B",
            "BBC B (stock)": "BBC B",
            "BBC B (US)": "BBC B",
            "BBC B (German)": "BBC B",
            "BBC B (MOS 0.10)": "BBC B",
            "BBC Master 128 (DFS)": "Master 128",
            "BBC Master 128 (ADFS)": "Master 128",
            "BBC Master 128 (ANFS)": "Master 128",
            "Acorn Atom (MMC)": "Atom",
            "Acorn Atom (Tape)": "Atom",
            "Acorn Atom (Tape with FP)": "Atom",
            "Acorn Atom (DOS)": "Atom",
            Tube65C02: "Tube65C02",
            Tube65C102: "Tube65C102",
        });
    });

    it("knows the shape of the machine it names", () => {
        const beeb = findModel("B-DFS1.2");
        const master = findModel("Master");
        const atom = findModel("Atom");
        expect([beeb.Cpu, atom.Cpu]).toEqual([Cpu6502, AtomCpu6502]);
        expect([beeb.wrchvAddress, atom.wrchvAddress]).toEqual([0x020e, 0x0208]);
        expect([beeb.idleAddress, master.idleAddress, atom.idleAddress]).toEqual([0xe581, 0xe7e6, 0xfea7]);
        expect([findModel("B-US").idleAddress, findModel("B-German").idleAddress]).toEqual([0xe556, 0xe581]);
        expect([beeb.vsyncAddress, findModel("B-US").vsyncAddress, master.vsyncAddress]).toEqual([
            0xdd15,
            0xdcec,
            null,
        ]);
        expect(beeb.keys).toBe(BBC);
        expect(atom.keys).toBe(ATOM);
        expect(beeb.stringToKeys("A")).toEqual([BBC.A]);
        expect(atom.pasteKeyDelayMs).toBeGreaterThan(beeb.pasteKeyDelayMs);
        expect([beeb.pasteReleaseGapMs, atom.pasteReleaseGapMs]).toEqual([0, 40]);
        expect([beeb, master, atom, findModel("Atom-DOS")].map((m) => m.hasDiscDrives)).toEqual([
            true,
            true,
            false,
            true,
        ]);
    });

    describe("the stock BBC B", () => {
        const sidewaysBytesAroundWrite = (modelName, bank) => {
            const cpu = fake6502(findModel(modelName));
            cpu.romSelect(bank);
            const before = cpu.readmem(0x8000);
            cpu.writemem(0x8000, before ^ 0xff);
            return { before, after: cpu.readmem(0x8000) };
        };

        it("is the default BBC B with no sideways RAM and only the motherboard's ROM sockets", () => {
            const stock = findModel("B-stock");
            const allButNameAndSideways = ({
                name: _name,
                synonyms: _synonyms,
                os: _os,
                swram: _swram,
                romSockets: _romSockets,
                ...rest
            }) => rest;
            expect(allButNameAndSideways(stock)).toEqual(allButNameAndSideways(DefaultModel));
            expect(stock.swram.some((isRam) => isRam)).toBe(false);
        });

        const bankPagedAtEachRomsel = (modelName) => {
            const cpu = fake6502(findModel(modelName));
            for (let bank = 0; bank < 16; ++bank) cpu.romBank(bank)[0] = bank;
            return [...Array(16).keys()].map((romsel) => {
                cpu.romSelect(romsel);
                return cpu.readmem(0x8000);
            });
        };

        it("pages its four sockets, banks 12 to 15, at every ROMSEL value", () => {
            expect(bankPagedAtEachRomsel("B-stock")).toEqual([
                12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15,
            ]);
        });

        it("leaves the BBC Bs with a sideways board sixteen separate banks", () => {
            expect(bankPagedAtEachRomsel("B-DFS1.2")).toEqual([...Array(16).keys()]);
        });

        it("ignores a write to a bank the other BBC Bs fill with RAM", () => {
            const ram = sidewaysBytesAroundWrite("B-DFS1.2", 4);
            expect(ram.after).toBe(ram.before ^ 0xff);
            const rom = sidewaysBytesAroundWrite("B-stock", 4);
            expect(rom.after).toBe(rom.before);
        });
    });

    it("powers on with ROMSEL 0's bank paged, whatever was paged before", () => {
        const cpu = fake6502(findModel("B-DFS1.2"));
        cpu.romSelect(5);
        cpu.reset(true);
        expect(cpu.pagedBank).toBe(0);
        cpu.writemem(0x8000, 0x5a);
        expect(cpu.readmem(0x8000)).toBe(0x5a);
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

    it("does not leak the tube into later machines using the same model", () => {
        fake6502(findModel("Master"), { tube: true });

        expect(fake6502(findModel("Master"), {}).hasTube).toBe(false);
    });

    it.each([
        ["a Master with the 4MHz Turbo board", "Master", 2],
        ["a BBC B with the 3MHz external second processor", "B-DFS1.2", 1.5],
    ])("fits %s", (_, model, cyclesPerHostCycle) => {
        expect(fake6502(findModel(model), { tube: true }).tube.cyclesPerHostCycle).toBe(cyclesPerHostCycle);
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

describe("the filing system a model boots into", () => {
    const FilingSystemRomAddress = 19;
    const filingSystemOf = (modelName) => fake6502(findModel(modelName)).cmos.store[FilingSystemRomAddress] & 0x0f;

    it("fits the filing system its model names", () => {
        expect(filingSystemOf("Master")).toBe(9);
        expect(filingSystemOf("MasterADFS")).toBe(13);
        expect(filingSystemOf("MasterANFS")).toBe(8);
    });
});
