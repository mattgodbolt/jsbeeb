"use strict";

const defaultCmos = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfe, 0x00, 0xeb, 0x00,
    0xc9, 0xff, 0xff, 0x12, 0x00, 0x17, 0xca, 0x1e, 0x05, 0x00, 0x35, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

let timeOffset = 0;

function getBbcDateTime() {
    const result = new Date(Date.now() + timeOffset);
    result.setMilliseconds(0);
    return result;
}

function toBcd(value) {
    return parseInt(value.toString(10), 16);
}

function fromBcd(value) {
    return parseInt(value.toString(16), 10);
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

        if (!this.store) {
            this.store = defaultCmos;
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
                const current = getBbcDateTime();
                switch (this.cmosAddr) {
                    case 0:
                        return toBcd(current.getSeconds());
                    case 2:
                        return toBcd(current.getMinutes());
                    case 4:
                        return toBcd(current.getHours());
                    case 6:
                        return toBcd(current.getDay() + 1);
                    case 7:
                        return toBcd(current.getDate());
                    case 8:
                        return toBcd(current.getMonth() + 1);
                    case 9:
                        return toBcd(current.getFullYear());
                }
            } else {
                return this.store[this.cmosAddr] & 0xff;
            }
        }
        return 0xff;
    }

    writeControl(portBpins, portApins, IC32) {
        this.enabled = !!(portBpins & 0x40);
        if (!this.enabled) return;
        const oldDataSelect = this.dataSelect;
        const oldAddressSelect = this.addressSelect;
        this.isRead = !!(IC32 & 2);
        this.dataSelect = !!(IC32 & 4);
        this.addressSelect = !!(portBpins & 0x80);
        if (oldAddressSelect && !this.addressSelect) this.cmosAddr = portApins & 0x3f;
        if (oldDataSelect && !this.dataSelect && !this.addressSelect && !this.isRead) {
            if (this.cmosAddr > 0xb) {
                this.store[this.cmosAddr] = portApins;
                this.save();
            } else {
                const bbcTime = getBbcDateTime();
                switch (this.cmosAddr) {
                    case 0:
                        bbcTime.setSeconds(fromBcd(portApins));
                        break;
                    case 2:
                        bbcTime.setMinutes(fromBcd(portApins));
                        break;
                    case 4:
                        bbcTime.setHours(fromBcd(portApins));
                        break;
                    // I tried some day offset stuff to lazily simulate the fact the day is separate
                    // from the date, but I couldn't easily get it to work during the multi-write update
                    // cycle/ I'm probably being dumb. Or else I should emulate the clock "properly" but
                    // that seems like an awful lot of work.
                    // case 6:
                    //     dayOffset = (bbcTime.getDay() - fromBcd(portApins - 1)) % 7;
                    //     break;
                    case 7:
                        bbcTime.setDate(fromBcd(portApins));
                        break;
                    case 8:
                        bbcTime.setMonth(fromBcd(portApins - 1));
                        break;
                    case 9: {
                        const yearBase = fromBcd(portApins) > 80 ? 1900 : 2000;
                        bbcTime.setFullYear(fromBcd(portApins) + yearBase);
                        break;
                    }
                }
                const secondsNow = Math.floor(Date.now() / 1000) * 1000;
                timeOffset = bbcTime.getTime() - secondsNow;
            }
        }
    }
}
