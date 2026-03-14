"use strict";

import { NoiseAwareWdFdc } from "./wd-fdc.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";
import * as opcodes from "./6502.opcodes.js";

const CpuModel = Object.freeze({
    MOS6502: 0,
    CMOS65C02: 1,
    CMOS65C12: 2,
});

class Model {
    constructor({ name, synonyms, os, cpuModel, isMaster, swram, fdc, tube, cmosOverride } = {}) {
        this.name = name;
        this.synonyms = synonyms;
        this.os = os;
        this._cpuModel = cpuModel;
        this.isMaster = isMaster;
        this.Fdc = fdc;
        this.swram = swram;
        this.isTest = false;
        this.tube = tube;
        this.cmosOverride = cmosOverride;
        this.hasEconet = false;
        this.hasMusic5000 = false;
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
        name: "BBC B with DFS 1.2",
        synonyms: ["B-DFS1.2"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B with DFS 0.9",
        synonyms: ["B-DFS0.9", "B"],
        os: ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
        swram: beebSwram,
        fdc: NoiseAwareIntelFdc,
    }),
    new Model({
        name: "BBC B with 1770 (DFS)",
        synonyms: ["B1770"],
        os: ["os.rom", "BASIC.ROM", "b1770/dfs1770.rom", "b1770/zADFS.ROM"],
        cpuModel: CpuModel.MOS6502,
        isMaster: false,
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
        swram: beebSwram,
        fdc: NoiseAwareWdFdc,
    }),
    new Model({
        name: "BBC Master 128 (DFS)",
        synonyms: ["Master"],
        os: ["master/mos3.20"],
        cpuModel: CpuModel.CMOS65C12,
        isMaster: true,
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
        swram: masterSwram,
        fdc: NoiseAwareWdFdc,
        cmosOverride: pickAnfs,
    }),
    // Although this can not be explicitly selected as a model, it is required by the configuration builder later
    new Model({
        name: "Tube65C02",
        synonyms: [],
        os: ["tube/6502Tube.rom"],
        cpuModel: CpuModel.CMOS65C02,
        isMaster: false,
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
    cpuModel: CpuModel.CMOS65C12,
    isMaster: false,
    swram: masterSwram,
    fdc: NoiseAwareIntelFdc,
});
TEST_65C12.isTest = true;

export const basicOnly = new Model({
    name: "Basic only",
    synonyms: ["Basic only"],
    os: ["master/mos3.20"],
    cpuModel: CpuModel.CMOS65C12,
    isMaster: true,
    swram: masterSwram,
    fdc: NoiseAwareWdFdc,
});
