"use strict";

export function Adc(sysvia, scheduler) {
    this.sysvia = sysvia;
    this.task = scheduler.newTask(this.onComplete.bind(this));
    this.status = 0x40;
    this.low = 0x00;
    this.high = 0x00;
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
    this.task.cancel();
    this.task.schedule(val & 0x08 ? 20000 : 8000);
    this.status = (val & 0x0f) | 0x80;
    this.sysvia.setcb1(true);
};

Adc.prototype.onComplete = function () {
    var val = 0x8000;

    var pads = this.sysvia.getGamepads();
    if (pads && pads[0]) {
        var pad = pads[0];
        var pad2 = pads[1];

        var rawValue = 0;

        var stick = Math.floor(this.status & 0x03);

        switch (stick) {
            default:
            case 0:
                rawValue = pad.axes[0];
                break;
            case 1:
                rawValue = pad.axes[1];
                break;
            case 2:
                if (pad2) {
                    rawValue = pad2.axes[0];
                } else {
                    rawValue = pad.axes[2];
                }
                break;
            case 3:
                if (pad2) {
                    rawValue = pad2.axes[1];
                } else {
                    rawValue = pad.axes[3];
                }
                break;
        }

        // scale from [1,-1] to [0,0xffff]
        val = Math.floor(((1 - rawValue) / 2) * 0xffff);
    }
    this.status = (this.status & 0x0f) | 0x40 | ((val >>> 10) & 0x03);
    this.low = val & 0xff;
    this.high = (val >>> 8) & 0xff;
    this.sysvia.setcb1(false);
};
