define([], function () {
    return function (persistence) {
        "use strict";
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
        var readWrite = false;
        var oldStrobe = false;
        var data = 0;
        var enabled = false;
        var cmosAddr = 0;

        function save() {
            if (persistence) {
                persistence.save(store);
            }
        }

        function cmosRead(IC32) {
            // b-em comment is: To drive bus, CMOS must be enabled, D must be high, RW must be high.
            if (enabled && (IC32 & 0x04) && readWrite) return data & 0xff;
            return 0xff;
        }

        function cmosWrite(IC32, sdbval) {
            readWrite = !!(IC32 & 2);
            var strobe = !!(IC32 & 4) ^ oldStrobe;
            oldStrobe = !!(IC32 & 4);
            if (strobe && enabled) {
                if (!readWrite && cmosAddr > 0xb && !(IC32 & 4)) {
                    // Write triggered on low to high D
                    store[cmosAddr] = sdbval;
                    save();
                }
                if (readWrite && (IC32 & 4)) {
                    // Read data output while D is high
                    data = store[cmosAddr] & 0xff;
                }
            }
        }

        function cmosWriteAddr(val, sdbval) {
            if (val & 0x80) cmosAddr = sdbval & 0x3f;
            enabled = !!(val & 0x40);
        }

        this.read = cmosRead;
        this.write = cmosWrite;
        this.writeAddr = cmosWriteAddr;
    };
});