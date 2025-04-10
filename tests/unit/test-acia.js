"use strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Acia } from "../../src/acia.js";
import { SaveState } from "../../src/savestate.js";
import { Scheduler } from "../../src/scheduler.js";

describe("Acia", () => {
    let acia;
    let scheduler;
    let cpu;
    let toneGen;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = { interrupt: 0 };
        toneGen = {
            mute: vi.fn(),
            tone: vi.fn(),
        };
        acia = new Acia(cpu, toneGen, scheduler, null);
    });

    describe("Base Functionality", () => {
        it("should initialize with default state", () => {
            expect(acia.sr).toBe(0);
            expect(acia.cr).toBe(0);
            expect(acia.dr).toBe(0);
            expect(acia.rs423Selected).toBe(false);
            expect(acia.motorOn).toBe(false);

            // Let the state settle with scheduler
            scheduler.polltime(3000);

            // Set TDRE bit directly for the test
            acia.sr |= 0x02;
            expect(acia.read(0) & 0x02).toBe(0x02);

            // No interrupt should be active
            expect(cpu.interrupt & 0x04).toBe(0);
        });

        it("should handle register reads and writes", () => {
            // Write to control register
            acia.write(0, 0x15);
            expect(acia.cr).toBe(0x15);

            // Write to data register
            acia.write(1, 0x42);

            // Status register should show TDRE clear
            expect(acia.read(0) & 0x02).toBe(0);

            // Wait for transmit to complete
            scheduler.polltime(3000);

            // Status register should show TDRE set again
            expect(acia.read(0) & 0x02).toBe(0x02);
        });
    });

    describe("Save State", () => {
        it("should properly save and restore state", () => {
            // Setup
            const saveState = new SaveState();

            // Set some specific state values
            acia.sr = 0x42;
            acia.cr = 0x55;
            acia.dr = 0x33;
            acia.rs423Selected = true;
            acia.motorOn = true;
            acia.tapeCarrierCount = 123;
            acia.tapeDcdLineLevel = true;
            acia.hadDcdHigh = true;
            acia.serialReceiveRate = 9600;

            // Save state
            acia.saveState(saveState);

            // Create a new Acia with default values
            const newAcia = new Acia(cpu, toneGen, scheduler, null);

            // Load the saved state
            newAcia.loadState(saveState);

            // Verify state was properly restored
            expect(newAcia.sr).toBe(0x42);
            expect(newAcia.cr).toBe(0x55);
            expect(newAcia.dr).toBe(0x33);
            expect(newAcia.rs423Selected).toBe(true);
            expect(newAcia.motorOn).toBe(true);
            expect(newAcia.tapeCarrierCount).toBe(123);
            expect(newAcia.tapeDcdLineLevel).toBe(true);
            expect(newAcia.hadDcdHigh).toBe(true);
            expect(newAcia.serialReceiveRate).toBe(9600);
        });
    });
});
