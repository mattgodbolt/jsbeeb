"use strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SoundChip } from "../../src/soundchip.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";

describe("SoundChip", () => {
    let soundChip;
    let onBufferCallback;

    beforeEach(() => {
        onBufferCallback = vi.fn();
        soundChip = new SoundChip(onBufferCallback);
    });

    describe("Base Functionality", () => {
        it("should initialize with default state", () => {
            // Check initial state
            expect(soundChip.registers.length).toBe(4);
            expect(soundChip.counter.length).toBe(4);
            expect(soundChip.volume.length).toBe(4);
            expect(soundChip.enabled).toBe(true);

            // All channels should start with tone off
            expect(soundChip.outputBit[0]).toBe(false);
            expect(soundChip.outputBit[1]).toBe(false);
            expect(soundChip.outputBit[2]).toBe(false);
            expect(soundChip.outputBit[3]).toBe(false);

            // Sine channel should start off
            expect(soundChip.sineOn).toBe(false);
        });

        it("should handle control operations", () => {
            // Test mute
            soundChip.mute();
            expect(soundChip.enabled).toBe(false);

            // Test unmute
            soundChip.unmute();
            expect(soundChip.enabled).toBe(true);
        });
    });

    describe("Save State", () => {
        it("should properly save and restore state", () => {
            // Setup
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Set some specific state values
            soundChip.registers[0] = 0x42;
            soundChip.registers[1] = 0x55;
            soundChip.registers[2] = 0x33;
            soundChip.registers[3] = 0x77;

            soundChip.counter[0] = 123.45;
            soundChip.counter[1] = 456.78;

            soundChip.volume[0] = 0.1;
            soundChip.volume[1] = 0.5;
            soundChip.volume[2] = 0.8;
            soundChip.volume[3] = 0.2;

            soundChip.outputBit[0] = true;
            soundChip.outputBit[1] = false;
            soundChip.outputBit[2] = true;
            soundChip.outputBit[3] = false;

            soundChip.sineOn = true;
            soundChip.sineStep = 123.456;
            soundChip.sineTime = 789.012;

            soundChip.lfsr = 0xabcd;
            soundChip.latchedRegister = 3;
            soundChip.active = true;

            // Save state
            soundChip.saveState(saveState);

            // Create a new SoundChip with default values
            const newSoundChip = new SoundChip(onBufferCallback);

            // Load the saved state
            newSoundChip.loadState(saveState);

            // Verify state was properly restored
            expect(newSoundChip.registers[0]).toBe(0x42);
            expect(newSoundChip.registers[1]).toBe(0x55);
            expect(newSoundChip.registers[2]).toBe(0x33);
            expect(newSoundChip.registers[3]).toBe(0x77);

            expect(newSoundChip.counter[0]).toBeCloseTo(123.45, 5);
            expect(newSoundChip.counter[1]).toBeCloseTo(456.78, 5);

            expect(newSoundChip.volume[0]).toBeCloseTo(0.1, 5);
            expect(newSoundChip.volume[1]).toBeCloseTo(0.5, 5);
            expect(newSoundChip.volume[2]).toBeCloseTo(0.8, 5);
            expect(newSoundChip.volume[3]).toBeCloseTo(0.2, 5);

            expect(newSoundChip.outputBit[0]).toBe(true);
            expect(newSoundChip.outputBit[1]).toBe(false);
            expect(newSoundChip.outputBit[2]).toBe(true);
            expect(newSoundChip.outputBit[3]).toBe(false);

            expect(newSoundChip.sineOn).toBe(true);
            expect(newSoundChip.sineStep).toBe(123.456);
            expect(newSoundChip.sineTime).toBe(789.012);

            expect(newSoundChip.lfsr).toBe(0xabcd);
            expect(newSoundChip.latchedRegister).toBe(3);
            expect(newSoundChip.active).toBe(true);
        });
    });
});
