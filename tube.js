"use strict";
import * as utils from "./utils.js";

export function Tube(hostCpu, parasiteCpu) {
    this.hostCpu = hostCpu;
    this.parasiteCpu = parasiteCpu;
    this.ph1 = new Uint8Array(24);
    this.ph2 = 0;
    this.ph3 = new Uint8Array(2);
    this.ph4 = 0;
    this.hp1 = 0;
    this.hp2 = 0;
    this.hp3 = new Uint8Array(2);
    this.hp4 = 0;
    this.hstat = new Uint8Array(4);
    this.pstat = new Uint8Array(4);
    this.r1stat = 0;
    this.ph1pos = 0;
    this.ph3pos = 0;
    this.hp3pos = 0;
    this.debug = false;
}

Tube.prototype.updateInterrupts = function () {
    // Host interrupt
    this.hostCpu.interrupt &= ~8;
    if (this.r1stat & 0x01 && this.hstat[3] & 0x80) this.hostCpu.interrupt |= 8;

    // Parasite interrupts
    this.parasiteCpu.interrupt = !!(
        (this.r1stat & 0x02 && this.pstat[0] & 0x80) ||
        (this.r1stat & 0x04 && this.pstat[3] & 0x80)
    );

    var hp3Size = this.r1stat & 0x10 ? 1 : 0;
    this.parasiteCpu.nmi = !!(this.r1stat & 0x08 && (this.hp3pos > hp3Size || this.ph3pos === 0));
};

Tube.prototype.reset = function () {
    this.ph1pos = this.hp3pos = 0;
    this.ph3pos = 1;
    this.r1stat = 0;
    this.hstat[0] = this.hstat[1] = this.hstat[3] = 0x40;
    this.hstat[2] = 0xc0;
    this.pstat[0] = this.pstat[1] = this.pstat[2] = this.pstat[3] = 0x40;
};

Tube.prototype.hostRead = function (addr) {
    var result = 0xfe;
    switch (addr & 7) {
        case 0:
            result = (this.hstat[0] & 0xc0) | this.r1stat;
            break;
        case 1:
            result = this.ph1[0];
            for (var i = 0; i < 23; ++i) this.ph1[i] = this.ph1[i + 1];
            this.pstat[0] |= 0x40;
            if (!--this.ph1pos) {
                this.hstat[0] &= ~0x80;
            }
            break;
        case 2:
            result = this.hstat[1];
            break;
        case 3:
            result = this.ph2;
            if (this.hstat[1] & 0x80) {
                this.hstat[1] &= ~0x80;
                this.pstat[1] |= 0x40;
            }
            break;
        case 4:
            result = this.hstat[2];
            break;
        case 5:
            result = this.ph3[0];
            if (this.ph3pos > 0) {
                this.ph3[0] = this.ph3[1];
                this.pstat[2] |= 0xc0;
                if (!--this.ph3pos) this.hstat[2] &= ~0x80;
            }
            break;
        case 6:
            result = this.hstat[3];
            break;
        case 7:
            result = this.ph4;
            if (this.hstat[3] & 0x80) {
                this.hstat[3] &= ~0x80;
                this.pstat[3] |= 0x40;
            }
            break;
    }
    this.updateInterrupts();
    if (this.debug) console.log("host read " + utils.hexword(addr) + " = " + utils.hexbyte(result));
    return result;
};

Tube.prototype.hostWrite = function (addr, b) {
    if (this.debug) console.log("host write " + utils.hexword(addr) + " = " + utils.hexbyte(b));
    switch (addr & 7) {
        case 0:
            if (b & 0x80) this.r1stat |= b & 0x3f;
            else this.r1stat &= ~(b & 0x3f);
            this.hstat[0] = (this.hstat[0] & 0xc0) | (b & 0x3f);
            break;
        case 1:
            this.hp1 = b;
            this.pstat[0] |= 0x80;
            this.hstat[0] &= ~0x40;
            break;
        case 3:
            this.hp2 = b;
            this.pstat[1] |= 0x80;
            this.hstat[1] &= ~0x40;
            break;
        case 5:
            if (this.r1stat & 0x10) {
                if (this.hp3pos < 2) this.hp3[this.hp3pos++] = b;
                if (this.hp3pos === 2) {
                    this.pstat[2] |= 0x80;
                    this.hstat[2] &= ~0x40;
                }
            } else {
                this.hp3[0] = b;
                this.hp3pos = 1;
                this.pstat[2] |= 0x80;
                this.hstat[2] &= ~0x40;
            }
            break;
        case 7:
            this.hp4 = b;
            this.pstat[3] |= 0x80;
            this.hstat[3] &= ~0x40;
            break;
    }
    this.updateInterrupts();
};

Tube.prototype.parasiteRead = function (addr) {
    var result = 0;
    switch (addr & 7) {
        case 0: // Stat
            result = this.pstat[0] | this.r1stat;
            break;
        case 1:
            result = this.hp1;
            if (this.pstat[0] & 0x80) {
                this.pstat[0] &= ~0x80;
                this.hstat[0] |= 0x40;
            }
            break;
        case 2:
            result = this.pstat[1];
            break;
        case 3:
            result = this.hp2;
            if (this.pstat[1] & 0x80) {
                this.pstat[1] &= ~0x80;
                this.hstat[1] |= 0x40;
            }
            break;
        case 4:
            result = this.pstat[2];
            break;
        case 5:
            result = this.hp3[0];
            if (this.hp3pos > 0) {
                this.hp3[0] = this.hp3[1];
                if (!--this.hp3pos) {
                    this.pstat[2] &= ~0x80;
                    this.hstat[2] |= 0x40;
                }
            }
            break;
        case 6:
            result = this.pstat[3];
            break;
        case 7:
            result = this.hp4;
            if (this.pstat[3] & 0x80) {
                this.pstat[3] &= ~0x80;
                this.hstat[3] |= 0x40;
            }
            break;
    }
    this.updateInterrupts();
    if (this.debug) console.log("parasite read " + utils.hexword(addr) + " = " + utils.hexbyte(result));
    return result;
};

Tube.prototype.parasiteWrite = function (addr, b) {
    if (this.debug) console.log("parasite write " + utils.hexword(addr) + " = " + utils.hexbyte(b));
    switch (addr & 7) {
        case 1:
            if (this.ph1pos < 24) {
                this.ph1[this.ph1pos++] = b;
                this.hstat[0] |= 0x80;
                if (this.ph1pos === 24) this.pstat[0] &= ~0x40;
            }
            break;
        case 3:
            this.ph2 = b;
            this.hstat[1] |= 0x80;
            this.pstat[1] &= ~0x40;
            break;
        case 5:
            if (this.r1stat & 0x10) {
                if (this.ph3pos < 2) this.ph3[this.ph3pos++] = b;
                if (this.ph3pos === 2) {
                    this.hstat[2] |= 0x80;
                    this.pstat[2] &= ~0x40;
                }
            } else {
                this.ph3[0] = b;
                this.ph3pos = 1;
                this.hstat[2] |= 0x80;
                this.pstat[2] &= ~0xc0;
            }
            break;
        case 7:
            this.ph4 = b;
            this.hstat[3] |= 0x80;
            this.pstat[3] &= ~0x40;
            break;
    }
    this.updateInterrupts();
};
