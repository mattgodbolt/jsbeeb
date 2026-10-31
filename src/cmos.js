// CMOS layout: bytes 0-13 are RTC internal registers; bytes 14-63 are the 50
// bytes of user storage.  Storage byte 11 (= CMOS address 25 = 0x19) holds
// the BBC Master DFS configuration byte whose bits [1:0] are the WD1770 step
// rate (*CONFIGURE FDRIVE):  0=6ms  1=12ms  2=20ms  3=30ms.
// The correct default is FDRIVE 0 (6ms, value 0xc8).  The previous default
// 0xca had bits[1:0]=0b10 (20ms), which caused disc-streaming demos such as
// STNICC-beeb to hang on the Master 128 because the WD1770 seek overran the
// vsync window.  Confirmed by @tom-seddon (b2 emulator):
// https://github.com/mattgodbolt/jsbeeb/issues/576
const defaultCmos = Object.freeze([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfe, 0x00, 0xeb, 0x00,
    0xc9, 0xff, 0xff, 0x12, 0x00, 0x17, 0xc8, 0x1e, 0x05, 0x00, 0x35, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

// Pages before the store was the chip's full size kept only its first 48 bytes.
const OlderStoreBytes = 48;

/** A copy of `bytes` as a whole store, padding one saved by an older page; throws if it is neither. */
function fullStore(bytes) {
    if (!Array.isArray(bytes) || (bytes.length !== defaultCmos.length && bytes.length !== OlderStoreBytes))
        throw new Error(`the settings are not ${defaultCmos.length} bytes`);
    return [...bytes, ...defaultCmos.slice(bytes.length)];
}

// The RTC holds a two-digit year and MOS 3.20 prints it after a fixed century (LDA #&19 at &9880 in ROM 15);
// the ROM jsbeeb ships has that byte patched to &20 (#362), so every year it shows is 20yy.
const MosCentury = 2000;

function toBcd(value) {
    return parseInt(value.toString(10), 16);
}

function fromBcd(value) {
    return parseInt(value.toString(16), 10);
}

const TimeRegisters = Object.freeze({
    0: { limit: 60, get: (time) => time.getSeconds(), set: (time, value) => time.setSeconds(value) },
    2: { limit: 60, get: (time) => time.getMinutes(), set: (time, value) => time.setMinutes(value) },
    4: { limit: 24, get: (time) => time.getHours(), set: (time, value) => time.setHours(value) },
});

function isBcdBelow(value, limit) {
    return value >> 4 < 10 && (value & 0x0f) < 10 && fromBcd(value) < limit;
}

export { defaultCmos };

// A shared session (src/lockstep.js) runs the same machine on several computers in step, one of them hosting.
// The session clock holds the host's local time as if it were UTC and is read and set through this view, so
// every computer shows the host's time, whatever its own time zone.
function utcView(date) {
    return {
        getSeconds: () => date.getUTCSeconds(),
        getMinutes: () => date.getUTCMinutes(),
        getHours: () => date.getUTCHours(),
        getDay: () => date.getUTCDay(),
        getDate: () => date.getUTCDate(),
        getMonth: () => date.getUTCMonth(),
        getFullYear: () => date.getUTCFullYear(),
        setSeconds: (value) => date.setUTCSeconds(value),
        setMinutes: (value) => date.setUTCMinutes(value),
        setHours: (value) => date.setUTCHours(value),
        setFullYear: (year, month, day) => date.setUTCFullYear(year, month, day),
        getTime: () => date.getTime(),
    };
}

/**
 * CMOS persistence backed by a browser storage object, which can be unavailable, full or holding
 * something other than what was last saved.
 *
 * @param {function(): Storage} getStorage typically `() => window.localStorage`. Reading that
 *   property is itself what throws when a page is refused storage, so it happens per call, inside
 *   the try.
 * @param {function(*)} onSaveFailure called with the error the first time a save fails
 */
export function localStoragePersistence(getStorage, onSaveFailure) {
    let saveFailureReported = false;
    return {
        load() {
            try {
                const stored = getStorage().cmosRam;
                if (!stored) return null;
                return fullStore(JSON.parse(stored));
            } catch (error) {
                console.log(`Unable to read the stored CMOS settings: ${error?.message ?? error}`);
                return null;
            }
        },
        save(data) {
            try {
                getStorage().cmosRam = JSON.stringify(data);
            } catch (error) {
                console.log(`Unable to store the CMOS settings: ${error?.message ?? error}`);
                if (saveFailureReported) return;
                saveFailureReported = true;
                onSaveFailure(error);
            }
        },
    };
}

export class Cmos {
    constructor(persistence, cmosOverride, econet) {
        this.store = persistence ? persistence.load() : null;
        this.persistence = persistence;
        this.enabled = false;
        this.isRead = false;
        this.addressSelect = false;
        this.dataSelect = false;
        this.cmosAddr = 0;
        this.now = () => Date.now();
        this.utc = false;
        this.timeOffset = 0;
        // The 146818 keeps the day, month and year in separate registers and checks none of them, so bytes that
        // do not name a real day are held as written until they do.
        this.heldDate = null;
        // Likewise a seconds, minutes or hours byte that is not a time, keyed by register, while the clock runs on.
        this.heldTime = {};
        this.beforeSession = null;
        /** @type {import("./replay.js").InputLog | null} */
        this.inputLog = null;

        if (!this.store) {
            this.store = [...defaultCmos];
        }
        if (cmosOverride) {
            this.store = cmosOverride(this.store);
        }
        if (econet) {
            this.store[0xe] = econet.stationId;
            if (this.store[0xf] === 0) {
                // Catch an invalid FS configuration setting (possibly as a result of using a prior version that didn't set a default of 254 in CMOS)
                this.store[0xf] = 254;
            }
        }
        this.save();
    }

    save() {
        if (this.persistence) {
            this.persistence.save(this.store);
        }
    }

    /** How far through an access the bus is. */
    snapshotState() {
        const { enabled, isRead, addressSelect, dataSelect, cmosAddr } = this;
        return { enabled, isRead, addressSelect, dataSelect, cmosAddr };
    }

    restoreState({ enabled, isRead, addressSelect, dataSelect, cmosAddr }) {
        Object.assign(this, { enabled, isRead, addressSelect, dataSelect, cmosAddr });
    }

    /**
     * The chip as a machine joining a shared session needs it: the settings, the offset a program set
     * the clock to, any clock registers held as written, and the bus.
     */
    sessionState() {
        const { store, timeOffset, heldDate, heldTime } = this;
        return {
            store: [...store],
            timeOffset,
            heldDate: heldDate && { ...heldDate },
            heldTime: { ...heldTime },
            ...this.snapshotState(),
        };
    }

    /**
     * Joins a shared session: the host's `sessionState()` replaces this machine's for the session's
     * duration and is never stored over it, and the clock reads `now`, the session's wall time in
     * milliseconds.
     */
    joinSession(state, now) {
        if (!this.beforeSession) {
            const { persistence, store, utc, timeOffset, heldDate, heldTime } = this;
            this.beforeSession = { persistence, store, now: this.now, utc, timeOffset, heldDate, heldTime };
        }
        const { store, timeOffset, heldDate, heldTime } = state;
        this.restoreState(state);
        this.timeOffset = timeOffset;
        this.store = fullStore(store);
        this.heldDate = heldDate && { ...heldDate };
        this.heldTime = { ...heldTime };
        this.persistence = null;
        this.now = now;
        this.utc = true;
    }

    /** Back to this machine's own settings and clock, as they were before the session. */
    leaveSession() {
        if (!this.beforeSession) return;
        Object.assign(this, this.beforeSession);
        this.beforeSession = null;
    }

    // Whole seconds, all the clock keeps, so that a replay is handed the second each read saw.
    clockMs() {
        const ms = Math.floor(this.now() / 1000) * 1000;
        return this.inputLog ? this.inputLog.sample("rtc", ms) : ms;
    }

    bbcDateTime() {
        const result = new Date(this.clockMs() + this.timeOffset);
        result.setMilliseconds(0);
        return this.utc ? utcView(result) : result;
    }

    calendarRegisters(current) {
        return (
            this.heldDate ?? {
                day: toBcd(current.getDate()),
                month: toBcd(current.getMonth() + 1),
                year: toBcd(current.getFullYear() % 100),
            }
        );
    }

    setTimeFrom(bbcTime) {
        this.timeOffset = bbcTime.getTime() - this.clockMs();
    }

    // Snapshots leave the settings and clock out, so a replay from before a write would read what it wrote.
    refuseReplays() {
        this.inputLog?.refuse("a write to the CMOS");
    }

    writeTime(register, value) {
        this.refuseReplays();
        const { limit, set } = TimeRegisters[register];
        if (!isBcdBelow(value, limit)) {
            this.heldTime[register] = value;
            return;
        }
        delete this.heldTime[register];
        const bbcTime = this.bbcDateTime();
        set(bbcTime, fromBcd(value));
        this.setTimeFrom(bbcTime);
    }

    writeCalendar(field, value) {
        this.refuseReplays();
        const bbcTime = this.bbcDateTime();
        const registers = { ...this.calendarRegisters(bbcTime), [field]: value };
        const { day, month, year } = registers;
        bbcTime.setFullYear(MosCentury + fromBcd(year), fromBcd(month) - 1, fromBcd(day));
        const isRealDay =
            toBcd(bbcTime.getDate()) === day &&
            toBcd(bbcTime.getMonth() + 1) === month &&
            toBcd(bbcTime.getFullYear() % 100) === year;
        if (isRealDay) {
            this.heldDate = null;
            this.setTimeFrom(bbcTime);
        } else {
            this.heldDate = registers;
        }
    }

    read() {
        if (!this.enabled) return 0xff;
        // To drive the bus we need:
        // - CMOS enabled.
        // - Address Select low.
        // - Data Select high.
        // - Read high.

        if (!this.addressSelect && this.dataSelect && this.isRead) {
            // The first 10 bytes of CMOS RAM store the RTC clock
            if (this.cmosAddr < 10) {
                const current = this.bbcDateTime();
                switch (this.cmosAddr) {
                    case 0:
                    case 2:
                    case 4:
                        return this.heldTime[this.cmosAddr] ?? toBcd(TimeRegisters[this.cmosAddr].get(current));
                    case 6:
                        return toBcd(current.getDay() + 1);
                    case 7:
                        return this.calendarRegisters(current).day;
                    case 8:
                        return this.calendarRegisters(current).month;
                    case 9:
                        return this.calendarRegisters(current).year;
                }
            } else {
                return this.store[this.cmosAddr] & 0xff;
            }
        }
        return 0xff;
    }

    /** Takes up the select and read lines as port B and IC32 drive them, making no access. */
    followLines(portBpins, IC32) {
        this.enabled = !!(portBpins & 0x40);
        if (!this.enabled) return;
        this.isRead = !!(IC32 & 2);
        this.dataSelect = !!(IC32 & 4);
        this.addressSelect = !!(portBpins & 0x80);
    }

    writeControl(portBpins, portApins, IC32) {
        const { dataSelect: oldDataSelect, addressSelect: oldAddressSelect } = this;
        this.followLines(portBpins, IC32);
        if (!this.enabled) return;
        if (oldAddressSelect && !this.addressSelect) this.cmosAddr = portApins & 0x3f;
        if (oldDataSelect && !this.dataSelect && !this.addressSelect && !this.isRead) {
            if (this.cmosAddr > 0xb) {
                this.refuseReplays();
                this.store[this.cmosAddr] = portApins;
                this.save();
            } else {
                switch (this.cmosAddr) {
                    case 0:
                    case 2:
                    case 4:
                        this.writeTime(this.cmosAddr, portApins);
                        break;
                    case 7:
                        this.writeCalendar("day", portApins);
                        break;
                    case 8:
                        this.writeCalendar("month", portApins);
                        break;
                    case 9:
                        this.writeCalendar("year", portApins);
                        break;
                }
            }
        }
    }
}
