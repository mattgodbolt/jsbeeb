// Fakes out a 6502
"use strict";

import { FakeVideo } from "./video.js";
import { FakeSoundChip } from "./soundchip.js";
import { TEST_6502, TEST_65C12 } from "./models.js";
import { FakeDdNoise } from "./ddnoise.js";
import { Cpu6502 } from "./6502.js";
import { Cmos } from "./cmos.js";
import { FakeMusic5000 } from "./music5000.js";

var fakeVideo = new FakeVideo();
var soundChip = new FakeSoundChip();
var dbgr = {
    setCpu: function () {},
};

export function fake6502(model, opts) {
    opts = opts || {};
    var video = opts.video || fakeVideo;
    model = model || TEST_6502;
    return new Cpu6502(model, dbgr, video, soundChip, new FakeDdNoise(), new FakeMusic5000(), new Cmos());
}

export function fake65C12() {
    return fake6502(TEST_65C12);
}
