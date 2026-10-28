// Fakes out various 6502s for testing purposes.

import { FakeAtomVideo, FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { TEST_6502, TEST_65C02, TEST_65C12, tubeModelFor } from "./models.js";
import { machineSpec, nullIo } from "./machine-spec.js";
import { DefaultStationId, Econet, FileServerStationId, MasterAnfsRom } from "./econet.js";

const soundChip = new FakeSoundChip();

function econetFor(model, { econet, stationId }) {
    if (!econet) {
        if (stationId !== undefined) throw new Error("A station number needs Econet fitted");
        return null;
    }
    const station = stationId ?? DefaultStationId;
    if (!Number.isInteger(station) || station < 1 || station >= FileServerStationId)
        throw new Error(
            `Station ${station} is not 1 to ${FileServerStationId - 1}; the file server is ${FileServerStationId}`,
        );
    return new Econet(station, model.cyclesPerSecond);
}

export function fake6502(model, opts = {}) {
    model = model || TEST_6502;
    const econet = econetFor(model, opts);
    return new model.Cpu(model, {
        ...nullIo({
            video: opts.video ?? (model.isAtom ? new FakeAtomVideo() : new FakeVideo()),
            soundChip: opts.soundChip ?? soundChip,
            econet,
            model,
        }),
        config: machineSpec({
            tube: opts.tube ? tubeModelFor(model) : null,
            tubeCpuMultiplier: opts.tubeCpuMultiplier,
            cpuMultiplier: opts.cpuMultiplier,
            hasMusic5000: opts.hasMusic5000,
            hasTeletextAdaptor: opts.hasTeletextAdaptor,
            fittedRoms: econet && model.isMaster ? [MasterAnfsRom] : [],
            bankRoms: opts.bankRoms,
            extraRoms: opts.extraRoms,
        }),
        cycleAccurate: opts.cycleAccurate,
    });
}

export function fake65C02() {
    return fake6502(TEST_65C02);
}

export function fake65C12() {
    return fake6502(TEST_65C12);
}
