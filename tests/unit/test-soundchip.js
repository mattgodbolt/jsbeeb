import { describe, it, expect } from "vitest";
import { SoundChip } from "../../src/soundchip.js";
import { Scheduler } from "../../src/scheduler.js";

function makeSoundChip() {
    const scheduler = new Scheduler();
    const chip = new SoundChip(() => {});
    chip.setScheduler(scheduler);
    return { chip, scheduler };
}

describe("SoundChip snapshotState / restoreState", () => {
    it("should snapshot and restore tone channel registers", () => {
        const { chip } = makeSoundChip();
        chip.registers[0] = 0x100;
        chip.registers[1] = 0x200;
        chip.registers[2] = 0x300;
        chip.counter[0] = 1.5;
        chip.counter[1] = 2.5;
        chip.outputBit[0] = true;
        chip.outputBit[2] = true;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.registers[0]).toBe(0x100);
        expect(chip2.registers[1]).toBe(0x200);
        expect(chip2.registers[2]).toBe(0x300);
        expect(chip2.counter[0]).toBeCloseTo(1.5);
        expect(chip2.counter[1]).toBeCloseTo(2.5);
        expect(chip2.outputBit[0]).toBe(true);
        expect(chip2.outputBit[1]).toBe(false);
        expect(chip2.outputBit[2]).toBe(true);
    });

    it("should snapshot and restore volume levels", () => {
        const { chip } = makeSoundChip();
        chip.poke(0x90 | 0x05); // Channel 0, volume 5
        chip.poke(0xb0 | 0x0a); // Channel 1, volume 10

        const v0 = chip.volume[0];
        const v1 = chip.volume[1];

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.volume[0]).toBeCloseTo(v0);
        expect(chip2.volume[1]).toBeCloseTo(v1);
    });

    it("should snapshot and restore LFSR and noise state", () => {
        const { chip } = makeSoundChip();
        // Set to periodic noise
        chip.registers[3] = 0x02;
        chip.noisePoked();
        // Shift LFSR a few times to get a non-default value
        chip.shiftLfsr();
        chip.shiftLfsr();
        chip.shiftLfsr();
        const lfsrVal = chip.lfsr;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.lfsr).toBe(lfsrVal);
        expect(chip2.registers[3]).toBe(0x02);
        // Verify periodic noise LFSR function is bound (not white noise)
        chip2.shiftLfsr();
        chip.shiftLfsr();
        expect(chip2.lfsr).toBe(chip.lfsr);
    });

    it("should snapshot and restore white noise LFSR binding", () => {
        const { chip } = makeSoundChip();
        // Set to white noise (bit 2 set)
        chip.registers[3] = 0x07;
        chip.noisePoked();
        chip.shiftLfsr();
        chip.shiftLfsr();
        const lfsrVal = chip.lfsr;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.lfsr).toBe(lfsrVal);
        // Verify white noise LFSR function is bound
        chip2.shiftLfsr();
        chip.shiftLfsr();
        expect(chip2.lfsr).toBe(chip.lfsr);
    });

    it("should snapshot and restore latched register", () => {
        const { chip } = makeSoundChip();
        chip.latchedRegister = 0x60;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.latchedRegister).toBe(0x60);
    });

    it("should snapshot and restore sine generator state", () => {
        const { chip } = makeSoundChip();
        chip.sineOn = true;
        chip.sineStep = 42.5;
        chip.sineTime = 100.25;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.restoreState(snapshot);

        expect(chip2.sineOn).toBe(true);
        expect(chip2.sineStep).toBeCloseTo(42.5);
        expect(chip2.sineTime).toBeCloseTo(100.25);
    });

    it("should reset output buffer on restore", () => {
        const { chip } = makeSoundChip();
        chip.position = 100;
        chip.buffer[0] = 0.5;

        const snapshot = chip.snapshotState();
        const { chip: chip2 } = makeSoundChip();
        chip2.position = 50;
        chip2.restoreState(snapshot);

        expect(chip2.position).toBe(0);
    });

    it("should produce isolated snapshots", () => {
        const { chip } = makeSoundChip();
        chip.registers[0] = 0x123;

        const snapshot = chip.snapshotState();
        chip.registers[0] = 0x456;

        // Snapshot should not be affected by subsequent changes
        expect(snapshot.registers[0]).toBe(0x123);
    });
});
