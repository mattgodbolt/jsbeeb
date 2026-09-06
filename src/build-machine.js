import { AtomCpu6502, Cpu6502 } from "./6502.js";
import { Cmos } from "./cmos.js";
import { FakeDdNoise } from "./ddnoise.js";
import { FakeMusic5000 } from "./music5000.js";
import { FakeRelayNoise } from "./relaynoise.js";
import { FakeSoundChip } from "./soundchip.js";
import { FakeVideo } from "./video.js";

const NullUserPort = {
    write() {},
    read() {
        return 0xff;
    },
};

const SpecBrand = Symbol("machineSpec");

const SpecDefaults = {
    keyLayout: "physical",
    cpuMultiplier: 1,
    tubeCpuMultiplier: 1,
    videoCyclesBatch: 0,
    tube: null,
    hasMusic5000: false,
    hasTeletextAdaptor: false,
    extraRoms: [],
    userPort: NullUserPort,
    printerPort: null,
    getGamepads: () => [],
    debugFlags: { logFdcCommands: false, logFdcStateChanges: false },
};

/**
 * What a machine is fitted with and how it is driven, complete and frozen:
 * every field is present, an unknown one is an error, and an undefined
 * override means the default. The CPU takes nothing else.
 */
export function machineSpec(overrides = {}) {
    const unknown = Object.keys(overrides).filter((field) => !Object.hasOwn(SpecDefaults, field));
    if (unknown.length) throw new Error(`Unknown machine spec fields: ${unknown.join(", ")}`);
    const given = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
    return Object.freeze({
        [SpecBrand]: true,
        ...SpecDefaults,
        ...given,
        extraRoms: Object.freeze([...(given.extraRoms ?? SpecDefaults.extraRoms)]),
        debugFlags: Object.freeze({ ...SpecDefaults.debugFlags, ...given.debugFlags }),
    });
}

/** Whether `config` was made by machineSpec(), and so is complete and unchanged. */
export function isMachineSpec(config) {
    return config?.[SpecBrand] === true;
}

/** The processor for `model`, fitted as `spec` says, talking to the peripherals in `io`. */
export function buildMachine({ model, spec, io, cycleAccurate = true }) {
    if (!isMachineSpec(spec)) throw new Error("A machine's config must come from machineSpec()");
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
