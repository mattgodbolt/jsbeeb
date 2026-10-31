import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Cmos, defaultCmos, localStoragePersistence } from "../../src/cmos.js";

describe("CMOS", () => {
    const mockPersistence = {
        load: vi.fn().mockReturnValue(null),
        save: vi.fn(),
    };

    const TEST_DATE = new Date(2023, 3, 15, 12, 34, 56);

    const CMOS_ADDR = {
        SECONDS: 0,
        MINUTES: 2,
        HOURS: 4,
        DAY_OF_WEEK: 6,
        DAY_OF_MONTH: 7,
        MONTH: 8,
        YEAR: 9,
        CONFIG_1: 12,
        CONFIG_2: 13,
        FILING_SYSTEM: 19,
        LAST: 63,
    };

    const PORT_B_ENABLE = 0x40;
    const PORT_B_ADDR_SEL = 0x80;
    const IC32_READ = 2;
    const IC32_DATA_SEL = 4;

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

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(TEST_DATE);
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
            mockPersistence.load.mockReturnValueOnce(Array(48).fill(0x42));
            expect(readRegister(CMOS_ADDR.CONFIG_1, new Cmos(mockPersistence))).toBe(0x42);
        });

        it("should apply CMOS override when provided", () => {
            const cmosOverride = (store) => {
                const newStore = [...store];
                newStore[CMOS_ADDR.CONFIG_1] = 0x42;
                return newStore;
            };
            expect(readRegister(CMOS_ADDR.CONFIG_1, new Cmos(mockPersistence, cmosOverride))).toBe(0x42);
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
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM, new Cmos(mockPersistence))).toBe(untouchedDefault);
        });

        it("should apply econet settings when provided", () => {
            const customCmos = new Cmos(mockPersistence, null, { stationId: 0x42 });
            expect(readRegister(0x0e, customCmos)).toBe(0x42);
            expect(readRegister(0x0f, customCmos)).toBe(254);
        });
    });

    describe("Reading and Writing non-RTC data", () => {
        it("should return 0xFF when CMOS is disabled", () => {
            expect(cmos.read()).toBe(0xff);
        });

        it("should only read when properly configured", () => {
            writeRegister(CMOS_ADDR.CONFIG_2, 0x42);
            expect(cmos.read()).toBe(0xff);

            cmos.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, 0, IC32_READ);
            expect(cmos.read()).toBe(0xff);

            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ);
            expect(cmos.read()).toBe(0xff);

            expect(readRegister(CMOS_ADDR.CONFIG_2)).toBe(0x42);
        });
    });

    const readClock = (target = cmos) =>
        Object.fromEntries(
            ["SECONDS", "MINUTES", "HOURS", "DAY_OF_WEEK", "DAY_OF_MONTH", "MONTH", "YEAR"].map((name) => [
                name,
                readRegister(CMOS_ADDR[name], target),
            ]),
        );
    const toBcd = (value) => parseInt(value.toString(10), 16);

    describe("The real-time clock", () => {
        const testDateRegisters = {
            SECONDS: 0x56,
            MINUTES: 0x34,
            HOURS: 0x12,
            DAY_OF_WEEK: 0x07,
            DAY_OF_MONTH: 0x15,
            MONTH: 0x04,
            YEAR: 0x23,
        };
        it("reads the time it is now", () => {
            expect(readClock()).toEqual(testDateRegisters);
        });

        it.each(
            [
                { register: "SECONDS", value: 0x59, dayOfWeek: 0x07 },
                { register: "MINUTES", value: 0x45, dayOfWeek: 0x07 },
                { register: "HOURS", value: 0x23, dayOfWeek: 0x07 },
                { register: "HOURS", value: 0x00, dayOfWeek: 0x07 },
                { register: "DAY_OF_MONTH", value: 0x30, dayOfWeek: 0x01 },
                { register: "DAY_OF_MONTH", value: 0x01, dayOfWeek: 0x07 },
                { register: "MONTH", value: 0x01, dayOfWeek: 0x01 },
                { register: "MONTH", value: 0x10, dayOfWeek: 0x01 },
                { register: "MONTH", value: 0x12, dayOfWeek: 0x06 },
                { register: "YEAR", value: 0x00, dayOfWeek: 0x07 },
                { register: "YEAR", value: 0x79, dayOfWeek: 0x07 },
                { register: "YEAR", value: 0x80, dayOfWeek: 0x02 },
                { register: "YEAR", value: 0x99, dayOfWeek: 0x04 },
            ].map((row) => ({ ...row, hex: row.value.toString(16).padStart(2, "0") })),
        )(
            "reads back $register written as &$hex, and the day of the week that date falls on",
            ({ register, value, dayOfWeek }) => {
                writeRegister(CMOS_ADDR[register], value);
                expect(readClock()).toEqual({ ...testDateRegisters, [register]: value, DAY_OF_WEEK: dayOfWeek });
            },
        );

        const lastDaysOfMonths = (year) =>
            Array.from({ length: 12 }, (_, month) => ({
                year,
                month: month + 1,
                day: new Date(year, month + 1, 0).getDate(),
            }));

        it.each([...lastDaysOfMonths(2023), ...lastDaysOfMonths(2024), { year: 2024, month: 1, day: 1 }])(
            "reads back $day/$month/$year written in the MOS's order, from a clock in any month",
            ({ year, month, day }) => {
                for (let startMonth = 0; startMonth < 12; startMonth++) {
                    vi.setSystemTime(new Date(2023, startMonth, 15, 12, 34, 56));
                    const clock = new Cmos(null);
                    for (const [register, value] of [
                        ["DAY_OF_MONTH", day],
                        ["MONTH", month],
                        ["YEAR", year % 100],
                    ])
                        writeRegister(CMOS_ADDR[register], toBcd(value), clock);
                    expect(readClock(clock), `from month ${startMonth + 1}`).toEqual({
                        ...testDateRegisters,
                        DAY_OF_WEEK: new Date(year, month - 1, day).getDay() + 1,
                        DAY_OF_MONTH: toBcd(day),
                        MONTH: toBcd(month),
                        YEAR: toBcd(year % 100),
                    });
                }
            },
        );

        it.each([0x31, 0x00, 0x1a, 0xa5].map((day) => ({ day, hex: day.toString(16).padStart(2, "0") })))(
            "holds a day of the month of &$hex, which April lacks, as written while the time is set and runs",
            ({ day }) => {
                writeRegister(CMOS_ADDR.DAY_OF_MONTH, day);
                writeRegister(CMOS_ADDR.HOURS, 0x13);
                vi.advanceTimersByTime(1000);
                expect(readClock()).toEqual({ ...testDateRegisters, HOURS: 0x13, SECONDS: 0x57, DAY_OF_MONTH: day });
            },
        );

        it.each(
            [
                { register: "SECONDS", value: 0xa5 },
                { register: "SECONDS", value: 0x5a },
                { register: "SECONDS", value: 0x60 },
                { register: "MINUTES", value: 0xff },
                { register: "HOURS", value: 0x24 },
            ].map((row) => ({ ...row, hex: row.value.toString(16).padStart(2, "0") })),
        )(
            "holds $register written as &$hex, which is not a time, as written while the clock runs",
            ({ register, value }) => {
                writeRegister(CMOS_ADDR[register], value);
                vi.advanceTimersByTime(1000);
                expect(readClock()).toEqual({ ...testDateRegisters, SECONDS: 0x57, [register]: value });
                writeRegister(CMOS_ADDR[register], testDateRegisters[register]);
                expect(readClock()).toEqual({
                    ...testDateRegisters,
                    SECONDS: 0x57,
                    [register]: testDateRegisters[register],
                });
            },
        );

        it("runs on from what was written, into the next year", () => {
            writeRegister(CMOS_ADDR.MONTH, 0x12);
            writeRegister(CMOS_ADDR.DAY_OF_MONTH, 0x31);
            writeRegister(CMOS_ADDR.YEAR, 0x26);
            writeRegister(CMOS_ADDR.HOURS, 0x23);
            writeRegister(CMOS_ADDR.MINUTES, 0x59);
            writeRegister(CMOS_ADDR.SECONDS, 0x59);
            vi.advanceTimersByTime(1000);
            expect(readClock()).toEqual({
                SECONDS: 0x00,
                MINUTES: 0x00,
                HOURS: 0x00,
                DAY_OF_WEEK: 0x06,
                DAY_OF_MONTH: 0x01,
                MONTH: 0x01,
                YEAR: 0x27,
            });
        });
    });

    describe("Snapshots", () => {
        const BusFields = ["enabled", "isRead", "addressSelect", "dataSelect", "cmosAddr"];
        const busOf = (state) => Object.fromEntries(BusFields.map((field) => [field, state[field]]));

        it.each([
            ["settings and clock", (state) => state, [0x42, 0xa5]],
            ["bus alone, from an older page", busOf, [0x17, 0x30]],
        ])("restores the %s, keeping only what the machine writes after", (_, saved, expected) => {
            writeRegister(CMOS_ADDR.FILING_SYSTEM, 0x42);
            writeRegister(CMOS_ADDR.MINUTES, 0xa5);
            const state = saved(cmos.snapshotState());
            writeRegister(CMOS_ADDR.FILING_SYSTEM, 0x17);
            writeRegister(CMOS_ADDR.MINUTES, 0x30);
            const kept = [...mockPersistence.save.mock.lastCall[0]];
            cmos.restoreState(state);
            expect([readRegister(CMOS_ADDR.FILING_SYSTEM), readRegister(CMOS_ADDR.MINUTES)]).toEqual(expected);
            writeRegister(CMOS_ADDR.CONFIG_1, 0x55);
            kept[CMOS_ADDR.CONFIG_1] = 0x55;
            expect(mockPersistence.save.mock.lastCall[0]).toEqual(kept);
        });

        it("refuses a store that is not the chip's, changing nothing", () => {
            const other = new Cmos(null);
            other.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.FILING_SYSTEM, 0);
            other.writeControl(PORT_B_ENABLE, CMOS_ADDR.FILING_SYSTEM, 0);
            other.writeControl(PORT_B_ENABLE, 0x42, IC32_DATA_SEL);
            const before = cmos.snapshotState();
            expect(() => cmos.restoreState({ ...other.snapshotState(), store: [1, 2, 3] })).toThrow(
                "not 48 to 64 bytes",
            );
            expect(cmos.snapshotState()).toEqual(before);
        });
    });

    describe("Joining a session", () => {
        const HourMs = 60 * 60 * 1000;
        const sessionState = (overrides = {}) => ({ ...new Cmos(null).snapshotState(), ...overrides });
        // As restoreSessionSnapshot joins, the host's chip coming in with the machine's snapshot.
        const join = (state, now) => {
            cmos.joinSession(now);
            cmos.restoreState(state);
        };

        afterEach(() => {
            vi.unstubAllEnvs();
        });

        it("reads and writes the session's settings and stores nothing", () => {
            const store = [...defaultCmos];
            store[CMOS_ADDR.FILING_SYSTEM] = 0x42;
            mockPersistence.save.mockClear();
            join(sessionState({ store }), () => 0);
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(0x42);
            writeRegister(CMOS_ADDR.FILING_SYSTEM, 0x17);
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(0x17);
            expect(mockPersistence.save).not.toHaveBeenCalled();
            expect(store[CMOS_ADDR.FILING_SYSTEM]).toBe(0x42);
        });

        it("reads the session's clock in UTC, so every time zone shows the host's time", () => {
            vi.stubEnv("TZ", "America/New_York");
            join(sessionState(), () => Date.UTC(1999, 11, 31, 23, 59, 58));
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(0x23);
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(0x59);
        });

        it("keeps the offset the host's software set its clock to", () => {
            join(sessionState({ timeOffset: HourMs }), () => Date.UTC(1999, 11, 31, 10, 0, 0));
            expect(readRegister(CMOS_ADDR.HOURS)).toBe(0x11);
        });

        it("picks up an access the host was part way through", () => {
            const host = new Cmos(null);
            host.store[CMOS_ADDR.FILING_SYSTEM] = 0x42;
            host.writeControl(PORT_B_ENABLE | PORT_B_ADDR_SEL, CMOS_ADDR.FILING_SYSTEM, 0);
            host.writeControl(PORT_B_ENABLE, CMOS_ADDR.FILING_SYSTEM, 0);
            join(host.snapshotState(), () => 0);
            cmos.writeControl(PORT_B_ENABLE, 0, IC32_READ | IC32_DATA_SEL);
            expect(cmos.read()).toBe(0x42);
        });

        it("finishes setting a date the host is part way through", () => {
            const host = new Cmos(null);
            writeRegister(CMOS_ADDR.DAY_OF_MONTH, 0x31, host);
            join(host.snapshotState(), () => Date.UTC(2023, 3, 15, 12, 0, 0));
            writeRegister(CMOS_ADDR.MONTH, 0x05);
            expect([readRegister(CMOS_ADDR.DAY_OF_MONTH), readRegister(CMOS_ADDR.MONTH)]).toEqual([0x31, 0x05]);
        });

        it("reads a time register the host holds as written", () => {
            const host = new Cmos(null);
            writeRegister(CMOS_ADDR.MINUTES, 0xa5, host);
            join(host.snapshotState(), () => 0);
            expect(readRegister(CMOS_ADDR.MINUTES)).toBe(0xa5);
        });

        it("as the host, whose chip the session starts from, goes back to its own after the session", () => {
            const settingsAndClock = ({ store, timeOffset, heldDate, heldTime }) => ({
                store,
                timeOffset,
                heldDate,
                heldTime,
            });
            const own = settingsAndClock(cmos.snapshotState());
            cmos.joinSession(() => 0);
            writeRegister(CMOS_ADDR.FILING_SYSTEM, 0x42);
            writeRegister(CMOS_ADDR.MINUTES, 0xa5);
            cmos.leaveSession();
            expect(settingsAndClock(cmos.snapshotState())).toEqual(own);
        });

        it("goes back to its own settings, clock and saving after the session, however often it rejoined", () => {
            vi.stubEnv("TZ", "America/New_York");
            writeRegister(CMOS_ADDR.HOURS, 0x10);
            writeRegister(CMOS_ADDR.MINUTES, 0xa5);
            writeRegister(CMOS_ADDR.DAY_OF_MONTH, 0x31);
            const ownClock = readClock();
            const ownSetting = readRegister(CMOS_ADDR.FILING_SYSTEM);
            const store = [...defaultCmos];
            store[CMOS_ADDR.FILING_SYSTEM] = ownSetting ^ 0xff;
            join(sessionState({ store }), () => 0);
            join(sessionState({ store }), () => 0);
            cmos.leaveSession();
            expect(readRegister(CMOS_ADDR.FILING_SYSTEM)).toBe(ownSetting);
            expect(readClock()).toEqual(ownClock);
            mockPersistence.save.mockClear();
            cmos.save();
            expect(mockPersistence.save).toHaveBeenCalled();
        });
    });

    describe("Default CMOS values", () => {
        it("should default FDRIVE to 0 (6ms step rate) at CMOS address 0x19 (storage byte 11)", () => {
            expect(defaultCmos[0x19] & 0x03).toBe(0);
        });
    });

    describe("localStoragePersistence", () => {
        const onSaveFailure = vi.fn();

        beforeEach(() => {
            onSaveFailure.mockClear();
            vi.spyOn(console, "log").mockImplementation(() => {});
        });
        afterEach(() => vi.restoreAllMocks());

        it.each([48, 50])(
            "keeps what was written anywhere in the chip for the next session, from an older page's %i bytes",
            (olderBytes) => {
                const olderStore = defaultCmos.slice(0, olderBytes);
                olderStore[CMOS_ADDR.FILING_SYSTEM] = 0x42;
                const storage = { cmosRam: JSON.stringify(olderStore) };

                const cmos = new Cmos(localStoragePersistence(() => storage, onSaveFailure));
                writeRegister(CMOS_ADDR.CONFIG_1, 0x43, cmos);
                writeRegister(CMOS_ADDR.LAST, 0x44, cmos);

                const reloaded = new Cmos(localStoragePersistence(() => storage, onSaveFailure));
                expect(
                    [CMOS_ADDR.FILING_SYSTEM, CMOS_ADDR.CONFIG_1, CMOS_ADDR.LAST].map((a) => readRegister(a, reloaded)),
                ).toEqual([0x42, 0x43, 0x44]);
                expect(onSaveFailure).not.toHaveBeenCalled();
            },
        );

        it.each(["[0, 1, tru", '"nonsense"', "[1, 2, 3]", '{"config": 1}', "null", JSON.stringify(Array(65).fill(0))])(
            "starts from the defaults when the stored settings are %s",
            (cmosRam) => {
                const cmos = new Cmos(localStoragePersistence(() => ({ cmosRam }), onSaveFailure));
                expect(readRegister(0x19, cmos)).toBe(defaultCmos[0x19]);
            },
        );

        it("starts from the defaults when the page is refused storage altogether", () => {
            const refused = () => {
                throw new Error("The operation is insecure");
            };

            const cmos = new Cmos(localStoragePersistence(refused, onSaveFailure));
            writeRegister(CMOS_ADDR.CONFIG_1, 0x42, cmos);

            expect(readRegister(0x19, cmos)).toBe(defaultCmos[0x19]);
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
});
