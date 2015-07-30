define([], function () {
    "use strict";
    function Adc(sysvia) {
        this.sysvia = sysvia;
        this.status = 0x40;
        this.low = 0x00;
        this.high = 0x00;
        this.time = 0;
    }

    Adc.prototype.read = function (addr) {
        switch (addr & 3) {
            case 0:
                return this.status;
            case 1:
                return this.high;
            case 2:
                return this.low;
            default:
                break;
        }
        return 0x40;
    };
    Adc.prototype.write = function (addr, val) {
        if ((addr & 3) !== 0) return;
        // 8 bit conversion takes 4ms whereas 10 bit conversions take 10ms, according to AUG
        this.time = this.status = (val & 0x08) ? 20000 : 8000;
        this.status = (val & 0x0f) | 0x80;
        this.sysvia.setcb1(true);
    };
    Adc.prototype.polltime = function (cycles) {
        if (!this.time) return;
        this.time -= cycles;
        if (this.time > 0) return;
        this.time = 0;
        var val = 0x0000;
        // TODO: switch on bottom two bits of adc_status and pick a value corresponding
        // to the appropriate axis.
        this.status = (this.status & 0x0f) | 0x40 | ((val >> 10) & 0x03);
        this.low = val & 0xff;
        this.high = (val >>> 8) & 0xff;
        this.sysvia.setcb1(false);
    };
    return Adc;
});