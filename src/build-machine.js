import { AtomCpu6502, Cpu6502 } from "./6502.js";
import { Cmos } from "./cmos.js";
import { FakeDdNoise } from "./ddnoise.js";
import { FakeMusic5000 } from "./music5000.js";
import { FakeRelayNoise } from "./relaynoise.js";
import { FakeSoundChip } from "./soundchip.js";
import { FakeVideo } from "./video.js";

/** The processor for `model`, fitted as `spec` says, talking to the peripherals in `io`. */
export function buildMachine({ model, spec, io, cycleAccurate = true }) {
    const CpuClass = model.isAtom ? AtomCpu6502 : Cpu6502;
    return new CpuClass(model, { ...io, config: spec, cycleAccurate });
}

/** Peripherals that go nowhere, for a machine run headless. */
export function nullIo({ video = new FakeVideo(), soundChip = new FakeSoundChip() } = {}) {
    return {
        dbgr: { setCpu() {} },
        video,
        soundChip,
        ddNoise: new FakeDdNoise(),
        relayNoise: new FakeRelayNoise(),
        music5000: new FakeMusic5000(),
        cmos: new Cmos(),
        econet: null,
    };
}
