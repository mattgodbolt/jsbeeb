"use strict";

import { NoiseAwareWdFdc } from "./wd-fdc.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";
import * as opcodes from "./6502.opcodes.js";

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
    constructor({ name, synonyms, os, cpuModel, isMaster, isAtom, swram, fdc, cmosOverride, banks, clockMhz } = {}) {
        if (!(clockMhz > 0)) throw new Error(`Model ${name} has no clock speed`);
        this.name = name;
        this.synonyms = synonyms;
        this.os = os;
        this.clockMhz = clockMhz;
        this.banks = banks;
        this._cpuModel = cpuModel;
        this.isMaster = isMaster;
        this.isAtom = !!isAtom;
        this.Fdc = fdc;
        this.swram = swram;
        this.isTest = false;
        this.cmosOverride = cmosOverride;
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
        synonyms,
        os,
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 1,
        isAtom: true,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
        banks,
    });
}

// TODO: semi-bplus-style to get swram for exile hardcoded here
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
        synonyms: ["B1770A"],
        os: ["os.rom", "BASIC.ROM", "b1770/zADFS.ROM", "b1770/dfs1770.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        clockMhz: 2,
        swram: beebSwram,
        fdc: NoiseAwareWdFdc,
    }),
    new Model({
        name: "BBC Master 128 (DFS)",
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
        // Boards are reported with both Rockwell and GTE parts, so keep the superset of the two.
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
export const TurboTubeModel = findModel("Tube65C102");

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
