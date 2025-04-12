import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Adc } from "../../src/adc.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";

describe("ADC", () => {
    // Mock dependencies
    const mockSysvia = {
        setcb1: vi.fn(),
        getGamepads: vi.fn().mockReturnValue([]),
    };

    const mockScheduler = {
        currentTime: 1000,
        newTask: vi.fn().mockImplementation((callback) => ({
            schedule: vi.fn(),
            cancel: vi.fn(),
            callback,
            scheduler: { currentTime: 1000 },
            when: 0,
        })),
    };

    let adc;
    let mockTask;

    beforeEach(() => {
        // Reset mocks
        vi.resetAllMocks();

        // Create a mock task that stores the callback
        mockTask = {
            schedule: vi.fn(),
            cancel: vi.fn(),
        };
        mockScheduler.newTask.mockReturnValue(mockTask);

        // Create a fresh ADC instance
        adc = new Adc(mockSysvia, mockScheduler);
    });

    afterEach(() => {
        vi.resetAllMocks();
    });

    describe("Initialization", () => {
        it("should initialize with default state", () => {
            expect(adc.status).toBe(0x40);
            expect(adc.low).toBe(0x00);
            expect(adc.high).toBe(0x00);
            expect(mockScheduler.newTask).toHaveBeenCalled();
        });

        it("should reset to default state", () => {
            // Change state
            adc.status = 0xff;
            adc.low = 0xff;
            adc.high = 0xff;

            // Reset
            adc.reset();

            // Check state is back to default
            expect(adc.status).toBe(0x40);
            expect(adc.low).toBe(0x00);
            expect(adc.high).toBe(0x00);
        });
    });

    describe("Reading registers", () => {
        it("should read status register (addr 0)", () => {
            adc.status = 0x42;
            expect(adc.read(0)).toBe(0x42);
        });

        it("should read high byte register (addr 1)", () => {
            adc.high = 0x42;
            expect(adc.read(1)).toBe(0x42);
        });

        it("should read low byte register (addr 2)", () => {
            adc.low = 0x42;
            expect(adc.read(2)).toBe(0x42);
        });

        it("should return 0x40 for undefined register (addr 3)", () => {
            expect(adc.read(3)).toBe(0x40);
        });

        it("should correctly mask address when reading", () => {
            adc.status = 0x42;
            adc.high = 0x43;
            adc.low = 0x44;

            expect(adc.read(4)).toBe(0x42); // 4 & 3 = 0
            expect(adc.read(5)).toBe(0x43); // 5 & 3 = 1
            expect(adc.read(6)).toBe(0x44); // 6 & 3 = 2
            expect(adc.read(7)).toBe(0x40); // 7 & 3 = 3
        });
    });

    describe("Writing to control register", () => {
        it("should ignore writes to non-control registers", () => {
            // Write to addresses 1, 2, 3
            adc.write(1, 0x42);
            adc.write(2, 0x42);
            adc.write(3, 0x42);

            // Verify no conversion was started
            expect(mockTask.cancel).not.toHaveBeenCalled();
            expect(mockTask.schedule).not.toHaveBeenCalled();
            expect(mockSysvia.setcb1).not.toHaveBeenCalled();
        });

        it("should start 8-bit conversion on write to control register", () => {
            adc.write(0, 0x00); // 8-bit conversion (bit 3 not set)

            expect(mockTask.cancel).toHaveBeenCalled();
            expect(mockTask.schedule).toHaveBeenCalledWith(8000); // 8ms for 8-bit
            expect(adc.status).toBe(0x80); // Busy bit set
            expect(mockSysvia.setcb1).toHaveBeenCalledWith(true);
        });

        it("should start 10-bit conversion on write to control register", () => {
            adc.write(0, 0x08); // 10-bit conversion (bit 3 set)

            expect(mockTask.cancel).toHaveBeenCalled();
            expect(mockTask.schedule).toHaveBeenCalledWith(20000); // 20ms for 10-bit
            expect(adc.status).toBe(0x88); // Busy bit set, bit 3 set
            expect(mockSysvia.setcb1).toHaveBeenCalledWith(true);
        });

        it("should store channel number in status register", () => {
            adc.write(0, 0x02); // Channel 2
            expect(adc.status & 0x0f).toBe(0x02);

            adc.write(0, 0x03); // Channel 3
            expect(adc.status & 0x0f).toBe(0x03);
        });

        it("should correctly mask address when writing", () => {
            adc.write(4, 0x01); // 4 & 3 = 0
            expect(adc.status & 0x0f).toBe(0x01);

            // These should be ignored
            adc.write(5, 0x02); // 5 & 3 = 1
            adc.write(6, 0x03); // 6 & 3 = 2
            adc.write(7, 0x04); // 7 & 3 = 3

            // Status should still reflect the last valid write
            expect(adc.status & 0x0f).toBe(0x01);
        });
    });

    describe("Conversion completion", () => {
        it("should handle completion with no gamepads", () => {
            // Set up a conversion
            adc.write(0, 0x01);

            // Reset mock to clearly see what happens during completion
            mockSysvia.setcb1.mockReset();

            // Simulate conversion completion
            adc.onComplete();

            // Check results
            expect(adc.status & 0x80).toBe(0); // Busy bit cleared
            expect(adc.status & 0x40).toBe(0x40); // End of conversion bit set
            expect(adc.low).toBe(0); // Default value low byte
            expect(adc.high).toBe(0x80); // Default value high byte (0x8000 >> 8)
            expect(mockSysvia.setcb1).toHaveBeenCalledWith(false); // Interrupt cleared
        });

        it("should read from gamepad on channel 0", () => {
            // Mock gamepad with stick positioned halfway to the right
            mockSysvia.getGamepads.mockReturnValue([
                {
                    axes: [0.5, 0, 0, 0], // X-axis at 0.5 (halfway right)
                },
            ]);

            // Set channel 0
            adc.write(0, 0x00);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position 0.5, the value should be (1 - 0.5) / 2 * 0xffff = 0x3fff
            // Low byte should be 0xff, high byte should be 0x3f
            const expectedValue = Math.floor(((1 - 0.5) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);
        });

        it("should read from gamepad on channel 1", () => {
            // Mock gamepad with stick positioned all the way up
            mockSysvia.getGamepads.mockReturnValue([
                {
                    axes: [0, -1, 0, 0], // Y-axis at -1 (all the way up)
                },
            ]);

            // Set channel 1
            adc.write(0, 0x01);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position -1, the value should be (1 - (-1)) / 2 * 0xffff = 0xffff
            // Low byte should be 0xff, high byte should be 0xff
            const expectedValue = Math.floor(((1 - -1) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);
        });

        it("should read from second gamepad if available", () => {
            // Mock two gamepads
            mockSysvia.getGamepads.mockReturnValue([{ axes: [0, 0, 0, 0] }, { axes: [0.25, -0.75, 0, 0] }]);

            // Set channel 2 (first axis of second gamepad)
            adc.write(0, 0x02);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position 0.25, the value should be (1 - 0.25) / 2 * 0xffff = 0x5fff
            const expectedValue = Math.floor(((1 - 0.25) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);

            // Set channel 3 (second axis of second gamepad)
            adc.write(0, 0x03);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position -0.75, the value should be (1 - (-0.75)) / 2 * 0xffff = 0xdfff
            const expectedValue2 = Math.floor(((1 - -0.75) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue2 & 0xff);
            expect(adc.high).toBe((expectedValue2 >>> 8) & 0xff);
        });

        it("should fall back to first gamepad extra axes if second gamepad not available", () => {
            // Mock one gamepad with 4 axes
            mockSysvia.getGamepads.mockReturnValue([
                { axes: [0, 0, 0.75, -0.5] }, // Third axis at 0.75, fourth at -0.5
            ]);

            // Set channel 2 (should fall back to third axis of first gamepad)
            adc.write(0, 0x02);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position 0.75, the value should be (1 - 0.75) / 2 * 0xffff = 0x1fff
            const expectedValue = Math.floor(((1 - 0.75) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);

            // Set channel 3 (should fall back to fourth axis of first gamepad)
            adc.write(0, 0x03);

            // Simulate conversion completion
            adc.onComplete();

            // For axis position -0.5, the value should be (1 - (-0.5)) / 2 * 0xffff = 0xbfff
            const expectedValue2 = Math.floor(((1 - -0.5) / 2) * 0xffff);

            expect(adc.low).toBe(expectedValue2 & 0xff);
            expect(adc.high).toBe((expectedValue2 >>> 8) & 0xff);
        });

        it("should have full coverage of switch cases", () => {
            // Setup gamepad with specific values for testing
            const mockPad = {
                axes: [0.1, 0.2, 0.3, 0.4],
            };
            mockSysvia.getGamepads.mockReturnValue([mockPad]);

            // Test channel 0
            adc.write(0, 0x00);
            adc.onComplete();

            // Test channel 1
            adc.write(0, 0x01);
            adc.onComplete();

            // Test channel 2 (without second gamepad, uses first gamepad's third axis)
            adc.write(0, 0x02);
            adc.onComplete();

            // Test channel 3 (without second gamepad, uses first gamepad's fourth axis)
            adc.write(0, 0x03);
            adc.onComplete();

            // The default case in the switch statement should never be reached through
            // the public interface since channel is always masked to 0-3
            // For the sake of coverage, we've already tested all valid cases
        });

        it("should update status bits correctly after conversion", () => {
            // Set a value that will result in specific high bits in the result
            mockSysvia.getGamepads.mockReturnValue([
                {
                    axes: [0.25, 0, 0, 0], // Will result in value 0x5fff
                },
            ]);

            // Set channel 0
            adc.write(0, 0x00);

            // Simulate conversion completion
            adc.onComplete();

            // Let's examine exactly how the status register is updated in onComplete
            // In the code: status = (status & 0x0f) | 0x40 | ((val >>> 10) & 0x03);

            // For axis position 0.25, the value should be (1 - 0.25) / 2 * 0xffff = 0x5fff
            const expectedValue = Math.floor(((1 - 0.25) / 2) * 0xffff);

            // The status should have:
            // - bits 0-3: channel number (0)
            // - bit 6: end of conversion bit (1)
            // - bits 4-5: ((0x5fff >>> 10) & 0x03) = 0x01 (shifted to bit position)
            const expectedStatus = (0x00 & 0x0f) | 0x40 | ((expectedValue >>> 10) & 0x03);

            expect(adc.status).toBe(expectedStatus);
        });
    });

    describe("SaveState", () => {
        beforeEach(() => {
            // Set up mock task with scheduler and when properties
            mockTask = {
                schedule: vi.fn(),
                cancel: vi.fn(),
                scheduler: { currentTime: 1000 },
                when: 1500, // 500ms in the future from currentTime
            };
            mockScheduler.newTask.mockReturnValue(mockTask);

            // Create a fresh ADC instance
            adc = new Adc(mockSysvia, mockScheduler);

            // Set state for testing
            adc.status = 0x42;
            adc.low = 0x55;
            adc.high = 0xaa;
        });

        it("should save state correctly", () => {
            // Create a SaveState with a mock model
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Call saveState
            adc.saveState(saveState);

            // Verify state was saved correctly
            const state = saveState.getComponent("adc");
            expect(state).toBeDefined();
            expect(state.status).toBe(0x42);
            expect(state.low).toBe(0x55);
            expect(state.high).toBe(0xaa);
            expect(state.scheduledTime).toBe(500); // 1500 - 1000 = 500ms
        });

        it("should load state correctly", () => {
            // Create a SaveState with test data
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            saveState.addComponent("adc", {
                status: 0x33,
                low: 0x66,
                high: 0x99,
                scheduledTime: 800,
            });

            // Call loadState
            adc.loadState(saveState);

            // Verify state was loaded correctly
            expect(adc.status).toBe(0x33);
            expect(adc.low).toBe(0x66);
            expect(adc.high).toBe(0x99);

            // Verify task was cancelled and rescheduled
            expect(mockTask.cancel).toHaveBeenCalled();
            expect(mockTask.schedule).toHaveBeenCalledWith(800);
        });

        it("should skip rescheduling if scheduledTime is <= 0", () => {
            // Create a SaveState with test data and no scheduled task
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);
            saveState.addComponent("adc", {
                status: 0x33,
                low: 0x66,
                high: 0x99,
                scheduledTime: 0,
            });

            // Call loadState
            adc.loadState(saveState);

            // Verify task was cancelled but not rescheduled
            expect(mockTask.cancel).toHaveBeenCalled();
            expect(mockTask.schedule).not.toHaveBeenCalled();
        });

        it("should do nothing if component is not in SaveState", () => {
            // Create a SaveState with no ADC component
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Call loadState
            adc.loadState(saveState);

            // Verify state was not changed
            expect(adc.status).toBe(0x42);
            expect(adc.low).toBe(0x55);
            expect(adc.high).toBe(0xaa);

            // Verify task was not touched
            expect(mockTask.cancel).not.toHaveBeenCalled();
            expect(mockTask.schedule).not.toHaveBeenCalled();
        });
    });
});
