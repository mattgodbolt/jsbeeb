// Fakes out various 6502s for testing purposes.
"use strict";

import { FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { findModel, TEST_6502, TEST_65C02, TEST_65C12 } from "./models.js";
import { FakeDdNoise } from "./ddnoise.js";
import { Cpu6502 } from "./6502.js";
import { Cmos } from "./cmos.js";
import { FakeMusic5000 } from "./music5000.js";

const fakeVideo = new FakeVideo();
const soundChip = new FakeSoundChip();
const dbgr = {
    setCpu: () => {},
};

export function fake6502(model, opts) {
    opts = opts || {};
    const video = opts.video || fakeVideo;
    model = model || TEST_6502;
    if (opts.tube) model.tube = findModel("Tube65c02");
    return new Cpu6502(model, dbgr, video, soundChip, new FakeDdNoise(), new FakeMusic5000(), new Cmos());
}

export function fake65C02() {
    return fake6502(TEST_65C02);
}

export function fake65C12() {
    return fake6502(TEST_65C12);
}
