import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Cmos, defaultCmos, localStoragePersistence } from "../../src/cmos.js";

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
        FILING_SYSTEM: 19,
    };

    // Constants from the hardware implementation
    const PORT_B_ENABLE = 0x40; // Bit 6 of port B
    const PORT_B_ADDR_SEL = 0x80; // Bit 7 of port B
    const IC32_READ = 2; // Bit 1 of IC32
    const IC32_DATA_SEL = 4; // Bit 2 of IC32

    let cmos;

    function readRegister(register, target = cmos) {
        target.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, register, 0);
        target.writeControl(PORT_B_ENABLE, register, 0);
        target.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
        return target.read();
    }

    function writeRegister(register, value, target = cmos) {
        target.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, register, 0);
        target.writeControl(PORT_B_ENABLE, register, 0);
        target.writeControl(PORT_B_ENABLE, value, IC32_DATA_SEL);
        target.writeControl(PORT_B_ENABLE, value, 0);
    }

    const toBcd = (value) => parseInt(value.toString(10), 16);

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

        it("should not let a mutating override change the defaults for later machines", () => {
            const ADFS_FS_ID = 13;
            const untouchedDefault = defaultCmos[CMOS_ADDR.FILING_SYSTEM];
            const mutatingOverride = (cmos) => {
                cmos[CMOS_ADDR.FILING_SYSTEM] = (cmos[CMOS_ADDR.FILING_SYSTEM] & 0xf0) | ADFS_FS_ID;
                return cmos;
            };
            new Cmos(mockPersistence, mutatingOverride);
            expect(defaultCmos[CMOS_ADDR.FILING_SYSTEM]).toBe(untouchedDefault);

            const plainCmos = new Cmos(mockPersistence);
            plainCmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.FILING_SYSTEM, 0);
            plainCmos.writeControl(PORT_B_ENABLE, CMOS_ADDR.FILING_SYSTEM, 0);
            plainCmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);

            expect(plainCmos.read()).toBe(untouchedDefault);
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
        it("should read current time from RTC registers", () => {
            // Test all RTC components
            expect(readRegister(CMOS_ADDR.SECONDS)).toBe(toBcd(TEST_DATE.getSeconds()));
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(toBcd(TEST_DATE.getMinutes()));
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(toBcd(TEST_DATE.getHours()));
            expect(readRegister(CMOS_ADDR.DAY_OF_WEEK)).toBe(toBcd(TEST_DATE.getDay() + 1));
            expect(readRegister(CMOS_ADDR.DAY_OF_MONTH)).toBe(toBcd(TEST_DATE.getDate()));
            expect(readRegister(CMOS_ADDR.MONTH)).toBe(toBcd(TEST_DATE.getMonth() + 1));
        });
    });

    describe("Joining a session", () => {
        const HourMs = 60 * 60 * 1000;
        const sessionState = (overrides = {}) => ({ ...new Cmos(null).sessionState(), ...overrides });

        afterEach(() => {
            vi.unstubAllEnvs();
        });

        it("reads and writes the session's settings and stores nothing", () => {
            const store = [...defaultCmos];
            store[CMOS_ADDR.FILING_SYSTEM] = 0x42;
            mockPersistence.save.mockClear();
            cmos.joinSession(sessionState({ store }), () => 0);
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(0x42);
            writeRegister(CMOS_ADDR.FILING_SYSTEM, 0x17);
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(0x17);
            expect(mockPersistence.save).not.toHaveBeenCalled();
            expect(store[CMOS_ADDR.FILING_SYSTEM]).toBe(0x42);
        });

        it("reads the session's clock in UTC, so every time zone shows the host's time", () => {
            vi.stubEnv("TZ", "America/New_York");
            cmos.joinSession(sessionState(), () => Date.UTC(1999, 11, 31, 23, 59, 58));
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(toBcd(23));
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(toBcd(59));
        });

        it("keeps the offset the host's software set its clock to", () => {
            cmos.joinSession(sessionState({ timeOffset: HourMs }), () => Date.UTC(1999, 11, 31, 10, 0, 0));
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(toBcd(11));
        });

        it("picks up an access the host was part way through", () => {
            const host = new Cmos(null);
            host.store[CMOS_ADDR.FILING_SYSTEM] = 0x42;
            host.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.FILING_SYSTEM, 0);
            host.writeControl(PORT_B_ENABLE, CMOS_ADDR.FILING_SYSTEM, 0);
            cmos.joinSession(host.sessionState(), () => 0);
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
            expect(cmos.read()).toBe(0x42);
        });

        it("goes back to its own settings, clock and saving after the session, however often it rejoined", () => {
            vi.stubEnv("TZ", "America/New_York");
            writeRegister(CMOS_ADDR.HOURS, toBcd(10));
            const ownSetting = readRegister(CMOS_ADDR.FILING_SYSTEM);
            const store = [...defaultCmos];
            store[CMOS_ADDR.FILING_SYSTEM] = ownSetting ^ 0xff;
            cmos.joinSession(sessionState({ store }), () => 0);
            cmos.joinSession(sessionState({ store }), () => 0);
            cmos.leaveSession();
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(ownSetting);
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(toBcd(10));
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(toBcd(TEST_DATE.getMinutes()));
            mockPersistence.save.mockClear();
            cmos.save();
            expect(mockPersistence.save).toHaveBeenCalled();
        });
    });

    describe("Setting RTC values", () => {
        it("should update RTC values when written", () => {
            // Set hours to 10
            writeRegister(CMOS_ADDR.HOURS, 0x10);

            // Advance time slightly to ensure changes take effect
            vi.advanceTimersByTime(100);

            // Read back hours
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(0x10);

            // Set minutes to 45
            writeRegister(CMOS_ADDR.MINUTES, 0x45);

            // Advance time slightly
            vi.advanceTimersByTime(100);

            // Read back minutes
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(0x45);
        });
    });

    describe("Default CMOS values", () => {
        it("should default FDRIVE to 0 (6ms step rate) at CMOS address 0x19 (storage byte 11)", () => {
            // CMOS layout: bytes 0-13 are RTC internals; bytes 14+ are user storage.
            // Storage byte 11 = CMOS address 25 (0x19) holds the DFS configuration
            // byte whose bits [1:0] are the WD1770 *CONFIGURE FDRIVE step rate:
            //   0b00 = 6ms, 0b01 = 12ms, 0b10 = 20ms, 0b11 = 30ms
            // FDRIVE 0 (6ms) is required for disc-streaming demos to complete
            // seeks within the vsync window on the Master 128.
            const fdriveBits = defaultCmos[25] & 0x03;
            expect(fdriveBits).toBe(0); // FDRIVE 0 = 6ms
        });
    });

    describe("localStoragePersistence", () => {
        const onSaveFailure = vi.fn();

        beforeEach(() => {
            onSaveFailure.mockClear();
            vi.spyOn(console, "log").mockImplementation(() => {});
        });
        afterEach(() => vi.restoreAllMocks());

        it("keeps what was written for the next session", () => {
            const storage = {};

            writeRegister(CMOS_ADDR.CONFIG_1, 0x42, new Cmos(localStoragePersistence(() => storage, onSaveFailure)));

            const reloaded = new Cmos(localStoragePersistence(() => storage, onSaveFailure));
            expect(readRegister(CMOS_ADDR.CONFIG_1, reloaded)).toBe(0x42);
            expect(onSaveFailure).not.toHaveBeenCalled();
        });

        it("starts from the defaults when the stored settings are unreadable", () => {
            const storage = { cmosRam: "[0, 1, tru" };

            const cmos = new Cmos(localStoragePersistence(() => storage, onSaveFailure));

            expect(readRegister(25, cmos)).toBe(defaultCmos[25]);
        });

        it("starts from the defaults when the stored settings are the wrong shape", () => {
            for (const cmosRam of ['"nonsense"', "[1, 2, 3]", '{"config": 1}', "null"]) {
                const cmos = new Cmos(localStoragePersistence(() => ({ cmosRam }), onSaveFailure));
                expect(readRegister(25, cmos), cmosRam).toBe(defaultCmos[25]);
            }
        });

        it("starts from the defaults when the page is refused storage altogether", () => {
            const refused = () => {
                throw new Error("The operation is insecure");
            };

            const cmos = new Cmos(localStoragePersistence(refused, onSaveFailure));
            writeRegister(CMOS_ADDR.CONFIG_1, 0x42, cmos);

            expect(readRegister(25, cmos)).toBe(defaultCmos[25]);
            expect(onSaveFailure).toHaveBeenCalledTimes(1);
        });

        it("reports a save that fails once, however many writes follow", () => {
            const storage = {
                get cmosRam() {
                    return undefined;
                },
                set cmosRam(value) {
                    throw new Error("Storage is full");
                },
            };

            const cmos = new Cmos(localStoragePersistence(() => storage, onSaveFailure));
            writeRegister(CMOS_ADDR.CONFIG_1, 0x42, cmos);
            writeRegister(CMOS_ADDR.CONFIG_2, 0x43, cmos);

            expect(onSaveFailure).toHaveBeenCalledTimes(1);
            expect(onSaveFailure.mock.calls[0][0].message).toBe("Storage is full");
            expect(readRegister(CMOS_ADDR.CONFIG_1, cmos)).toBe(0x42);
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
