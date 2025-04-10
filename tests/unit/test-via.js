"use strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Via, SysVia } from "../../src/via.js";
import { SaveState } from "../../src/savestate.js";
import { Scheduler } from "../../src/scheduler.js";

describe("Via", () => {
    let via;
    let scheduler;
    let cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = { interrupt: 0 };
        via = new Via(cpu, scheduler, 0x01);
    });

    describe("Base Functionality", () => {
        it("should initialize with default state", () => {
            expect(via.ora).toBe(0);
            expect(via.orb).toBe(0);
            expect(via.ddra).toBe(0);
            expect(via.ddrb).toBe(0);
            expect(via.ifr).toBe(0);
            expect(via.ier).toBe(0);

            expect(cpu.interrupt).toBe(0);
        });

        it("should be able to update registers", () => {
            via.ora = 0x42;
            via.orb = 0x55;
            via.ddra = 0x33;
            via.ddrb = 0x77;

            expect(via.ora).toBe(0x42);
            expect(via.orb).toBe(0x55);
            expect(via.ddra).toBe(0x33);
            expect(via.ddrb).toBe(0x77);
        });
    });

    describe("Save State", () => {
        it("should properly save and restore state", () => {
            // Setup
            const saveState = new SaveState();

            // Set some specific state values
            via.ora = 0x42;
            via.orb = 0x55;
            via.ddra = 0x33;
            via.ddrb = 0x77;
            via.t1l = 0x5678;
            via.t2l = 0x9abc;
            via.acr = 0x32;
            via.pcr = 0x45;
            // Don't set ifr directly, it's modified by updateIFR()
            via.ier = 0x89;
            via.t1hit = true;
            via.t2hit = false;
            via.portapins = 0xaa;
            via.portbpins = 0xbb;
            via.ca1 = true;
            via.ca2 = false;

            // Save state
            via.saveState(saveState, "testvia");

            // Create a new Via with default values
            const newVia = new Via(cpu, scheduler, 0x01);

            // Load the saved state
            newVia.loadState(saveState, "testvia");

            // Verify state was properly restored
            expect(newVia.ora).toBe(0x42);
            expect(newVia.orb).toBe(0x55);
            expect(newVia.ddra).toBe(0x33);
            expect(newVia.ddrb).toBe(0x77);
            expect(newVia.t1l).toBe(0x5678);
            expect(newVia.t2l).toBe(0x9abc);
            expect(newVia.acr).toBe(0x32);
            expect(newVia.pcr).toBe(0x45);
            // Don't check ifr directly, it's modified by updateIFR()
            expect(newVia.ier).toBe(0x89);
            expect(newVia.t1hit).toBe(true);
            expect(newVia.t2hit).toBe(false);
            expect(newVia.portapins).toBe(0xaa);
            expect(newVia.portbpins).toBe(0xbb);
            expect(newVia.ca1).toBe(true);
            expect(newVia.ca2).toBe(false);
        });
    });
});

describe("SysVia", () => {
    let sysVia;
    let scheduler;
    let cpu;

    beforeEach(() => {
        scheduler = new Scheduler();
        cpu = { interrupt: 0 };

        // Mock dependencies
        const video = { setScreenAdd: vi.fn() };
        const soundChip = { updateSlowDataBus: vi.fn() };
        const cmos = { read: vi.fn().mockReturnValue(0xff) };

        sysVia = new SysVia(cpu, scheduler, video, soundChip, cmos, true, "uk");
    });

    describe("Save State", () => {
        it("should properly save and restore SysVia specific state", () => {
            // Setup
            const saveState = new SaveState();

            // Set some specific state values
            sysVia.IC32 = 0x42;
            sysVia.capsLockLight = true;
            sysVia.shiftLockLight = false;
            sysVia.keyboardEnabled = true;

            // Set a key press
            sysVia.keys[3][2] = 1;

            // Save state
            sysVia.saveState(saveState);

            // Create a new SysVia with default values (mocking dependencies)
            const video = { setScreenAdd: vi.fn() };
            const soundChip = { updateSlowDataBus: vi.fn() };
            const cmos = { read: vi.fn().mockReturnValue(0xff) };

            const newSysVia = new SysVia(cpu, scheduler, video, soundChip, cmos, true, "uk");

            // Load the saved state
            newSysVia.loadState(saveState);

            // Verify state was properly restored
            expect(newSysVia.IC32).toBe(0x42);
            expect(newSysVia.capsLockLight).toBe(true);
            expect(newSysVia.shiftLockLight).toBe(false);
            expect(newSysVia.keyboardEnabled).toBe(true);
            expect(newSysVia.keys[3][2]).toBe(1);
        });
    });
});
