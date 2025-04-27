"use strict";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Tube } from "../../src/tube.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";

describe("Tube", () => {
    let tube;
    let hostCpu;
    let parasiteCpu;

    beforeEach(() => {
        hostCpu = { interrupt: 0 };
        parasiteCpu = {
            interrupt: false,
            NMI: vi.fn(),
            resetHeldLow: false,
        };
        tube = new Tube(hostCpu, parasiteCpu);
    });

    describe("Save State", () => {
        it("should properly save and restore Tube state", () => {
            // Setup initial state
            tube.internalStatusRegister = 0x42;
            tube.hostStatus[0] = 0xc0; // Both DATA_AVAILABLE and DATA_REGISTER_NOT_FULL flags set
            tube.hostStatus[1] = 0x80; // DATA_AVAILABLE flag set
            tube.parasiteStatus[2] = 0x40; // DATA_REGISTER_NOT_FULL flag set
            tube.parasiteToHostFifoByteCount1 = 5;

            // Add some data to the buffers
            tube.parasiteToHostData[0][0] = 0xaa;
            tube.parasiteToHostData[0][1] = 0xbb;
            tube.parasiteToHostData[1][0] = 0xcc;
            tube.hostToParasiteData[2][0] = 0xdd;
            tube.hostToParasiteData[2][1] = 0xee;

            // Save state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            tube.saveState(saveState);

            // Create a new tube with default state
            const newHostCpu = { interrupt: 0 };
            const newParasiteCpu = {
                interrupt: false,
                NMI: vi.fn(),
                resetHeldLow: false,
            };
            const newTube = new Tube(newHostCpu, newParasiteCpu);

            // Verify the new tube has different state
            expect(newTube.internalStatusRegister).not.toBe(tube.internalStatusRegister);
            expect(newTube.hostStatus[0]).not.toBe(tube.hostStatus[0]);
            expect(newTube.parasiteToHostData[0][0]).not.toBe(tube.parasiteToHostData[0][0]);

            // Load state into the new tube
            newTube.loadState(saveState);

            // Verify the state was properly restored
            expect(newTube.internalStatusRegister).toBe(tube.internalStatusRegister);
            expect(newTube.hostStatus[0]).toBe(tube.hostStatus[0]);
            expect(newTube.hostStatus[1]).toBe(tube.hostStatus[1]);
            expect(newTube.parasiteStatus[2]).toBe(tube.parasiteStatus[2]);
            expect(newTube.parasiteToHostFifoByteCount1).toBe(tube.parasiteToHostFifoByteCount1);

            // Verify data buffers were correctly restored
            expect(newTube.parasiteToHostData[0][0]).toBe(tube.parasiteToHostData[0][0]);
            expect(newTube.parasiteToHostData[0][1]).toBe(tube.parasiteToHostData[0][1]);
            expect(newTube.parasiteToHostData[1][0]).toBe(tube.parasiteToHostData[1][0]);
            expect(newTube.hostToParasiteData[2][0]).toBe(tube.hostToParasiteData[2][0]);
            expect(newTube.hostToParasiteData[2][1]).toBe(tube.hostToParasiteData[2][1]);
        });

        it("should handle loading when state component is missing", () => {
            // Create a SaveState without any tube state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Set up a tube with some non-default state
            tube.internalStatusRegister = 0x42;
            tube.hostStatus[0] = 0xc0;

            // Load the empty state
            tube.loadState(saveState);

            // Verify the tube still has its original state
            expect(tube.internalStatusRegister).toBe(0x42);
            expect(tube.hostStatus[0]).toBe(0xc0);
        });

        it("should update interrupt state after loading", () => {
            // Setup initial state that would trigger an interrupt
            tube.internalStatusRegister = TUBE_ULA_FLAG_STATUS_ENABLE_HOST_IRQ_FROM_R4_DATA;
            tube.hostStatus[3] = TUBE_ULA_FLAG_DATA_AVAILABLE; // R4 data available

            // Update interrupts to reflect the state we just set
            tube.updateInterrupts();

            // Verify the interrupt flag is set
            expect(hostCpu.interrupt & 8).toBeTruthy();

            // Save state
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            tube.saveState(saveState);

            // Create a new tube with default state
            const newHostCpu = { interrupt: 0 };
            const newParasiteCpu = {
                interrupt: false,
                NMI: vi.fn(),
                resetHeldLow: false,
            };
            const newTube = new Tube(newHostCpu, newParasiteCpu);

            // Load state
            newTube.loadState(saveState);

            // Verify the interrupt flag is set on the new CPU
            expect(newHostCpu.interrupt & 8).toBeTruthy();
        });
    });
});

// Define constants from tube.js to use in the tests
const TUBE_ULA_FLAG_DATA_AVAILABLE = 0x80;
const TUBE_ULA_FLAG_STATUS_ENABLE_HOST_IRQ_FROM_R4_DATA = 0x01;
