"use strict";

const defaultCmos = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc9, 0xff, 0xff, 0x12, 0x00, 0x17, 0xca, 0x1e, 0x05, 0x00, 0x35, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

export class Cmos {
    constructor(persistence) {
        this.store = persistence ? persistence.load() : null;
        this.persistence = persistence;
        this.enabled = false;
        this.isRead = false;
        this.addressSelect = false;
        this.dataSelect = false;
        this.cmosAddr = 0;

        if (!this.store) {
            this.store = defaultCmos;
            this.save();
        }
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
                const current = new Date();
                switch (this.cmosAddr) {
                    // Note values are returned in BCD format
                    case 0:
                        return parseInt(current.getSeconds().toString(10), 16);
                    case 2:
                        return parseInt(current.getMinutes().toString(10), 16);
                    case 4:
                        return parseInt(current.getHours().toString(10), 16);
                    case 6:
                        return parseInt((current.getDay() + 1).toString(10), 16);
                    case 7:
                        return parseInt(current.getDate().toString(10), 16);
                    case 8:
                        return parseInt((current.getMonth() + 1).toString(10), 16);
                    case 9:
                        return parseInt(current.getFullYear().toString(10), 16);
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
        if (oldDataSelect && !this.dataSelect && !this.addressSelect && !this.isRead && this.cmosAddr > 0xb) {
            this.store[this.cmosAddr] = portApins;
            this.save();
        }
    }
}
