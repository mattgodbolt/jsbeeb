import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Adc } from "../../src/adc.js";
import { AnalogueSource } from "../../src/analogue-source.js";

// Create a mock gamepad source for testing
class MockGamepadSource extends AnalogueSource {
    constructor() {
        super();
        this.mockValues = {
            0: 0x3fff, // Channel 0: halfway (0.5) -> 0x3fff
            1: 0xffff, // Channel 1: max (-1.0) -> 0xffff
            2: 0x5fff, // Channel 2: quarter (0.25) -> 0x5fff
            3: 0xdfff, // Channel 3: three quarters (-0.75) -> 0xdfff
        };
    }

    getValue(channel) {
        return this.mockValues[channel] || 0x8000;
    }
}

describe("ADC", () => {
    // Mock dependencies
    const mockSysvia = {
        setcb1: vi.fn(),
    };

    const mockScheduler = {
        newTask: vi.fn().mockImplementation((callback) => ({
            schedule: vi.fn(),
            cancel: vi.fn(),
            callback,
        })),
    };

    let adc;
    let mockTask;
    let mockGamepadSource;

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

        mockGamepadSource = new MockGamepadSource();
        adc.setChannelSource(0, mockGamepadSource);
        adc.setChannelSource(1, mockGamepadSource);
        adc.setChannelSource(2, mockGamepadSource);
        adc.setChannelSource(3, mockGamepadSource);
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

    describe("Analogue sources", () => {
        it("should set and get a channel source", () => {
            const newSource = new MockGamepadSource();
            const result = adc.setChannelSource(1, newSource);
            expect(result).toBe(true);
            expect(adc.getChannelSource(1)).toBe(newSource);
        });

        it("should clear a channel source", () => {
            const result = adc.clearChannelSource(2);
            expect(result).toBe(true);
            expect(adc.getChannelSource(2)).toBe(null);
        });

        it("should clear all sources", () => {
            adc.clearSources();
            for (let i = 0; i < 4; i++) {
                expect(adc.getChannelSource(i)).toBe(null);
            }
        });
    });

    describe("Conversion completion", () => {
        it("should handle completion with no source for the channel", () => {
            adc.clearChannelSource(1);

            // Set up a conversion for channel 1
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

        it("should read from source on channel 0", () => {
            // Set channel 0
            adc.write(0, 0x00);

            // Simulate conversion completion
            adc.onComplete();

            // Check that the mock value was used
            const expectedValue = mockGamepadSource.getValue(0);
            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);
        });

        it("should read from source on channel 1", () => {
            // Set channel 1
            adc.write(0, 0x01);

            // Simulate conversion completion
            adc.onComplete();

            // Check that the mock value was used
            const expectedValue = mockGamepadSource.getValue(1);
            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);
        });

        it("should use specific source for each channel", () => {
            // Create a special source for channel 2 with a different value
            const specialSource = new MockGamepadSource();
            specialSource.mockValues[2] = 0x1234; // Different value

            // Set it as the source for channel 2
            adc.setChannelSource(2, specialSource);

            // Set channel 2
            adc.write(0, 0x02);

            // Simulate conversion completion
            adc.onComplete();

            // Should use the special source for channel 2
            const expectedValue = specialSource.getValue(2);
            expect(adc.low).toBe(expectedValue & 0xff);
            expect(adc.high).toBe((expectedValue >>> 8) & 0xff);
        });

        it("should switch between different sources by channel", () => {
            // Create two different sources with different values
            const source1 = new MockGamepadSource();
            source1.mockValues[2] = 0x1111;

            const source2 = new MockGamepadSource();
            source2.mockValues[3] = 0x2222;

            // Set them for different channels
            adc.setChannelSource(2, source1);
            adc.setChannelSource(3, source2);

            // Test channel 2 (should use source1)
            adc.write(0, 0x02);
            adc.onComplete();
            expect(adc.low).toBe(0x11); // 0x1111 & 0xff
            expect(adc.high).toBe(0x11); // (0x1111 >>> 8) & 0xff

            // Test channel 3 (should use source2)
            adc.write(0, 0x03);
            adc.onComplete();
            expect(adc.low).toBe(0x22); // 0x2222 & 0xff
            expect(adc.high).toBe(0x22); // (0x2222 >>> 8) & 0xff
        });

        it("should update status bits correctly after conversion", () => {
            // Set channel 2
            adc.write(0, 0x02);

            // Simulate conversion completion
            adc.onComplete();

            // Get the expected value from our mock source
            const expectedValue = mockGamepadSource.getValue(2);

            // The status should have:
            // - bits 0-3: channel number (0)
            // - bit 6: end of conversion bit (1)
            // - bits 4-5: ((0x5fff >>> 10) & 0x03) = 0x01 (shifted to bit position)
            const expectedStatus = (0x00 & 0x0f) | 0x40 | ((expectedValue >>> 10) & 0x03);

            expect(adc.status).toBe(expectedStatus);
        });
    });
});
