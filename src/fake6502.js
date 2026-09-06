// Fakes out various 6502s for testing purposes.

import { FakeAtomVideo, FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { TEST_6502, TEST_65C02, TEST_65C12, tubeModelFor } from "./models.js";
import { machineSpec, nullIo } from "./machine-spec.js";

const fakeVideo = new FakeVideo();
const soundChip = new FakeSoundChip();

export function fake6502(model, opts = {}) {
    model = model || TEST_6502;
    return new model.Cpu(model, {
        ...nullIo({
            video: opts.video ?? (model.isAtom ? new FakeAtomVideo() : fakeVideo),
            soundChip: opts.soundChip ?? soundChip,
        }),
        config: machineSpec({
            tube: opts.tube ? tubeModelFor(model) : null,
            tubeCpuMultiplier: opts.tubeCpuMultiplier,
            cpuMultiplier: opts.cpuMultiplier,
            hasTeletextAdaptor: opts.hasTeletextAdaptor,
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
