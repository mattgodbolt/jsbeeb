import { describe, expect, it, vi } from "vitest";

import { machineSpec, nullIo } from "../../src/machine-spec.js";
import { TEST_6502 } from "../../src/models.js";

describe("a CPU fitted from a spec", () => {
    const build = (spec = machineSpec()) => new TEST_6502.Cpu(TEST_6502, { ...nullIo(), config: spec });

    it("is fitted as the spec says", () => {
        const cpu = build(machineSpec({ cpuMultiplier: 2, keyLayout: "natural" }));
        expect(cpu.cpuMultiplier).toBe(2);
        expect(cpu.keyLayout).toBe("natural");
        expect(cpu.hasTube).toBe(false);
    });

    it("changes the key layout for the keyboard and for the next reset alike", () => {
        const cpu = build();
        const viaLayout = vi.spyOn(cpu.sysvia, "setKeyLayout");
        cpu.setKeyLayout("gaming");
        expect(cpu.keyLayout).toBe("gaming");
        expect(viaLayout).toHaveBeenCalledWith("gaming");
    });

    it.each([0xfc00, 0xfc08, 0xfc80, 0xfcf0])("maps a fitted MIDI interface at %s", (midiAddress) => {
        const sendByte = vi.fn();
        const cpu = build(machineSpec({ hasMidiInterface: true, midiAddress, midiOutput: { sendByte } }));

        expect(cpu.peekDevice(midiAddress) & 0x02).toBe(0x02);
        cpu.writeDevice(midiAddress + 1, 0x90);
        expect(sendByte).toHaveBeenCalledWith(0x90);
        expect(cpu.readDevice(midiAddress) & 0x02).toBe(0);

        cpu.scheduler.polltime(640);
        expect(cpu.peekDevice(midiAddress) & 0x02).toBe(0x02);
        expect(cpu.readDevice(midiAddress) & 0x02).toBe(0x02);
    });
});

describe("machineSpec", () => {
    it("fills in everything a machine needs by default", () => {
        const spec = machineSpec();
        expect(spec.keyLayout).toBe("physical");
        expect(spec.cpuMultiplier).toBe(1);
        expect(spec.tube).toBeNull();
        expect(spec.midiAddress).toBe(0xfc00);
        expect(spec.extraRoms).toEqual([]);
        expect(spec.userPort.read()).toBe(0xff);
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

    it("cannot be changed afterwards", () => {
        const spec = machineSpec();
        expect(Object.isFrozen(spec)).toBe(true);
        expect(Object.isFrozen(spec.extraRoms)).toBe(true);
    });
});
