"use strict";

export function Serial(acia) {
    var self = this;

    function reset() {
        self.reg = 0;
        self.transmitRate = 0;
        self.receiveRate = 0;
    }

    var table = [19200, 9600, 4800, 2400, 1200, 300, 150, 75];

    function write(addr, val) {
        val &= 0xff;
        self.reg = val;
        self.transmitRate = val & 0x07;
        self.receiveRate = (val >>> 3) & 0x07;
        acia.setSerialReceive(table[self.receiveRate]);
        acia.setMotor(!!(val & 0x80));
        acia.selectRs423(!!(val & 0x40));
    }

    function read() {
        write(0, 0xfe);
        return 0;
    }

    self.reset = reset;
    self.write = write;
    self.read = read;

    reset();
}
