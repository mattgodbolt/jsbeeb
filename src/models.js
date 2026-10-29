import { NoiseAwareWdFdc } from "./wd-fdc.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";
import * as opcodes from "./6502.opcodes.js";
import { AtomCpu6502, Cpu6502, NumRomBanks } from "./6502.js";
import { BBC, stringToBBCKeys } from "./keymap.js";
import { ATOM, stringToATOMKeys } from "./keymap-atom.js";

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
        this.isTest = false;
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

function pickAdfs(cmos) {
    cmos[19] = (cmos[19] & 0xf0) | 13;
    return cmos;
}

function pickAnfs(cmos) {
    cmos[19] = (cmos[19] & 0xf0) | 8;
    return cmos;
}

function pickDfs(cmos) {
    cmos[19] = (cmos[19] & 0xf0) | 9;
    return cmos;
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
// written through ROMSEL. Real boards: #1539.
const beebSwram = [
    true,
    true,
    true,
    true, // Dunjunz variants. Exile (not picky).
    true,
    true,
    true,
    true, // Crazee Rider.
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
];
const noSwram = Array(16).fill(false);
const masterSwram = [
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
];

export const allModels = [
    new Model({
        name: "BBC B with 8271 (DFS 1.2)",
        shortName: "BBC B",
        synonyms: ["B-DFS1.2", "BBC B with DFS 1.2"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B with 8271 (DFS 0.9)",
        shortName: "BBC B",
        synonyms: ["B-DFS0.9", "B", "BBC B with DFS 0.9"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B with 1770 (DFS)",
        shortName: "BBC B",
        synonyms: ["B1770"],
        os: ["os.rom", "BASIC.ROM", "b1770/dfs1770.rom", "b1770/zADFS.ROM"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareWdFdc,
    }),
    // putting ADFS in a higher ROM slot gives it priority
    new Model({
        name: "BBC B with 1770 (ADFS)",
        shortName: "BBC B",
        synonyms: ["B1770A"],
        os: ["os.rom", "BASIC.ROM", "b1770/zADFS.ROM", "b1770/dfs1770.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareWdFdc,
    }),
    new Model({
        name: "BBC B (stock)",
        shortName: "BBC B",
        synonyms: ["B-stock"],
        // The unexpanded machine, fitted per the board's legends: IC101 and IC100 "AUX ROM" (15, 14),
        // IC88 "DISC&NET ROM" (13), IC52 "BASIC ROM" (12).
        os: ["os.rom", "", "", "b/DFS-1.2.rom", "BASIC.ROM"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: noSwram,
        romSockets: 4,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B (US)",
        shortName: "BBC B",
        synonyms: ["B-US"],
        os: ["usmos.rom", "us/USBASIC.rom", "us/USDNFS.rom"],
        idleAddress: 0xe556,
        vsyncAddress: 0xdcec,
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B (German)",
        shortName: "BBC B",
        synonyms: ["B-German"],
        os: ["deos.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B (MOS 0.10)",
        shortName: "BBC B",
        synonyms: ["B-MOS0.10"],
        // MOS 0.10 looks for a language only at ROMSEL 0 to 3, which the four sockets alias, and has no DFS.
        os: ["os01.rom", "", "", "", "a01/BASIC1.rom"],
        idleAddress: 0xe598,
        vsyncAddress: 0xdf12,
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: noSwram,
        romSockets: 4,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC Master 128 (DFS)",
        shortName: "Master 128",
        synonyms: ["Master"],
        os: ["master/mos3.20"],
        cpuModel: CpuModel.CMOS65C12,
        isMaster: true,
        clockMhz: 2,
        swram: masterSwram,
        fdc: NoiseAwareWdFdc,
        cmosOverride: pickDfs,
    }),
    new Model({
        name: "BBC Master 128 (ADFS)",
        shortName: "Master 128",
        synonyms: ["MasterADFS"],
        os: ["master/mos3.20"],
        cpuModel: CpuModel.CMOS65C12,
        isMaster: true,
        clockMhz: 2,
        swram: masterSwram,
        fdc: NoiseAwareWdFdc,
        cmosOverride: pickAdfs,
    }),
    new Model({
        name: "BBC Master 128 (ANFS)",
        shortName: "Master 128",
        synonyms: ["MasterANFS"],
        os: ["master/mos3.20"],
        cpuModel: CpuModel.CMOS65C12,
        isMaster: true,
        clockMhz: 2,
        swram: masterSwram,
        fdc: NoiseAwareWdFdc,
        cmosOverride: pickAnfs,
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
    for (let i = 0; i < allModels.length; ++i) {
        const model = allModels[i];
        if (model.name.toLowerCase() === name) return model;
        for (let j = 0; j < model.synonyms.length; ++j) {
            if (model.synonyms[j].toLowerCase() === name) return model;
        }
    }
    return null;
}

export const DefaultModel = findModel("B-DFS1.2");

export const TEST_6502 = new Model({
    name: "TEST",
    synonyms: ["TEST"],
    os: [],
    clockMhz: 2,
    cpuModel: CpuModel.MOS6502,
    isMaster: false,
    swram: beebSwram,
    fdc: NoiseAwareIntelFdc,
});
TEST_6502.isTest = true;
export const TEST_65C02 = new Model({
    name: "TEST",
    synonyms: ["TEST"],
    os: [],
    clockMhz: 2,
    cpuModel: CpuModel.CMOS65C02,
    isMaster: false,
    swram: masterSwram,
    fdc: NoiseAwareIntelFdc,
});
TEST_65C02.isTest = true;
export const TEST_65C12 = new Model({
    name: "TEST",
    synonyms: ["TEST"],
    os: [],
    clockMhz: 2,
    cpuModel: CpuModel.CMOS65C12,
    isMaster: false,
    swram: masterSwram,
    fdc: NoiseAwareIntelFdc,
});
TEST_65C12.isTest = true;

export const basicOnly = new Model({
    name: "Basic only",
    clockMhz: 2,
    synonyms: ["Basic only"],
    os: ["master/mos3.20"],
    cpuModel: CpuModel.CMOS65C12,
    isMaster: true,
    swram: masterSwram,
    fdc: NoiseAwareWdFdc,
});

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

// After the isTest assignments above, so those still apply.
for (const model of [...allModels, TEST_6502, TEST_65C02, TEST_65C12, basicOnly]) {
    Object.freeze(model.os);
    Object.freeze(model.synonyms);
    Object.freeze(model);
}
Object.freeze(allModels);
