// The rate each 3-bit field selects, as OS 1.20's *FX7 and *FX8 table at &E9AE sets them.
const table = [19200, 1200, 4800, 150, 9600, 300, 2400, 75];

export class Serial {
    constructor(acia) {
        this.acia = acia;
        this.reset();
    }

    reset() {
        this.reg = 0;
        this.transmitRate = 0;
        this.receiveRate = 0;
    }

    write(addr, val) {
        val &= 0xff;
        this.reg = val;
        this.transmitRate = val & 0x07;
        this.receiveRate = (val >>> 3) & 0x07;
        this.acia.setSerialReceive(table[this.receiveRate]);
        this.acia.setSerialTransmit(table[this.transmitRate]);
        this.acia.setMotor(!!(val & 0x80));
        this.acia.selectRs423(!!(val & 0x40));
    }

    read() {
        this.write(0, 0xfe);
        return 0;
    }
}
