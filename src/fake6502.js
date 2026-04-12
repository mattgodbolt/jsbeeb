// Fakes out various 6502s for testing purposes.
"use strict";

import { FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "./models.js";
import { FakeDdNoise } from "./ddnoise.js";
import { FakeRelayNoise } from "./relaynoise.js";
import { Cpu6502, AtomCpu6502 } from "./6502.js";
import { Cmos } from "./cmos.js";
import { FakeMusic5000 } from "./music5000.js";

const fakeVideo = new FakeVideo();
const soundChip = new FakeSoundChip();
const dbgr = {
    setCpu: () => {},
};

export function fake6502(model, opts) {
    opts = opts || {};
    model = model || TEST_6502;
    if (opts.tube) model.tube = findModel("Tube65c02");
    const CpuClass = model.isAtom ? AtomCpu6502 : Cpu6502;
    return new CpuClass(model, {
        dbgr,
        video: opts.video || fakeVideo,
        soundChip: opts.soundChip || soundChip,
        ddNoise: new FakeDdNoise(),
        relayNoise: new FakeRelayNoise(),
        music5000: new FakeMusic5000(),
        cmos: new Cmos(),
        cycleAccurate: opts.cycleAccurate,
    });
}

export function fake65C02() {
    return fake6502(TEST_65C02);
}

export function fake65C12() {
    return fake6502(TEST_65C12);
}
