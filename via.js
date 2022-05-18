"use strict";
import * as utils from "./utils.js";

const ORB = 0x0,
    ORA = 0x1,
    DDRB = 0x2,
    DDRA = 0x3,
    T1CL = 0x4,
    T1CH = 0x5,
    T1LL = 0x6,
    T1LH = 0x7,
    T2CL = 0x8,
    T2CH = 0x9,
    SR = 0xa,
    ACR = 0xb,
    PCR = 0xc,
    IFR = 0xd,
    IER = 0xe,
    ORAnh = 0xf,
    TIMER1INT = 0x40,
    TIMER2INT = 0x20,
    INT_CA1 = 0x02,
    INT_CA2 = 0x01,
    INT_CB1 = 0x10,
    INT_CB2 = 0x08;

function via(cpu, irq) {
    var self = {
        ora: 0,
        orb: 0,
        ira: 0,
        irb: 0,
        ddra: 0,
        ddrb: 0,
        sr: 0,
        t1l: 0,
        t2l: 0,
        t1c: 0,
        t2c: 0,
        acr: 0,
        pcr: 0,
        ifr: 0,
        ier: 0,
        t1hit: false,
        t2hit: false,
        portapins: 0,
        portbpins: 0,
        ca1: false,
        ca2: false,
        cb1: false,
        cb2: false,
        ca2changecallback: null,
        cb2changecallback: null,
        justhit: 0,
        t1_pb7: 0,

        reset: function () {
            // http://archive.6502.org/datasheets/mos_6522_preliminary_nov_1977.pdf
            // "Reset sets all registers to zero except t1 t2 and sr"
            self.ora = self.orb = 0x00;
            self.ddra = self.ddrb = 0x00;
            self.ifr = self.ier = 0x00;
            self.t1c = self.t1l = self.t2c = self.t2l = 0x1fffe;
            self.t1hit = self.t2hit = true;
            self.acr = self.pcr = 0;
            self.t1_pb7 = 1;
        },

        polltime: function (cycles) {
            cycles |= 0;
            self.justhit = 0;
            var newT1c = self.t1c - cycles;
            if (newT1c < -2 && self.t1c > -3) {
                if (!self.t1hit) {
                    self.ifr |= TIMER1INT;
                    self.updateIFR();
                    if (newT1c === -3) {
                        self.justhit |= 1;
                    }
                    self.t1_pb7 = !self.t1_pb7;
                }
                if (!(this.acr & 0x40)) self.t1hit = true;
            }
            while (newT1c < -3) newT1c += self.t1l + 4;
            self.t1c = newT1c;

            if (!(self.acr & 0x20)) {
                var newT2c = self.t2c - cycles;
                if (newT2c < -2) {
                    if (!self.t2hit) {
                        self.ifr |= TIMER2INT;
                        self.updateIFR();
                        if (newT2c === -3) {
                            self.justhit |= 2;
                        }
                        self.t2hit = true;
                    }
                    newT2c += 0x20000;
                }
                self.t2c = newT2c;
            }
        },

        updateIFR: function () {
            if (self.ifr & self.ier & 0x7f) {
                self.ifr |= 0x80;
                cpu.interrupt |= irq;
            } else {
                self.ifr &= ~0x80;
                cpu.interrupt &= ~irq;
            }
        },

        write: function (addr, val) {
            var mode;
            val |= 0;
            switch (addr & 0xf) {
                case ORA:
                    self.ifr &= ~INT_CA1;
                    if ((self.pcr & 0x0a) !== 0x02) {
                        // b-em: Not independent interrupt for CA2
                        self.ifr &= ~INT_CA2;
                    }
                    self.updateIFR();

                    mode = self.pcr & 0x0e;
                    if (mode === 8) {
                        // Handshake mode
                        self.setca2(false);
                    } else if (mode === 0x0a) {
                        // Pulse mode
                        self.setca2(false);
                        self.setca2(true);
                    }
                /* falls through */
                case ORAnh:
                    self.ora = val;
                    self.recalculatePortAPins();
                    break;

                case ORB:
                    self.ifr &= ~INT_CB1;
                    if ((self.pcr & 0xa0) !== 0x20) {
                        // b-em: Not independent interrupt for CB2
                        self.ifr &= ~INT_CB2;
                    }
                    self.updateIFR();

                    self.orb = val;
                    self.recalculatePortBPins();

                    mode = (self.pcr & 0xe0) >>> 4;
                    if (mode === 8) {
                        // Handshake mode
                        self.setcb2(false);
                    } else if (mode === 0x0a) {
                        // Pulse mode
                        self.setcb2(false);
                        self.setcb2(true);
                    }
                    break;

                case DDRA:
                    self.ddra = val;
                    self.recalculatePortAPins();
                    break;

                case DDRB:
                    self.ddrb = val;
                    self.recalculatePortBPins();
                    break;

                case ACR:
                    self.acr = val;
                    if (self.justhit & 1 && !(val & 0x40)) self.t1hit = true;
                    break;

                case PCR:
                    self.pcr = val;
                    if ((val & 0xe) === 0xc) self.setca2(false);
                    else if (val & 0x08) self.setca2(true);
                    if ((val & 0xe0) === 0xc0) self.setcb2(false);
                    else if (val & 0x80) self.setcb2(true);
                    break;

                case SR:
                    self.sr = val;
                    break;

                case T1LL:
                case T1CL:
                    self.t1l &= 0x1fe00;
                    self.t1l |= val << 1;
                    break;

                case T1LH:
                    self.t1l &= 0x1fe;
                    self.t1l |= val << 9;
                    if (!(self.justhit & 1)) {
                        self.ifr &= ~TIMER1INT;
                        self.updateIFR();
                    }
                    break;

                case T1CH:
                    self.t1l &= 0x1fe;
                    self.t1l |= val << 9;
                    self.t1c = self.t1l + 1;
                    self.t1hit = false;
                    if (!(self.justhit & 1)) {
                        self.ifr &= ~TIMER1INT;
                        self.updateIFR();
                    }
                    self.t1_pb7 = 0;
                    break;

                case T2CL:
                    self.t2l &= 0x1fe00;
                    self.t2l |= val << 1;
                    break;

                case T2CH:
                    self.t2l &= 0x1fe;
                    self.t2l |= val << 9;
                    self.t2c = self.t2l + 1;
                    if (self.acr & 0x20) self.t2c -= 2;
                    if (!(self.justhit & 2)) {
                        self.ifr &= ~TIMER2INT;
                        self.updateIFR();
                    }
                    self.t2hit = false;
                    break;

                case IER:
                    if (val & 0x80) self.ier |= val & 0x7f;
                    else self.ier &= ~(val & 0x7f);
                    self.updateIFR();
                    break;

                case IFR:
                    self.ifr &= ~(val & 0x7f);
                    if (self.justhit & 1) self.ifr |= TIMER1INT;
                    if (self.justhit & 2) self.ifr |= TIMER2INT;
                    self.updateIFR();
                    break;
            }
        },

        read: function (addr) {
            var temp;
            switch (addr & 0xf) {
                case ORA:
                    self.ifr &= ~INT_CA1;
                    if ((self.pcr & 0xa) !== 0x2) self.ifr &= ~INT_CA2;
                    self.updateIFR();
                /* falls through */
                case ORAnh:
                    // Reading ORA reads pin levels regardless of DDRA.
                    // Of the various 6522 datasheets, this one is clear:
                    // http://archive.6502.org/datasheets/wdc_w65c22s_mar_2004.pdf
                    if (self.acr & 1) {
                        return self.ira;
                    }
                    self.recalculatePortAPins();
                    return self.portapins;

                case ORB:
                    self.ifr &= ~INT_CB1;
                    if ((self.pcr & 0xa0) !== 0x20) self.ifr &= ~INT_CB2;
                    self.updateIFR();

                    self.recalculatePortBPins();
                    temp = self.orb & self.ddrb;
                    if (self.acr & 2) temp |= self.irb & ~self.ddrb;
                    else temp |= self.portbpins & ~self.ddrb;
                    // If PB7 is active, it is mixed in regardless of
                    // whether bit 7 is an input or output.
                    if (self.acr & 0x80) {
                        temp &= 0x7f;
                        temp |= self.t1_pb7 << 7;
                    }

                    var buttons = this.getJoysticks();

                    // clear PB4 and PB5
                    temp = temp & 0xcf; // 11001111

                    // AUG p418
                    // PB4 and PB5 inputs
                    // These are the inputs from the joystick FIRE buttons. They are
                    // normally at logic 1 with no button pressed and change to 0
                    // when a button is pressed
                    if (!buttons.button1) {
                        temp |= 1 << 4;
                    }
                    if (!buttons.button2) {
                        temp |= 1 << 5;
                    }

                    return temp;

                case DDRA:
                    return self.ddra;
                case DDRB:
                    return self.ddrb;
                case T1LL:
                    return ((self.t1l & 0x1fe) >>> 1) & 0xff;
                case T1LH:
                    return (self.t1l >>> 9) & 0xff;

                case T1CL:
                    if (!(self.justhit & 1)) {
                        self.ifr &= ~TIMER1INT;
                        self.updateIFR();
                    }
                    return ((self.t1c + 1) >>> 1) & 0xff;

                case T1CH:
                    return ((self.t1c + 1) >>> 9) & 0xff;

                case T2CL:
                    if (!(self.justhit & 2)) {
                        self.ifr &= ~TIMER2INT;
                        self.updateIFR();
                    }
                    return ((self.t2c + 1) >>> 1) & 0xff;

                case T2CH:
                    return ((self.t2c + 1) >>> 9) & 0xff;

                case SR:
                    return self.sr;
                case ACR:
                    return self.acr;
                case PCR:
                    return self.pcr;
                case IER:
                    return self.ier | 0x80;
                case IFR:
                    return self.ifr;
                default:
                    throw "Unknown VIA read";
            }
        },

        recalculatePortAPins: function () {
            self.portapins = self.ora & self.ddra;
            self.portapins |= ~self.ddra & 0xff;
            self.drivePortA();
            self.portAUpdated();
        },

        recalculatePortBPins: function () {
            self.portbpins = self.orb & self.ddrb;
            self.portbpins |= ~self.ddrb & 0xff;
            self.drivePortB();
            self.portBUpdated();
        },

        setca1: function (level) {
            if (level === self.ca1) return;
            var pcrSet = !!(self.pcr & 1);
            if (pcrSet === level) {
                if (self.acr & 1) self.ira = self.portapins;
                self.ifr |= INT_CA1;
                self.updateIFR();
                if ((self.pcr & 0xc) === 0x8) {
                    // handshaking
                    self.setca2(true);
                }
            }
            self.ca1 = level;
        },

        setca2: function (level) {
            if (level === self.ca2) return;
            self.ca2 = level;
            var output = !!(self.pcr & 0x08);
            if (self.ca2changecallback) self.ca2changecallback(level, output);
            if (output) return;
            var pcrSet = !!(self.pcr & 4);
            if (pcrSet === level) {
                self.ifr |= INT_CA2;
                self.updateIFR();
            }
        },

        setcb1: function (level) {
            if (level === self.cb1) return;
            var pcrSet = !!(self.pcr & 0x10);
            if (pcrSet === level) {
                if (self.acr & 2) self.irb = self.portbpins;
                self.ifr |= INT_CB1;
                self.updateIFR();
                if ((self.pcr & 0xc0) === 0x80) {
                    // handshaking
                    self.setcb2(true);
                }
            }
            self.cb1 = level;
        },

        setcb2: function (level) {
            if (level === self.cb2) return;
            self.cb2 = level;
            var output = !!(self.pcr & 0x80);
            if (self.cb2changecallback) self.cb2changecallback(level, output);
            if (output) return;
            var pcrSet = !!(self.pcr & 0x40);
            if (pcrSet === level) {
                self.ifr |= INT_CB2;
                self.updateIFR();
            }
        },
    };
    return self;
}

export function SysVia(cpu, video, soundChip, cmos, isMaster, initialLayout, getGamepads) {
    var self = via(cpu, 0x01);

    self.IC32 = 0;
    self.capsLockLight = false;
    self.shiftLockLight = false;
    self.keys = [];
    for (var i = 0; i < 16; ++i) {
        self.keys[i] = new Uint8Array(16);
    }

    self.setVBlankInt = self.setca1;

    self.setKeyLayout = function (map) {
        self.keycodeToRowCol = utils.getKeyMap(map);
    };
    self.setKeyLayout(initialLayout);

    self.keyboardEnabled = true;

    function clearKeys() {
        for (var i = 0; i < self.keys.length; ++i) {
            for (var j = 0; j < self.keys[i].length; ++j) {
                self.keys[i][j] = false;
            }
        }
        self.updateKeys();
    }

    self.clearKeys = clearKeys;

    self.disableKeyboard = function () {
        self.keyboardEnabled = false;
        clearKeys();
    };

    self.enableKeyboard = function () {
        self.keyboardEnabled = true;
        clearKeys();
    };

    self.set = function (key, val, shiftDown) {
        if (!self.keyboardEnabled) {
            return;
        }

        var colrow = self.keycodeToRowCol[!!shiftDown][key];
        if (!colrow) return;

        self.keys[colrow[0]][colrow[1]] = val;
        self.updateKeys();
    };
    self.keyDown = function (key, shiftDown) {
        self.set(key, 1, shiftDown);
    };
    self.keyUp = function (key) {
        // set up for both keymaps
        // (with and without shift)
        self.set(key, 0, true);
        self.set(key, 0, false);
    };

    self.keyDownRaw = function (colrow) {
        self.keys[colrow[0]][colrow[1]] = 1;
        self.updateKeys();
    };
    self.keyUpRaw = function (colrow) {
        self.keys[colrow[0]][colrow[1]] = 0;
        self.updateKeys();
    };
    self.keyToggleRaw = function (colrow) {
        self.keys[colrow[0]][colrow[1]] = 1 - self.keys[colrow[0]][colrow[1]];
        self.updateKeys();
    };
    self.hasAnyKeyDown = function () {
        // 10 for BBC, 13 for Master 128
        var numCols = 13;
        var i, j;
        for (i = 0; i < numCols; ++i) {
            for (j = 0; j < 8; ++j) {
                if (self.keys[i][j]) {
                    return true;
                }
            }
        }
        return false;
    };

    self.updateKeys = function () {
        // 10 for BBC, 13 for Master 128
        var numCols = 13;
        var i, j;
        if (self.IC32 & 8) {
            for (i = 0; i < numCols; ++i) {
                for (j = 1; j < 8; ++j) {
                    if (self.keys[i][j]) {
                        self.setca2(true);
                        return;
                    }
                }
            }
        } else {
            // Keyboard sets bit 7 to 0 or 1, and testing shows it always
            // "wins" vs. CMOS.
            // At 0 also wins against an output pin.

            var portapins = self.portapins;
            var keyrow = (portapins >>> 4) & 7;
            var keycol = portapins & 0xf;
            if (!self.keys[keycol][keyrow]) {
                self.portapins &= 0x7f;
            } else if (!(self.ddra & 0x80)) {
                self.portapins |= 0x80;
            }

            if (keycol < numCols) {
                for (j = 1; j < 8; ++j) {
                    if (self.keys[keycol][j]) {
                        self.setca2(true);
                        return;
                    }
                }
            }
        }
        self.setca2(false);
    };

    self.portAUpdated = function () {
        self.updateKeys();
        soundChip.updateSlowDataBus(self.portapins, !(self.IC32 & 1));
    };

    self.portBUpdated = function () {
        var portbpins = self.portbpins;
        if (portbpins & 8) self.IC32 |= 1 << (portbpins & 7);
        else self.IC32 &= ~(1 << (portbpins & 7));

        self.capsLockLight = !(self.IC32 & 0x40);
        self.shiftLockLight = !(self.IC32 & 0x80);

        video.setScreenAdd((self.IC32 & 16 ? 2 : 0) | (self.IC32 & 32 ? 1 : 0));

        if (isMaster) cmos.writeControl(portbpins, self.portapins, self.IC32);

        // Updating IC32 may have enabled peripherals attached to port A.
        self.recalculatePortAPins();
    };

    self.drivePortA = function () {
        // For experiments where we tested these behaviors, see:
        // https://stardot.org.uk/forums/viewtopic.php?f=4&t=17597
        // If either keyboard or CMOS pulls a given pin low, it "wins"
        // vs. via output.
        var busval = 0xff;
        if (isMaster) busval &= cmos.read(self.IC32);
        self.portapins &= busval;
        self.updateKeys();
    };

    self.drivePortB = function () {
        // Nothing driving here.
        // Note that if speech were fitted, it drives bit 7 low.
    };

    self.getGamepads = function () {
        if (getGamepads) return getGamepads();
        return null;
    };

    self.getJoysticks = function () {
        var button1 = false;
        var button2 = false;

        var pads = self.getGamepads();
        if (pads && pads[0]) {
            var pad = pads[0];
            var pad2 = pads[1];

            button1 = pad.buttons[10].pressed;
            // if two gamepads, use button from 2nd
            // otherwise use 2nd button from first
            button2 = pad2 ? pad2.buttons[10].pressed : pad.buttons[11].pressed;
        }

        return { button1: button1, button2: button2 };
    };

    self.reset();
    return self;
}

export function UserVia(cpu, isMaster, userPortPeripheral) {
    var self = via(cpu, 0x02);

    // nothing connected to user VIA
    self.getJoysticks = function () {
        return { button1: false, button2: false };
    };

    self.portAUpdated = function () {
        // Printer port.
    };

    self.portBUpdated = function () {
        userPortPeripheral.write(self.portbpins);
    };

    self.drivePortA = function () {
        // Printer port.
    };

    self.drivePortB = function () {
        self.portbpins &= userPortPeripheral.read();
    };

    self.reset();
    return self;
}
