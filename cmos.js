"use strict";

export function Cmos(persistence) {
    var store = null;
    if (persistence) {
        store = persistence.load();
    }
    if (!store) {
        store = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0xc9, 0xff, 0xff, 0x12, 0x00, 0x17, 0xca, 0x1e, 0x05, 0x00, 0x35, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        save();
    }
    var enabled = false;
    var isRead = false;
    var addressSelect = false;
    var dataSelect = false;
    var cmosAddr = 0;

    function save() {
        if (persistence) {
            persistence.save(store);
        }
    }

    function cmosRead() {
        if (!enabled) return 0xff;
        // To drive the bus we need:
        // - CMOS enabled.
        // - Address Select low.
        // - Data Select high.
        // - Read high.

        if (!addressSelect && dataSelect && isRead) {
            // The first 10 bytes of CMOS RAM store the RTC clock
            if (cmosAddr < 10) {
                var current = new Date();
                switch (cmosAddr) {
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
                return store[cmosAddr] & 0xff;
            }
        }
        return 0xff;
    }

    function cmosWriteControl(portbpins, portapins, IC32) {
        enabled = !!(portbpins & 0x40);
        if (!enabled) return;
        var oldDataSelect = dataSelect;
        var oldAddressSelect = addressSelect;
        isRead = !!(IC32 & 2);
        dataSelect = !!(IC32 & 4);
        addressSelect = !!(portbpins & 0x80);
        if (oldAddressSelect && !addressSelect) cmosAddr = portapins & 0x3f;
        if (oldDataSelect && !dataSelect && !addressSelect && !isRead && cmosAddr > 0xb) {
            store[cmosAddr] = portapins;
            save();
        }
    }

    this.read = cmosRead;
    this.writeControl = cmosWriteControl;
}
