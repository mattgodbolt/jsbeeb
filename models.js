"use strict";

import { WD1770 } from "./fdc.js";
import { IntelFdc } from "./intel-fdc.js";

class Model {
    constructor(name, synonyms, os, nmos, isMaster, swram, fdc, tube, cmosOverride) {
        this.name = name;
        this.synonyms = synonyms;
        this.os = os;
        this.nmos = nmos;
        this.isMaster = isMaster;
        this.Fdc = fdc;
        this.swram = swram;
        this.isTest = false;
        this.tube = tube;
        this.cmosOverride = cmosOverride;
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
class IntelFdcAdapter extends IntelFdc {
    constructor(cpu, ddNoise, scheduler, debugFlags) {
        super(cpu, scheduler, undefined, debugFlags);
        let nextSeekTime = 0;
        let numSpinning = 0;
        // Update the spin status shortly after the drive state changes to debounce it slightly.
        const updateSpinStatus = () => {
            if (numSpinning) ddNoise.spinUp(); else ddNoise.spinDown();
        };
        for (const drive of this.drives) {
            drive.addEventListener("startSpinning", () => { numSpinning++; setTimeout(updateSpinStatus, 2); });
            drive.addEventListener("stopSpinning", () => { --numSpinning; setTimeout(updateSpinStatus, 2); });
            drive.addEventListener("step", (evt) => {
                const now = Date.now();
                if (now > nextSeekTime)
                    nextSeekTime = now + ddNoise.seek(evt.stepAmount);
            });
        }
    }
}
export const allModels = [
    new Model(
        "BBC B with DFS 1.2",
        ["B-DFS1.2"],
        ["os.rom", "BASIC.ROM", "b/DFS-1.2.rom"],
        true,
        false,
        beebSwram,
        IntelFdcAdapter,
    ),
    new Model(
        "BBC B with DFS 0.9",
        ["B-DFS0.9", "B"],
        ["os.rom", "BASIC.ROM", "b/DFS-0.9.rom"],
        true,
        false,
        beebSwram,
        IntelFdcAdapter,
    ),
    new Model(
        "BBC B with 1770 (DFS)",
        ["B1770"],
        ["os.rom", "BASIC.ROM", "b1770/dfs1770.rom", "b1770/zADFS.ROM"],
        true,
        false,
        beebSwram,
        WD1770,
    ),
    // putting ADFS in a higher ROM slot gives it priority
    new Model(
        "BBC B with 1770 (ADFS)",
        ["B1770A"],
        ["os.rom", "BASIC.ROM", "b1770/zADFS.ROM", "b1770/dfs1770.rom"],
        true,
        false,
        beebSwram,
        WD1770,
    ),
    new Model("BBC Master 128 (DFS)", ["Master"], ["master/mos3.20"], false, true, masterSwram, WD1770, null, pickDfs),
    new Model(
        "BBC Master 128 (ADFS)",
        ["MasterADFS"],
        ["master/mos3.20"],
        false,
        true,
        masterSwram,
        WD1770,
        null,
        pickAdfs,
    ),
    new Model(
        "BBC Master 128 (ANFS)",
        ["MasterANFS"],
        ["master/mos3.20"],
        false,
        true,
        masterSwram,
        WD1770,
        null,
        pickAnfs,
    ),
    new Model("Tube65C02", [], ["tube/6502Tube.rom"], false, false), // Although this can not be explicitly selected as a model, it is required by the configuration builder later
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

export const TEST_6502 = new Model("TEST", ["TEST"], [], true, false, beebSwram, IntelFdcAdapter);
TEST_6502.isTest = true;
export const TEST_65C12 = new Model("TEST", ["TEST"], [], false, false, masterSwram, IntelFdcAdapter);
TEST_65C12.isTest = true;

export const basicOnly = new Model("Basic only", ["Basic only"], ["master/mos3.20"], false, true, masterSwram, WD1770);
