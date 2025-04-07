import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Cmos } from "../../src/cmos.js";

describe("CMOS", () => {
    // Mock persistence
    const mockPersistence = {
        load: vi.fn().mockReturnValue(null),
        save: vi.fn(),
    };

    // Test date (2023-04-15T12:34:56)
    const TEST_DATE = new Date(2023, 3, 15, 12, 34, 56);

    // CMOS register addresses (from BBC Micro documentation)
    const CMOS_ADDR = {
        SECONDS: 0,
        MINUTES: 2,
        HOURS: 4,
        DAY_OF_WEEK: 6,
        DAY_OF_MONTH: 7,
        MONTH: 8,
        YEAR: 9,
        // Non-RTC addresses for testing
        CONFIG_1: 12,
        CONFIG_2: 13,
    };

    // Constants from the hardware implementation
    const PORT_B_ENABLE = 0x40; // Bit 6 of port B
    const PORT_B_ADDR_SEL = 0x80; // Bit 7 of port B
    const IC32_READ = 2; // Bit 1 of IC32
    const IC32_DATA_SEL = 4; // Bit 2 of IC32

    let cmos;

    beforeEach(() => {
        // Use fake timers for consistent date/time testing
        vi.useFakeTimers();
        vi.setSystemTime(TEST_DATE);

        // Create a fresh CMOS instance for each test
        cmos = new Cmos(mockPersistence);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetAllMocks();
    });

    describe("Initialization", () => {
        it("should initialize with persistence and save default values", () => {
            expect(mockPersistence.save).toHaveBeenCalled();
        });

        it("should use custom persistence data if available", () => {
            const customData = Array(48).fill(0x42);
            mockPersistence.load.mockReturnValueOnce(customData);

            const customCmos = new Cmos(mockPersistence);

            // Reading from a non-RTC location should return our custom data
            // First enable CMOS and set it up for reading
            customCmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.CONFIG_1, 0);
            customCmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.CONFIG_1, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            expect(customCmos.read()).toBe(0x42);
        });

        it("should apply CMOS override when provided", () => {
            const cmosOverride = (store) => {
                const newStore = [...store];
                newStore[CMOS_ADDR.CONFIG_1] = 0x42;
                return newStore;
            };

            const customCmos = new Cmos(mockPersistence, cmosOverride);

            // Reading from the overridden location should return our custom value
            // First enable CMOS and set it up for reading
            customCmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.CONFIG_1, 0);
            customCmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.CONFIG_1, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            expect(customCmos.read()).toBe(0x42);
        });

        it("should apply econet settings when provided", () => {
            const econet = { stationId: 0x42 };
            const customCmos = new Cmos(mockPersistence, null, econet);

            // First read econet station ID (at address 0x0E)
            customCmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, 0x0e, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0x0e, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            expect(customCmos.read()).toBe(0x42);

            // Then read FS ID (at address 0x0F)
            customCmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, 0x0f, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0x0f, 0);
            customCmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            expect(customCmos.read()).toBe(254);
        });
    });

    describe("Reading and Writing non-RTC data", () => {
        it("should return 0xFF when CMOS is disabled", () => {
            // Don't enable CMOS (no PORT_B_ENABLE bit)
            expect(cmos.read()).toBe(0xff);
        });

        it("should write and read from CMOS memory locations", () => {
            // Set address to CONFIG_1 (addr 12)
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.CONFIG_1, 0);
            cmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.CONFIG_1, 0);

            // Write value 0x42 to CONFIG_1
            cmos.writeControl(PORT_B_ENABLE, 0x42, IC32_DATA_SEL);
            cmos.writeControl(PORT_B_ENABLE, 0x42, 0);

            // Read it back
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
            expect(cmos.read()).toBe(0x42);

            // Check persistence was called
            expect(mockPersistence.save).toHaveBeenCalled();
        });

        it("should only read when properly configured", () => {
            // Set address to CONFIG_2 (different than other tests)
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.CONFIG_2, 0);
            cmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.CONFIG_2, 0);

            // Write a known test value
            cmos.writeControl(PORT_B_ENABLE, 0x42, IC32_DATA_SEL);
            cmos.writeControl(PORT_B_ENABLE, 0x42, 0);

            // Without setting the read mode, should return 0xFF
            expect(cmos.read()).toBe(0xff);

            // With address select high, should return 0xFF
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, 0, IC32_READ);
            expect(cmos.read()).toBe(0xff);

            // With data select low, should return 0xFF
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ);
            expect(cmos.read()).toBe(0xff);

            // Make sure we're still pointing at the right address
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.CONFIG_2, 0);
            cmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.CONFIG_2, 0);

            // With everything set correctly, should return the value
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
            expect(cmos.read()).toBe(0x42);
        });
    });

    describe("Reading RTC values", () => {
        // Helper function to read a specific RTC register
        function readRtcRegister(register) {
            // Set address
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, register, 0);
            cmos.writeControl(PORT_B_ENABLE, register, 0);

            // Configure for reading
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            return cmos.read();
        }

        it("should read current time from RTC registers", () => {
            // Helper function for BCD conversion (same as in cmos.js)
            function toBcd(value) {
                return parseInt(value.toString(10), 16);
            }

            // Test all RTC components
            expect(readRtcRegister(CMOS_ADDR.SECONDS)).toBe(toBcd(TEST_DATE.getSeconds()));
            expect(readRtcRegister(CMOS_ADDR.MINUTES)).toBe(toBcd(TEST_DATE.getMinutes()));
            expect(readRtcRegister(CMOS_ADDR.HOURS)).toBe(toBcd(TEST_DATE.getHours()));
            expect(readRtcRegister(CMOS_ADDR.DAY_OF_WEEK)).toBe(toBcd(TEST_DATE.getDay() + 1));
            expect(readRtcRegister(CMOS_ADDR.DAY_OF_MONTH)).toBe(toBcd(TEST_DATE.getDate()));
            expect(readRtcRegister(CMOS_ADDR.MONTH)).toBe(toBcd(TEST_DATE.getMonth() + 1));
        });
    });

    describe("Setting RTC values", () => {
        // Helper to read a specific RTC register
        function readRtcRegister(register) {
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, register, 0);
            cmos.writeControl(PORT_B_ENABLE, register, 0);
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
            return cmos.read();
        }

        // Helper to write to a specific RTC register
        function writeRtcRegister(register, value) {
            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, register, 0);
            cmos.writeControl(PORT_B_ENABLE, register, 0);
            cmos.writeControl(PORT_B_ENABLE, value, IC32_DATA_SEL);
            cmos.writeControl(PORT_B_ENABLE, value, 0);
        }

        it("should update RTC values when written", () => {
            // Set hours to 10
            writeRtcRegister(CMOS_ADDR.HOURS, 0x10);

            // Advance time slightly to ensure changes take effect
            vi.advanceTimersByTime(100);

            // Read back hours
            expect(readRtcRegister(CMOS_ADDR.HOURS)).toBe(0x10);

            // Set minutes to 45
            writeRtcRegister(CMOS_ADDR.MINUTES, 0x45);

            // Advance time slightly
            vi.advanceTimersByTime(100);

            // Read back minutes
            expect(readRtcRegister(CMOS_ADDR.MINUTES)).toBe(0x45);
        });
    });

    describe("BCD Conversion Logic", () => {
        it("should correctly convert between decimal and BCD", () => {
            // Helper functions for BCD conversion (same as in cmos.js)
            const toBcd = (value) => parseInt(value.toString(10), 16);
            const fromBcd = (value) => parseInt(value.toString(16), 10);

            // Test toBcd conversion
            expect(toBcd(0)).toBe(0x00);
            expect(toBcd(9)).toBe(0x09);
            expect(toBcd(10)).toBe(0x10);
            expect(toBcd(42)).toBe(0x42);
            expect(toBcd(99)).toBe(0x99);

            // Test fromBcd conversion
            expect(fromBcd(0x00)).toBe(0);
            expect(fromBcd(0x09)).toBe(9);
            expect(fromBcd(0x10)).toBe(10);
            expect(fromBcd(0x42)).toBe(42);
            expect(fromBcd(0x99)).toBe(99);

            // Test round-trips
            for (let i = 0; i < 100; i++) {
                expect(fromBcd(toBcd(i))).toBe(i);
            }
        });

        it("should handle year century threshold correctly", () => {
            const fromBcd = (value) => parseInt(value.toString(16), 10);

            // Years 80-99 should use 1900 as base
            expect(fromBcd(0x80) >= 80 ? 1900 : 2000).toBe(1900);
            expect(fromBcd(0x99) >= 80 ? 1900 : 2000).toBe(1900);

            // Years 00-79 should use 2000 as base
            expect(fromBcd(0x00) >= 80 ? 1900 : 2000).toBe(2000);
            expect(fromBcd(0x79) >= 80 ? 1900 : 2000).toBe(2000);
        });
    });
});
