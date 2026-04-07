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

describe("Atom speaker support", () => {
    it("should have speakerGenerator with mute and pushBit", () => {
        const { chip } = makeSoundChip();
        expect(chip.speakerGenerator).toBeDefined();
        expect(typeof chip.speakerGenerator.mute).toBe("function");
        expect(typeof chip.speakerGenerator.pushBit).toBe("function");
    });

    it("should default isAtom to false", () => {
        const { chip } = makeSoundChip();
        expect(chip.isAtom).toBe(false);
    });

    it("setCPUSpeed should adjust samplesPerCycle", () => {
        const { chip } = makeSoundChip();
        const before = chip.samplesPerCycle;
        chip.setCPUSpeed(1000000); // 1 MHz (Atom)
        expect(chip.samplesPerCycle).not.toBe(before);
        expect(chip.samplesPerCycle).toBeCloseTo(chip.soundchipFreq / 1000000);
    });

    it("speakerReset should clear the bit change queue", () => {
        const { chip } = makeSoundChip();
        chip.bitChange.push({ bit: 1.0, cycles: 100 });
        chip.speakerReset();
        expect(chip.bitChange).toHaveLength(0);
        expect(chip.currentSpeakerBit).toBe(0.0);
    });

    it("updateSpeaker should record bit transitions", () => {
        const { chip } = makeSoundChip();
        chip.updateSpeaker(1, 100, 0);
        chip.updateSpeaker(0, 200, 0);
        expect(chip.bitChange).toHaveLength(2);
        expect(chip.bitChange[0].bit).toBe(1.0);
        expect(chip.bitChange[1].bit).toBe(0.0);
    });

    it("BBC channels should be skipped when isAtom is true", () => {
        const { chip } = makeSoundChip();
        chip.isAtom = true;
        // Set BBC tone channel to produce sound
        chip.registers[0] = 100;
        chip.volume[0] = 0.25;
        const out = new Float32Array(32);
        chip.generate(out, 0, 32);
        // BBC tone channel should be silent (skipped)
        const allZeroOrSpeaker = out.every((v) => Math.abs(v) < 0.01);
        expect(allZeroOrSpeaker).toBe(true);
    });

    it("speaker channel should be skipped when isAtom is false", () => {
        // Generate baseline output without any speaker transition queued
        const { chip: baseline } = makeSoundChip();
        baseline.isAtom = false;
        const baselineOut = new Float32Array(32);
        baseline.generate(baselineOut, 0, 32);

        // Generate with a speaker transition queued — should be identical
        const { chip } = makeSoundChip();
        chip.isAtom = false;
        chip.bitChange.push({ bit: 1.0, cycles: 0 });
        const out = new Float32Array(32);
        chip.generate(out, 0, 32);

        expect(Array.from(out)).toEqual(Array.from(baselineOut));
    });

    it("speakerChannel should produce output from bit transitions and consume them", () => {
        const { chip, scheduler } = makeSoundChip();
        chip.speakerReset();
        // Push transitions at known cycle timestamps
        chip.bitChange.push({ bit: 1.0, cycles: 5 });
        chip.bitChange.push({ bit: 0.0, cycles: 10 });
        // Set epoch so the transitions fall within the render window
        scheduler.epoch = 16;

        const out = new Float32Array(16);
        chip.speakerChannel(5, out, 0, 16);

        // Before cycle 5: silence (no transitions yet)
        expect(out[0]).toBeCloseTo(0.0, 2);
        expect(out[4]).toBeCloseTo(0.0, 2);
        // At cycle 5: bit goes high, output jumps positive (DC-blocked)
        expect(out[5]).toBeGreaterThan(0);
        // At cycle 10: bit goes low, output changes sign
        expect(out[10]).toBeLessThan(out[9]);
        // After all transitions consumed, output decays toward 0
        expect(Math.abs(out[15])).toBeLessThan(Math.abs(out[10]));
        // Transitions should be consumed
        expect(chip.bitChange).toHaveLength(0);
    });
});
