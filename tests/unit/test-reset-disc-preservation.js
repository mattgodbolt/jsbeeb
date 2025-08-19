import { beforeEach, describe, expect, it } from "vitest";
import { Cpu6502 } from "../../src/6502.js";
import { TEST_6502 } from "../../src/models.js";
import * as disc from "../../src/fdc.js";
import { FakeVideo } from "../../src/video.js";

describe("Reset disc preservation tests", () => {
    let processor;
    let mockDisc;

    beforeEach(() => {
        // Setup DOM globals for tests
        global.window = { localStorage: {} };
        global.document = { getElementById: () => null };

        // Create processor with minimal setup
        const dbgr = { setCpu: () => {}, stop: () => {} };
        const video = new FakeVideo();
        const soundChip = {
            toneGenerator: {
                setChannel: () => {},
                getChannelValues: () => [0, 0, 0, 0],
            },
            reset: () => {},
            setScheduler: () => {},
        };
        const ddNoise = {
            spinDown: () => {},
        };
        const config = { extraRoms: [], debugFlags: {} };

        processor = new Cpu6502(TEST_6502, dbgr, video, soundChip, ddNoise, null, null, config, null);

        // Create a mock disc
        const mockDiscData = new Uint8Array(1024);
        mockDiscData.fill(0x42);
        mockDisc = disc.discFor(processor.fdc, "test.ssd", mockDiscData);
    });

    it("should preserve disc after soft reset", () => {
        // Load disc
        processor.fdc.loadDisc(0, mockDisc);
        expect(processor.fdc.drives[0].disc).toBeDefined();

        // Store reference to original disc
        const originalDisc = processor.fdc.drives[0].disc;

        // Perform soft reset
        processor.reset(false);

        // Check if disc is still loaded
        expect(processor.fdc.drives[0].disc).toBeDefined();
        // Should be the same disc object (reference preserved)
        expect(processor.fdc.drives[0].disc).toBe(originalDisc);
    });

    it("should preserve disc after hard reset", () => {
        // Load disc
        processor.fdc.loadDisc(0, mockDisc);
        expect(processor.fdc.drives[0].disc).toBeDefined();

        // Store reference to original disc
        const originalDisc = processor.fdc.drives[0].disc;

        // Perform hard reset
        processor.reset(true);

        // Check if disc is still loaded
        expect(processor.fdc.drives[0].disc).toBeDefined();
        // Should be the same disc object (reference preserved)
        expect(processor.fdc.drives[0].disc).toBe(originalDisc);
    });

    it("should preserve discs on both drives after reset", () => {
        // Create second disc
        const mockDiscData2 = new Uint8Array(1024);
        mockDiscData2.fill(0x84);
        const mockDisc2 = disc.discFor(processor.fdc, "test2.ssd", mockDiscData2);

        // Load discs on both drives
        processor.fdc.loadDisc(0, mockDisc);
        processor.fdc.loadDisc(1, mockDisc2);
        expect(processor.fdc.drives[0].disc).toBeDefined();
        expect(processor.fdc.drives[1].disc).toBeDefined();

        // Store references to original discs
        const originalDisc0 = processor.fdc.drives[0].disc;
        const originalDisc1 = processor.fdc.drives[1].disc;

        // Perform hard reset
        processor.reset(true);

        // Check if both discs are still loaded
        expect(processor.fdc.drives[0].disc).toBeDefined();
        expect(processor.fdc.drives[1].disc).toBeDefined();
        // Should be the same disc objects (references preserved)
        expect(processor.fdc.drives[0].disc).toBe(originalDisc0);
        expect(processor.fdc.drives[1].disc).toBe(originalDisc1);
    });

    it("should handle reset when no discs are loaded", () => {
        // Ensure no discs are loaded
        expect(processor.fdc.drives[0].disc).toBeUndefined();
        expect(processor.fdc.drives[1].disc).toBeUndefined();

        // Perform reset - should not crash
        processor.reset(true);

        // Should still have no discs loaded
        expect(processor.fdc.drives[0].disc).toBeUndefined();
        expect(processor.fdc.drives[1].disc).toBeUndefined();
    });

    it("should preserve mixed loaded/unloaded state", () => {
        // Load disc only on drive 0
        processor.fdc.loadDisc(0, mockDisc);
        expect(processor.fdc.drives[0].disc).toBeDefined();
        expect(processor.fdc.drives[1].disc).toBeUndefined();

        const originalDisc = processor.fdc.drives[0].disc;

        // Perform reset
        processor.reset(true);

        // Drive 0 should still have disc, drive 1 should still be empty
        expect(processor.fdc.drives[0].disc).toBeDefined();
        expect(processor.fdc.drives[1].disc).toBeUndefined();
        expect(processor.fdc.drives[0].disc).toBe(originalDisc);
    });
});
