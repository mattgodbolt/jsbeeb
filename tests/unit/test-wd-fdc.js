"use strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WdFdc } from "../../src/wd-fdc.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";
import { Scheduler } from "../../src/scheduler.js";

describe("WdFdc", () => {
    let fdc;
    let scheduler;
    let cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        // Create a mock CPU that simulates a non-Master BBC Micro
        cpu = {
            interrupt: 0,
            halted: false,
            halt: vi.fn(),
            polltime: vi.fn(),
            NMI: vi.fn(),
            model: {
                isMaster: false, // Set to false for simpler address mapping
            },
        };
        fdc = new WdFdc(cpu, scheduler);
    });

    describe("Basic Functionality", () => {
        it("should initialize with default state", () => {
            // Check initial state of registers after power on
            expect(fdc._statusRegister).toBe(0);
            expect(fdc._trackRegister).toBe(0);
            expect(fdc._sectorRegister).toBe(1); // Should be 1 after reset
            expect(fdc._dataRegister).toBe(0);

            // Check IRQ state
            expect(fdc._isIntRq).toBe(false);
            expect(fdc._isDrq).toBe(false);

            // Check drives
            expect(fdc._drives.length).toBe(2);
            expect(fdc._drives[0]).toBeDefined();
            expect(fdc._drives[1]).toBeDefined();
        });

        it("should handle register reads", () => {
            // With a non-Master BBC Micro, the registers are at their natural addresses

            // Status register (address 4)
            let value = fdc.read(4);
            expect(value).toBe(0); // Should be 0 after reset

            // Track register (address 5)
            value = fdc.read(5);
            expect(value).toBe(0); // Should be 0 initially

            // Sector register (address 6)
            value = fdc.read(6);
            expect(value).toBe(1); // Should be 1 after reset

            // Data register (address 7)
            value = fdc.read(7);
            expect(value).toBe(0); // Should be 0 initially

            // Default fallback value for unmapped addresses
            value = fdc.read(0); // Control register (not readable)
            expect(value).toBe(0xfe); // Should return 0xFE (254)
        });
    });

    describe("Save State", () => {
        it("should properly save and restore state", () => {
            // Setup
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Set specific state values
            fdc._controlRegister = 0x42;
            fdc._statusRegister = 0x55;
            fdc._trackRegister = 33;
            fdc._sectorRegister = 10;
            fdc._dataRegister = 0x77;

            fdc._isIntRq = true;
            fdc._isDrq = true;
            fdc._doRaiseIntRq = true;

            fdc._isIndexPulse = true;
            fdc._isInterruptOnIndexPulse = true;

            fdc._command = 0x80; // READ_SECTOR
            fdc._commandType = 2;
            fdc._isCommandMulti = true;

            // Drive 0 is active
            fdc._currentDrive = fdc._drives[0];

            // Save state
            fdc.saveState(saveState);

            // Create a new WdFdc with default values
            const newFdc = new WdFdc(cpu, scheduler);

            // Load the saved state
            newFdc.loadState(saveState);

            // Verify state was properly restored
            expect(newFdc._controlRegister).toBe(0x42);
            expect(newFdc._statusRegister).toBe(0x55);
            expect(newFdc._trackRegister).toBe(33);
            expect(newFdc._sectorRegister).toBe(10);
            expect(newFdc._dataRegister).toBe(0x77);

            expect(newFdc._isIntRq).toBe(true);
            expect(newFdc._isDrq).toBe(true);
            expect(newFdc._doRaiseIntRq).toBe(true);

            expect(newFdc._isIndexPulse).toBe(true);
            expect(newFdc._isInterruptOnIndexPulse).toBe(true);

            expect(newFdc._command).toBe(0x80);
            expect(newFdc._commandType).toBe(2);
            expect(newFdc._isCommandMulti).toBe(true);

            // Current drive should be correctly restored
            expect(newFdc._currentDrive).toBe(newFdc._drives[0]);
        });
    });
});
