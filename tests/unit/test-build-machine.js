import { describe, expect, it, vi } from "vitest";

import { AtomCpu6502, Cpu6502 } from "../../src/6502.js";
import { buildMachine, isMachineSpec, machineSpec, nullIo } from "../../src/build-machine.js";
import { TEST_6502, findModel } from "../../src/models.js";

describe("buildMachine", () => {
    const build = (model, spec = machineSpec()) => buildMachine({ model, spec, io: nullIo() });

    it("builds the processor the model calls for", () => {
        expect(build(TEST_6502)).toBeInstanceOf(Cpu6502);
        expect(build(findModel("Atom"))).toBeInstanceOf(AtomCpu6502);
    });

    it("fits the machine as the spec says", () => {
        const cpu = build(TEST_6502, machineSpec({ cpuMultiplier: 2, keyLayout: "natural" }));
        expect(cpu.cpuMultiplier).toBe(2);
        expect(cpu.keyLayout).toBe("natural");
        expect(cpu.hasTube).toBe(false);
    });

    it("refuses a config that did not come from machineSpec, frozen or missing", () => {
        expect(() => build(TEST_6502, { keyLayout: "physical" })).toThrow("must come from machineSpec()");
        expect(() => build(TEST_6502, Object.freeze({ keyLayout: "physical" }))).toThrow(
            "must come from machineSpec()",
        );
        expect(() => buildMachine({ model: TEST_6502, spec: undefined, io: nullIo() })).toThrow(
            "must come from machineSpec()",
        );
    });

    it("changes the key layout for the keyboard and for the next reset alike", () => {
        const cpu = build(TEST_6502);
        const viaLayout = vi.spyOn(cpu.sysvia, "setKeyLayout");
        cpu.setKeyLayout("gaming");
        expect(cpu.keyLayout).toBe("gaming");
        expect(viaLayout).toHaveBeenCalledWith("gaming");
    });
});

describe("machineSpec", () => {
    it("fills in everything a machine needs by default", () => {
        const spec = machineSpec();
        expect(spec.keyLayout).toBe("physical");
        expect(spec.cpuMultiplier).toBe(1);
        expect(spec.tube).toBeNull();
        expect(spec.extraRoms).toEqual([]);
        expect(spec.userPort.read()).toBe(0xff);
        expect(spec.debugFlags).toEqual({ logFdcCommands: false, logFdcStateChanges: false });
    });

    it("takes what it is given and ignores an undefined override", () => {
        const spec = machineSpec({ cpuMultiplier: 2, tubeCpuMultiplier: undefined, extraRoms: ["a.rom"] });
        expect(spec.cpuMultiplier).toBe(2);
        expect(spec.tubeCpuMultiplier).toBe(1);
        expect(spec.extraRoms).toEqual(["a.rom"]);
    });

    it("refuses a field it does not know, including one every object inherits", () => {
        expect(() => machineSpec({ keylayout: "natural" })).toThrow("Unknown machine spec fields: keylayout");
        expect(() => machineSpec({ toString: () => "" })).toThrow("Unknown machine spec fields: toString");
    });

    it("can tell its own specs from look-alikes", () => {
        expect(isMachineSpec(machineSpec())).toBe(true);
        expect(isMachineSpec(Object.freeze({ keyLayout: "physical" }))).toBe(false);
        expect(isMachineSpec(undefined)).toBe(false);
    });

    it("cannot be changed afterwards", () => {
        const spec = machineSpec();
        expect(Object.isFrozen(spec)).toBe(true);
        expect(Object.isFrozen(spec.extraRoms)).toBe(true);
        expect(Object.isFrozen(spec.debugFlags)).toBe(true);
    });
});
