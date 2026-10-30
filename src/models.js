import { NoiseAwareWdFdc } from "./wd-fdc.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";
import * as opcodes from "./6502.opcodes.js";
import { AtomCpu6502, Cpu6502, NumRomBanks } from "./6502.js";
import { BBC, BbcGamepadKeys, stringToBBCKeys } from "./keymap.js";
import { ATOM, AtomGamepadKeys, stringToATOMKeys } from "./keymap-atom.js";

const CpuModel = Object.freeze({
    MOS6502: 0,
    CMOS65C02: 1,
    CMOS65C12: 2,
});

/**
 * Describes what a machine *is*: which CPU, which ROMs, which disc controller.
 * Anything a user can turn on and off for a session (second processor, Econet,
 * Music 5000, teletext adaptor) belongs in the emulation config passed to Cpu6502.
 *
 * Instances are shared process-wide via `allModels` and frozen, so they can be handed
 * to any number of machines without one session's settings leaking into the next.
 */
class Model {
    constructor({
        name,
        shortName = name,
        synonyms,
        os,
        cpuModel,
        isMaster,
        isAtom,
        swram,
        romSockets,
        fdc,
        cmosOverride,
        banks,
        clockMhz,
        idleAddress,
        vsyncAddress,
        isTest,
    } = {}) {
        if (!(clockMhz > 0)) throw new Error(`Model ${name} has no clock speed`);
        this.name = name;
        this.shortName = shortName;
        this.synonyms = synonyms;
        this.os = os;
        this.clockMhz = clockMhz;
        this.banks = banks;
        this._cpuModel = cpuModel;
        this.isMaster = isMaster;
        this.isAtom = !!isAtom;
        // The one place the two machine families part: everything else asks the model.
        this.Cpu = this.isAtom ? AtomCpu6502 : Cpu6502;
        this.keys = this.isAtom ? ATOM : BBC;
        this.gamepadKeys = this.isAtom ? AtomGamepadKeys : BbcGamepadKeys;
        this.stringToKeys = this.isAtom ? stringToATOMKeys : stringToBBCKeys;
        // The OS write-character vector, watched to capture what the machine prints.
        this.wrchvAddress = this.isAtom ? 0x0208 : 0x020e;
        // Where the machine sits waiting for a key: BASIC's read loop, or on the Atom the kernel's
        // wait-for-key scan at $FEA7. The scan before it at $FE9F only checks every key is up, and a
        // 100 ms debounce delay follows, during which a key pressed is not seen.
        this.idleAddress = idleAddress ?? (this.isAtom ? 0xfea7 : isMaster ? 0xe7e6 : 0xe581);
        // The OS's vertical sync interrupt handler, or null where none is known.
        this.vsyncAddress = vsyncAddress ?? (this.isAtom || isMaster ? null : 0xdd15);
        // The Atom ROM polls its keyboard once per VSync, so pasted keys need longer apart.
        this.pasteKeyDelayMs = this.isAtom ? 80 : 50;
        // Two of those 60 Hz scans, 33 ms, with margin: the ROM wants a key seen up
        // twice before it takes the next.
        this.pasteReleaseGapMs = this.isAtom ? 40 : 0;
        this.Fdc = fdc;
        this.swram = swram;
        // How many sockets ROMSEL decodes: they fill the top banks, and every bank number pages the socket its low
        // bits pick. A Model B without a sideways board decodes two bits, for four.
        this.romSockets = romSockets ?? NumRomBanks;
        this.isTest = !!isTest;
        this.cmosOverride = cmosOverride;
    }

    /**
     * How many CPU cycles this machine runs in a second. Everything that
     * converts between real time and emulated cycles should ask here rather
     * than assuming a clock speed.
     */
    get cyclesPerSecond() {
        return this.clockMhz * 1000 * 1000;
    }

    get nmos() {
        return this._cpuModel === CpuModel.MOS6502;
    }

    get opcodesFactory() {
        switch (this._cpuModel) {
            case CpuModel.MOS6502:
                return opcodes.Cpu6502;
            case CpuModel.CMOS65C02:
                return opcodes.Cpu65c02;
            case CpuModel.CMOS65C12:
                return opcodes.Cpu65c12;
        }
        throw new Error("Unknown CPU model");
    }
}

const FilingSystemCmosByte = 19;
const MasterAnfsRom = 8;
const MasterDfsRom = 9;
const MasterAdfsRom = 13;

// The low nibble of the filing system byte is the ROM the Master boots its filing system from.
function bootFilingSystemRom(rom) {
    return (cmos) => {
        cmos[FilingSystemCmosByte] = (cmos[FilingSystemCmosByte] & 0xf0) | rom;
        return cmos;
    };
}

function atomModel({ name, synonyms, os, banks }) {
    return new Model({
        name,
        shortName: "Atom",
        synonyms,
        os,
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 1,
        isAtom: true,
        swram: noSwram,
        fdc: NoiseAwareIntelFdc,
        banks,
    });
}

// A convenience layout for the expanded B models, not any real board's: all sixteen banks decoded, and RAM in 0-7
// written through ROMSEL (0-3 for the Dunjunz variants, 4-7 for Crazee Rider; Exile is not picky). Real boards: #1539.
const beebSwram = Array.from({ length: NumRomBanks }, (_, bank) => bank < 8);
const noSwram = Array(NumRomBanks).fill(false);
const masterSwram = Array.from({ length: NumRomBanks }, (_, bank) => bank >= 4 && bank < 8);

function bbcBModel(fields) {
    return new Model({
        shortName: "BBC B",
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
        ...fields,
    });
}

function masterModel(fields) {
    return new Model({
        shortName: "Master 128",
        os: ["master/mos3.20"],
        cpuModel: CpuModel.CMOS65C12,
        isMaster: true,
        clockMhz: 2,
        swram: masterSwram,
        fdc: NoiseAwareWdFdc,
        ...fields,
    });
}

function testModel(cpuModel, swram) {
    return new Model({
        name: "TEST",
        synonyms: ["TEST"],
        os: [],
        clockMhz: 2,
        cpuModel,
        isMaster: false,
        swram,
        fdc: NoiseAwareIntelFdc,
        isTest: true,
    });
}

export const allModels = [
    bbcBModel({
        name: "BBC B with 8271 (DFS 1.2)",
        synonyms: ["B-DFS1.2", "BBC B with DFS 1.2"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
    }),
    bbcBModel({
        name: "BBC B with 8271 (DFS 0.9)",
        synonyms: ["B-DFS0.9", "B", "BBC B with DFS 0.9"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"],
    }),
    bbcBModel({
        name: "BBC B with 1770 (DFS)",
        synonyms: ["B1770"],
        os: ["os.rom", "BASIC.ROM", "b1770/dfs1770.rom", "b1770/zADFS.ROM"],
        fdc: NoiseAwareWdFdc,
    }),
    // putting ADFS in a higher ROM slot gives it priority
    bbcBModel({
        name: "BBC B with 1770 (ADFS)",
        synonyms: ["B1770A"],
        os: ["os.rom", "BASIC.ROM", "b1770/zADFS.ROM", "b1770/dfs1770.rom"],
        fdc: NoiseAwareWdFdc,
    }),
    bbcBModel({
        name: "BBC B (stock)",
        synonyms: ["B-stock"],
        // The unexpanded machine, fitted per the board's legends: IC101 and IC100 "AUX ROM" (15, 14),
        // IC88 "DISC&NET ROM" (13), IC52 "BASIC ROM" (12).
        os: ["os.rom", "", "", "b/DFS-1.2.rom", "BASIC.ROM"],
        swram: noSwram,
        romSockets: 4,
    }),
    bbcBModel({
        name: "BBC B (US)",
        synonyms: ["B-US"],
        os: ["usmos.rom", "us/USBASIC.rom", "us/USDNFS.rom"],
        idleAddress: 0xe556,
        vsyncAddress: 0xdcec,
    }),
    bbcBModel({
        name: "BBC B (German)",
        synonyms: ["B-German"],
        os: ["deos.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
    }),
    bbcBModel({
        name: "BBC B (MOS 0.10)",
        synonyms: ["B-MOS0.10"],
        // MOS 0.10 looks for a language only at ROMSEL 0 to 3, which the four sockets alias, and has no DFS.
        os: ["os01.rom", "", "", "", "a01/BASIC1.rom"],
        idleAddress: 0xe598,
        vsyncAddress: 0xdf12,
        swram: noSwram,
        romSockets: 4,
    }),
    masterModel({
        name: "BBC Master 128 (DFS)",
        synonyms: ["Master"],
        cmosOverride: bootFilingSystemRom(MasterDfsRom),
    }),
    masterModel({
        name: "BBC Master 128 (ADFS)",
        synonyms: ["MasterADFS"],
        cmosOverride: bootFilingSystemRom(MasterAdfsRom),
    }),
    masterModel({
        name: "BBC Master 128 (ANFS)",
        synonyms: ["MasterANFS"],
        cmosOverride: bootFilingSystemRom(MasterAnfsRom),
    }),
    // Atom OS ROM layout: Block F (kernel), E (DOS/MMC), D (FP), C (BASIC).
    // Empty strings represent unpopulated ROM slots.
    atomModel({
        name: "Acorn Atom (MMC)",
        synonyms: ["Atom"],
        os: ["atom/Atom_Kernel_E.rom", "atom/ATMMC3E.rom", "atom/Atom_FloatingPoint.rom", "atom/Atom_Basic.rom"],
        // Utility ROMs in banks 0 and 1 of Block A (0xA000-0xAFFF), up to 8 banks.
        // Bank selected by Branquart latch at 0xBFFF (bits 0-3 = bank, bit 6 = lock).
        banks: ["atom/PCHARME.ROM", "atom/gags.rom"],
    }),
    atomModel({
        name: "Acorn Atom (Tape)",
        synonyms: ["Atom-Tape"],
        os: ["atom/Atom_Kernel.rom", "", "", "atom/Atom_Basic.rom"],
    }),
    atomModel({
        name: "Acorn Atom (Tape with FP)",
        synonyms: ["Atom-Tape-FP"],
        os: ["atom/Atom_Kernel.rom", "", "atom/Atom_FloatingPoint.rom", "atom/Atom_Basic.rom"],
    }),
    atomModel({
        name: "Acorn Atom (DOS)",
        synonyms: ["Atom-DOS"],
        os: ["atom/Atom_Kernel.rom", "atom/Atom_DOS.rom", "atom/Atom_FloatingPoint.rom", "atom/Atom_Basic.rom"],
    }),
    // Neither can be selected as a model: they are fitted to one, by the configuration builder later.
    new Model({
        name: "Tube65C02",
        synonyms: [],
        os: ["tube/6502Tube.rom"],
        // The production wedge's GTE 65SC02 has no Rockwell bit instructions.
        cpuModel: CpuModel.CMOS65C12,
        isMaster: false,
        clockMhz: 3,
    }),
    new Model({
        name: "Tube65C102",
        synonyms: [],
        os: ["tube/65C102Tube.rom"],
        // Boards are reported with both Rockwell and GTE parts, so keep the superset of the two
        // until #756 lets the fitted co-processor be chosen.
        cpuModel: CpuModel.CMOS65C02,
        isMaster: false,
        clockMhz: 4,
    }),
];

export function findModel(name) {
    name = name.toLowerCase();
    return allModels.find((model) => [model.name, ...model.synonyms].some((n) => n.toLowerCase() === name)) ?? null;
}

export const DefaultModel = findModel("B-DFS1.2");

export const TEST_6502 = testModel(CpuModel.MOS6502, beebSwram);
export const TEST_65C02 = testModel(CpuModel.CMOS65C02, masterSwram);
export const TEST_65C12 = testModel(CpuModel.CMOS65C12, masterSwram);

export const basicOnly = masterModel({ name: "Basic only", shortName: "Basic only", synonyms: ["Basic only"] });

/**
 * The second processors jsbeeb emulates: the external 3MHz box, and the Master Turbo's
 * internal 4MHz board. Machine-building code passes one of these as the emulation config's
 * `tube`, so that 6502.js needn't import this module and close an import cycle via the FDC
 * modules.
 */
export const TubeModel = findModel("Tube65C02");
const TurboTubeModel = findModel("Tube65C102");

/** @returns {Model} the second processor sold for this machine: the Turbo board for a Master. */
export function tubeModelFor(model) {
    return model.isMaster ? TurboTubeModel : TubeModel;
}

for (const model of [...allModels, TEST_6502, TEST_65C02, TEST_65C12, basicOnly]) {
    Object.freeze(model.os);
    Object.freeze(model.synonyms);
    Object.freeze(model);
}
Object.freeze(allModels);
