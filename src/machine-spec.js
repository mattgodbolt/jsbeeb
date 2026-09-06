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
 * override means the default. It is the `config` a CPU is built with.
 */
export function machineSpec(overrides = {}) {
    const unknown = Object.keys(overrides).filter((field) => !Object.hasOwn(SpecDefaults, field));
    if (unknown.length) throw new Error(`Unknown machine spec fields: ${unknown.join(", ")}`);
    const given = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
    return Object.freeze({
        ...SpecDefaults,
        ...given,
        extraRoms: Object.freeze([...(given.extraRoms ?? SpecDefaults.extraRoms)]),
        debugFlags: Object.freeze({ ...SpecDefaults.debugFlags, ...given.debugFlags }),
    });
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
