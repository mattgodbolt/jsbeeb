import { describe, expect, it, vi } from "vitest";

import { machineSpec, nullIo } from "../../src/machine-spec.js";
import { findModel, TEST_6502 } from "../../src/models.js";

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
        expect(sendByte).toHaveBeenCalledWith(0x90, expect.any(Number));
        expect(cpu.readDevice(midiAddress) & 0x02).toBe(0);

        cpu.scheduler.polltime(640);
        expect(cpu.peekDevice(midiAddress) & 0x02).toBe(0x02);
        expect(cpu.readDevice(midiAddress) & 0x02).toBe(0x02);
    });

    it("keeps the MIDI IRQ apart from a Master's ACCCON IRR", () => {
        const master = findModel("Master");
        const cpu = new master.Cpu(master, {
            ...nullIo({ model: master }),
            config: machineSpec({ hasMidiInterface: true, midiInterrupt: "irq" }),
        });

        cpu.writeAcccon(0x80);
        cpu.writeDevice(0xfc00, 0x03);
        expect(cpu.interrupt).not.toBe(0);

        cpu.writeAcccon(0x00);
        cpu.writeDevice(0xfc00, 0x20);
        cpu.writeAcccon(0x80);
        cpu.writeAcccon(0x00);
        expect(cpu.interrupt).not.toBe(0);
    });

    it("carries a byte in flight across a snapshot, and resets the MIDI ACIA for one without it", () => {
        const fitted = machineSpec({ hasMidiInterface: true });
        const source = build(fitted);
        source.writeDevice(0xfc01, 0x90);
        source.scheduler.polltime(100);
        const inFlight = source.snapshotState();

        const restored = build(fitted);
        restored.restoreState(inFlight);
        expect(restored.peekDevice(0xfc00) & 0x02).toBe(0);
        restored.scheduler.polltime(540);
        expect(restored.peekDevice(0xfc00) & 0x02).toBe(0x02);

        restored.writeDevice(0xfc01, 0x90);
        restored.restoreState(build().snapshotState());
        expect(restored.peekDevice(0xfc00) & 0x02).toBe(0x02);
    });

    it("drives the CPU NMI line when the MIDI interrupt pin is configured as NMI", () => {
        const cpu = build(machineSpec({ hasMidiInterface: true, midiInterrupt: "nmi" }));

        cpu.writeDevice(0xfc00, 0x20);
        expect(cpu.nmi).toBe(true);

        cpu.writeDevice(0xfc01, 0x90);
        expect(cpu.nmi).toBe(false);
        cpu.scheduler.polltime(640);
        expect(cpu.nmi).toBe(true);
    });
});

describe("machineSpec", () => {
    it("fills in everything a machine needs by default", () => {
        const spec = machineSpec();
        expect(spec.keyLayout).toBe("physical");
        expect(spec.cpuMultiplier).toBe(1);
        expect(spec.tube).toBeNull();
        expect(spec.midiAddress).toBe(0xfc00);
        expect(spec.midiInterrupt).toBe("none");
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
