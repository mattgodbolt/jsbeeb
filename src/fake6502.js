// Fakes out various 6502s for testing purposes.

import { FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { TEST_6502, TEST_65C02, TEST_65C12, tubeModelFor } from "./models.js";
import { buildMachine, nullIo } from "./build-machine.js";
import { machineSpec } from "./machine-spec.js";

const fakeVideo = new FakeVideo();
const soundChip = new FakeSoundChip();

export function fake6502(model, opts = {}) {
    model = model || TEST_6502;
    return buildMachine({
        model,
        spec: machineSpec({
            tube: opts.tube ? tubeModelFor(model) : null,
            tubeCpuMultiplier: opts.tubeCpuMultiplier,
            cpuMultiplier: opts.cpuMultiplier,
            hasTeletextAdaptor: opts.hasTeletextAdaptor,
        }),
        io: nullIo({ video: opts.video ?? fakeVideo, soundChip: opts.soundChip ?? soundChip }),
        cycleAccurate: opts.cycleAccurate,
    });
}

export function fake65C02() {
    return fake6502(TEST_65C02);
}

export function fake65C12() {
    return fake6502(TEST_65C12);
}
