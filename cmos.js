define([], function () {
    "use strict";
    return function (persistence) {
        var store = null;
        if (persistence) {
            store = persistence.load();
        }
        if (!store) {
            store = [
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0xc9, 0xff, 0xff, 0x12, 0x00, 0x17, 0xca, 0x1e, 0x05, 0x00, 0x35, 0xa6, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
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

        function cmosRead(IC32) {
            if (!enabled) return 0xff;
            // To drive the bus we need:
            // - CMOS enabled.
            // - Address Select low.
            // - Data Select high.
            // - Read high.
            if (!addressSelect && dataSelect && isRead) return store[cmosAddr] & 0xff;
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
    };
});
