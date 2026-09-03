import { describe, expect, it } from "vitest";

import { machineSpec } from "../../src/machine-spec.js";

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

    it("refuses a field it does not know", () => {
        expect(() => machineSpec({ keylayout: "natural" })).toThrow("Unknown machine spec fields: keylayout");
    });

    it("cannot be changed afterwards", () => {
        const spec = machineSpec();
        expect(Object.isFrozen(spec)).toBe(true);
        expect(Object.isFrozen(spec.extraRoms)).toBe(true);
        expect(Object.isFrozen(spec.debugFlags)).toBe(true);
    });
});
