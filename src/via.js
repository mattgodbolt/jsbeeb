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

class Via {
    constructor(cpu, scheduler, irq) {
        this.cpu = cpu;
        this.irq = irq;
        this.scheduler = scheduler;

        this.ora = 0;
        this.orb = 0;
        this.ira = 0;
        this.irb = 0;
        this.ddra = 0;
        this.ddrb = 0;
        this.sr = 0;
        this.t1l = 0;
        this.t2l = 0;
        this.t1c = 0;
        this.t2c = 0;
        this.acr = 0;
        this.pcr = 0;
        this.ifr = 0;
        this.ier = 0;
        this.t1hit = false;
        this.t2hit = false;
        this.portapins = 0;
        this.portbpins = 0;
        this.ca1 = false;
        this.ca2 = false;
        this.cb1 = false;
        this.cb2 = false;
        this.ca2changecallback = null;
        this.cb2changecallback = null;
        this.justhit = 0;
        this.t1_pb7 = 0;

        this.task = this.scheduler.newTask(() => this._onTimeout());
        this.lastPolltime = 0;
    }

    reset() {
        // http://archive.6502.org/datasheets/mos_6522_preliminary_nov_1977.pdf
        // "Reset sets all registers to zero except t1 t2 and sr"
        this.ora = this.orb = 0x00;
        this.ddra = this.ddrb = 0x00;
        this.ifr = this.ier = 0x00;
        this.t1c = this.t1l = this.t2c = this.t2l = 0x1fffe;
        this.t1hit = this.t2hit = true;
        this.acr = this.pcr = 0;
        this.t1_pb7 = 1;
        this.updateNextTime();
    }

    updateNextTime() {
        let nextTimer = this.t1c;
        if (!(this.acr & 0x20)) nextTimer = Math.min(this.t2c, nextTimer);
        this.task.reschedule(Math.max(1, nextTimer));
    }

    _onTimeout() {
        this._catchUp();
    }

    _catchUp() {
        const cycles = this.scheduler.epoch - this.lastPolltime;
        if (cycles) this._polltime(cycles);
        this.lastPolltime = this.scheduler.epoch;
        this.updateNextTime();
    }

    _polltime(cycles) {
        cycles |= 0;
        this.justhit = 0;
        const newT1c = this.t1c - cycles;
        if (newT1c < -2) this.t1c = this._handleT1c(newT1c);
        else this.t1c = newT1c;

        if (!(this.acr & 0x20)) {
            const newT2c = this.t2c - cycles;
            if (newT2c < -2) this.t2c = this._handleT2c(newT2c);
            else this.t2c = newT2c;
        }
    }

    _handleT1c(newT1c) {
        if (newT1c < -2 && this.t1c > -3) {
            if (!this.t1hit) {
                this.ifr |= TIMER1INT;
                this.updateIFR();
                if (newT1c === -3) this.justhit |= 1;
                this.t1_pb7 = !this.t1_pb7;
            }
            if (!(this.acr & 0x40)) this.t1hit = true;
        }
        while (newT1c < -3) newT1c += this.t1l + 4;
        return newT1c;
    }

    _handleT2c(newT2c) {
        if (!this.t2hit) {
            this.ifr |= TIMER2INT;
            this.updateIFR();
            if (newT2c === -3) this.justhit |= 2;
            this.t2hit = true;
        }
        newT2c += 0x20000;
        return newT2c;
    }

    updateIFR() {
        if (this.ifr & this.ier & 0x7f) {
            this.ifr |= 0x80;
            this.cpu.interrupt |= this.irq;
        } else {
            this.ifr &= ~0x80;
            this.cpu.interrupt &= ~this.irq;
        }
    }

    write(addr, val) {
        this._catchUp();
        let mode;
        val |= 0;
        switch (addr & 0xf) {
            case ORA:
                this.ifr &= ~INT_CA1;
                if ((this.pcr & 0x0a) !== 0x02) {
                    // b-em: Not independent interrupt for CA2
                    this.ifr &= ~INT_CA2;
                }
                this.updateIFR();

                mode = this.pcr & 0x0e;
                if (mode === 8) {
                    // Handshake mode
                    this.setca2(false);
                } else if (mode === 0x0a) {
                    // Pulse mode
                    this.setca2(false);
                    this.setca2(true);
                }
            /* falls through */
            case ORAnh:
                this.ora = val;
                this.recalculatePortAPins();
                break;

            case ORB:
                this.ifr &= ~INT_CB1;
                if ((this.pcr & 0xa0) !== 0x20) {
                    // b-em: Not independent interrupt for CB2
                    this.ifr &= ~INT_CB2;
                }
                this.updateIFR();

                this.orb = val;
                this.recalculatePortBPins();

                mode = (this.pcr & 0xe0) >>> 4;
                if (mode === 8) {
                    // Handshake mode
                    this.setcb2(false);
                } else if (mode === 0x0a) {
                    // Pulse mode
                    this.setcb2(false);
                    this.setcb2(true);
                }
                break;

            case DDRA:
                this.ddra = val;
                this.recalculatePortAPins();
                break;

            case DDRB:
                this.ddrb = val;
                this.recalculatePortBPins();
                break;

            case ACR:
                this.acr = val;
                if (this.justhit & 1 && !(val & 0x40)) this.t1hit = true;
                break;

            case PCR:
                this.pcr = val;
                if ((val & 0xe) === 0xc) this.setca2(false);
                else if (val & 0x08) this.setca2(true);
                if ((val & 0xe0) === 0xc0) this.setcb2(false);
                else if (val & 0x80) this.setcb2(true);
                break;

            case SR:
                this.sr = val;
                break;

            case T1LL:
            case T1CL:
                this.t1l &= 0x1fe00;
                this.t1l |= val << 1;
                break;

            case T1LH:
                this.t1l &= 0x1fe;
                this.t1l |= val << 9;
                if (!(this.justhit & 1)) {
                    this.ifr &= ~TIMER1INT;
                    this.updateIFR();
                }
                break;

            case T1CH:
                this.t1l &= 0x1fe;
                this.t1l |= val << 9;
                this.t1c = this.t1l + 1;
                this.t1hit = false;
                if (!(this.justhit & 1)) {
                    this.ifr &= ~TIMER1INT;
                    this.updateIFR();
                }
                this.t1_pb7 = 0;
                this.updateNextTime();
                break;

            case T2CL:
                this.t2l &= 0x1fe00;
                this.t2l |= val << 1;
                break;

            case T2CH:
                this.t2l &= 0x1fe;
                this.t2l |= val << 9;
                this.t2c = this.t2l + 1;
                if (this.acr & 0x20) this.t2c -= 2;
                if (!(this.justhit & 2)) {
                    this.ifr &= ~TIMER2INT;
                    this.updateIFR();
                }
                this.t2hit = false;
                this.updateNextTime();
                break;

            case IER:
                if (val & 0x80) this.ier |= val & 0x7f;
                else this.ier &= ~(val & 0x7f);
                this.updateIFR();
                break;

            case IFR:
                this.ifr &= ~(val & 0x7f);
                if (this.justhit & 1) this.ifr |= TIMER1INT;
                if (this.justhit & 2) this.ifr |= TIMER2INT;
                this.updateIFR();
                break;
        }
    }

    read(addr) {
        this._catchUp();
        switch (addr & 0xf) {
            case ORA:
                this.ifr &= ~INT_CA1;
                if ((this.pcr & 0xa) !== 0x2) this.ifr &= ~INT_CA2;
                this.updateIFR();
            /* falls through */
            case ORAnh:
                // Reading ORA reads pin levels regardless of DDRA.
                // Of the various 6522 datasheets, this one is clear:
                // http://archive.6502.org/datasheets/wdc_w65c22s_mar_2004.pdf
                if (this.acr & 1) {
                    return this.ira;
                }
                this.recalculatePortAPins();
                return this.portapins;

            case ORB: {
                this.ifr &= ~INT_CB1;
                if ((this.pcr & 0xa0) !== 0x20) this.ifr &= ~INT_CB2;
                this.updateIFR();

                this.recalculatePortBPins();
                let temp = this.orb & this.ddrb;
                if (this.acr & 2) temp |= this.irb & ~this.ddrb;
                else temp |= this.portbpins & ~this.ddrb;
                // If PB7 is active, it is mixed in regardless of
                // whether bit 7 is an input or output.
                if (this.acr & 0x80) {
                    temp &= 0x7f;
                    temp |= this.t1_pb7 << 7;
                }

                return temp;
            }
            case DDRA:
                return this.ddra;
            case DDRB:
                return this.ddrb;
            case T1LL:
                return ((this.t1l & 0x1fe) >>> 1) & 0xff;
            case T1LH:
                return (this.t1l >>> 9) & 0xff;

            case T1CL:
                if (!(this.justhit & 1)) {
                    this.ifr &= ~TIMER1INT;
                    this.updateIFR();
                }
                return ((this.t1c + 1) >>> 1) & 0xff;

            case T1CH:
                return ((this.t1c + 1) >>> 9) & 0xff;

            case T2CL:
                if (!(this.justhit & 2)) {
                    this.ifr &= ~TIMER2INT;
                    this.updateIFR();
                }
                return ((this.t2c + 1) >>> 1) & 0xff;

            case T2CH:
                return ((this.t2c + 1) >>> 9) & 0xff;

            case SR:
                return this.sr;
            case ACR:
                return this.acr;
            case PCR:
                return this.pcr;
            case IER:
                return this.ier | 0x80;
            case IFR:
                return this.ifr;
            default:
                throw "Unknown VIA read";
        }
    }

    // May be overridden in subclasses
    drivePortA() {}

    portAUpdated() {}

    drivePortB() {}

    portBUpdated() {}

    rawPortB() {
        return 0xff;
    }

    recalculatePortAPins() {
        this.portapins = this.ora & this.ddra;
        this.portapins |= ~this.ddra & 0xff;
        this.drivePortA();
        this.portAUpdated();
    }

    recalculatePortBPins() {
        const prevPb6 = !!(this.portbpins & 0x40);
        this.portbpins = (this.orb & this.ddrb) | (~this.ddrb & this.rawPortB());

        this.drivePortB();
        if (prevPb6 && !(this.portbpins & 0x40)) {
            // If we see a high to low transition on pb6, and we are in timer2 pulse counting mode, count a pulse.
            if (this.acr & 0x20) {
                this.t2c -= 2;
                // Not clear what happens here. Docs say:
                // "When the T2 counter reaches a count of zero, IFR5 is set and the counter continues to decrement with
                // each pulse on PB6. To enable IFR5 for subsequent countdowns, it is necessary to reload high order T2
                // counter."
                if (this.t2c < 0) {
                    this.t2c = 0xffff;
                    this.ifr |= TIMER2INT;
                    this.updateIFR();
                }
            }
        }
        this.portBUpdated();
    }

    setca1(level) {
        if (level === this.ca1) return;
        const pcrSet = !!(this.pcr & 1);
        if (pcrSet === level) {
            if (this.acr & 1) this.ira = this.portapins;
            this.ifr |= INT_CA1;
            this.updateIFR();
            if ((this.pcr & 0xc) === 0x8) {
                // handshaking
                this.setca2(true);
            }
        }
        this.ca1 = level;
    }

    setca2(level) {
        if (level === this.ca2) return;
        this.ca2 = level;
        const output = !!(this.pcr & 0x08);
        if (this.ca2changecallback) this.ca2changecallback(level, output);
        if (output) return;
        const pcrSet = !!(this.pcr & 4);
        if (pcrSet === level) {
            this.ifr |= INT_CA2;
            this.updateIFR();
        }
    }

    setcb1(level) {
        if (level === this.cb1) return;
        const pcrSet = !!(this.pcr & 0x10);
        if (pcrSet === level) {
            if (this.acr & 2) this.irb = this.portbpins;
            this.ifr |= INT_CB1;
            this.updateIFR();
            if ((this.pcr & 0xc0) === 0x80) {
                // handshaking
                this.setcb2(true);
            }
        }
        this.cb1 = level;
    }

    setcb2(level) {
        if (level === this.cb2) return;
        this.cb2 = level;
        const output = !!(this.pcr & 0x80);
        if (this.cb2changecallback) this.cb2changecallback(level, output);
        if (output) return;
        const pcrSet = !!(this.pcr & 0x40);
        if (pcrSet === level) {
            this.ifr |= INT_CB2;
            this.updateIFR();
        }
    }
}

export class SysVia extends Via {
    constructor(cpu, scheduler, video, soundChip, cmos, isMaster, initialLayout, getGamepads) {
        super(cpu, scheduler, 0x01);

        this.IC32 = 0;
        this.capsLockLight = false;
        this.shiftLockLight = false;
        this.keys = [];
        for (let i = 0; i < 16; ++i) {
            this.keys[i] = new Uint8Array(16);
        }
        // Mouse joystick button state
        this.mouseButton1 = false;
        this.mouseButton2 = false;
        this.keyboardEnabled = true;
        this.setKeyLayout(initialLayout);
        this.video = video;
        this.soundChip = soundChip;
        this.cmos = cmos;
        this.isMaster = isMaster;
        this.getGamepadsFunc = getGamepads;

        this.reset();
    }

    setKeyLayout(map) {
        this.keycodeToRowCol = utils.getKeyMap(map);
    }

    setVBlankInt(level) {
        this.setca1(level);
    }

    clearKeys() {
        for (let i = 0; i < this.keys.length; ++i) {
            for (let j = 0; j < this.keys[i].length; ++j) {
                this.keys[i][j] = false;
            }
        }
        this.updateKeys();
    }

    disableKeyboard() {
        this.keyboardEnabled = false;
        this.clearKeys();
    }

    enableKeyboard() {
        this.keyboardEnabled = true;
        this.clearKeys();
    }

    set(key, val, shiftDown) {
        if (!this.keyboardEnabled) return;
        const colrow = this.keycodeToRowCol[!!shiftDown][key];
        if (!colrow) return;
        this.keys[colrow[0]][colrow[1]] = val;
        this.updateKeys();
    }

    keyDown(key, shiftDown) {
        this.set(key, 1, shiftDown);
    }

    keyUp(key) {
        // set up for both keymaps
        // (with and without shift)
        this.set(key, 0, true);
        this.set(key, 0, false);
    }

    keyDownRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 1;
        this.updateKeys();
    }

    keyUpRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 0;
        this.updateKeys();
    }

    keyToggleRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 1 - this.keys[colrow[0]][colrow[1]];
        this.updateKeys();
    }

    hasAnyKeyDown() {
        // 10 for BBC, 13 for Master 128
        const numCols = 13;
        for (let i = 0; i < numCols; ++i) {
            for (let j = 0; j < 8; ++j) {
                if (this.keys[i][j]) {
                    return true;
                }
            }
        }
        return false;
    }

    updateKeys() {
        // 10 for BBC, 13 for Master 128
        const numCols = 13;
        if (this.IC32 & 8) {
            for (let i = 0; i < numCols; ++i) {
                for (let j = 1; j < 8; ++j) {
                    if (this.keys[i][j]) {
                        this.setca2(true);
                        return;
                    }
                }
            }
        } else {
            // Keyboard sets bit 7 to 0 or 1, and testing shows it always
            // "wins" vs. CMOS.
            // At 0 also wins against an output pin.

            const portapins = this.portapins;
            const keyrow = (portapins >>> 4) & 7;
            const keycol = portapins & 0xf;
            if (!this.keys[keycol][keyrow]) {
                this.portapins &= 0x7f;
            } else if (!(this.ddra & 0x80)) {
                this.portapins |= 0x80;
            }

            if (keycol < numCols) {
                for (let j = 1; j < 8; ++j) {
                    if (this.keys[keycol][j]) {
                        this.setca2(true);
                        return;
                    }
                }
            }
        }
        this.setca2(false);
    }

    portAUpdated() {
        this.updateKeys();
        this.soundChip.updateSlowDataBus(this.portapins, !(this.IC32 & 1));
    }

    rawPortB() {
        let result = 0xff;
        // AUG p418
        // ### PB4 and PB5 inputs
        // These are the inputs from the joystick FIRE buttons. They are active low.
        const buttons = this.getJoysticks();
        if (buttons.button1) result &= ~(1 << 4); // Clear PB4 if button1 pressed
        if (buttons.button2) result &= ~(1 << 5); // Clear PB5 if button2 pressed
        return result;
    }

    portBUpdated() {
        const portbpins = this.portbpins;
        if (portbpins & 8) this.IC32 |= 1 << (portbpins & 7);
        else this.IC32 &= ~(1 << (portbpins & 7));

        this.capsLockLight = !(this.IC32 & 0x40);
        this.shiftLockLight = !(this.IC32 & 0x80);

        this.video.setScreenAdd((this.IC32 & 16 ? 2 : 0) | (this.IC32 & 32 ? 1 : 0));

        if (this.isMaster) this.cmos.writeControl(portbpins, this.portapins, this.IC32);

        // Updating IC32 may have enabled peripherals attached to port A.
        this.recalculatePortAPins();
    }

    drivePortA() {
        // For experiments where we tested these behaviors, see:
        // https://stardot.org.uk/forums/viewtopic.php?f=4&t=17597
        // If either keyboard or CMOS pulls a given pin low, it "wins"
        // vs. via output.
        let busval = 0xff;
        if (this.isMaster) busval &= this.cmos.read(this.IC32);
        this.portapins &= busval;
        this.updateKeys();
    }

    drivePortB() {
        // Nothing driving here.
        // Note that if speech were fitted, it drives bit 7 low.
    }

    getGamepads() {
        if (this.getGamepadsFunc) return this.getGamepadsFunc();
        return null;
    }

    /**
     * Set joystick button state (for mouse joystick)
     * @param {number} buttonNumber - Button number (0 for button1, 1 for button2)
     * @param {boolean} pressed - Whether the button is pressed
     */
    setJoystickButton(buttonNumber, pressed) {
        if (buttonNumber === 0) {
            this.mouseButton1 = pressed;
        } else if (buttonNumber === 1) {
            this.mouseButton2 = pressed;
        }
        // Trigger port B recalculation to update button state
        this.recalculatePortBPins();
    }

    getJoysticks() {
        let button1 = this.mouseButton1; // Start with mouse button state
        let button2 = this.mouseButton2;

        const pads = this.getGamepads();
        if (pads && pads[0]) {
            const pad = pads[0];
            const pad2 = pads[1];

            // Combine gamepad and mouse button states (OR logic)
            button1 = button1 || pad.buttons[10].pressed;
            // if two gamepads, use button from 2nd
            // otherwise use 2nd button from first
            button2 = button2 || (pad2 ? pad2.buttons[10].pressed : pad.buttons[11].pressed);
        }

        return { button1: button1, button2: button2 };
    }
}

export class UserVia extends Via {
    constructor(cpu, scheduler, isMaster, userPortPeripheral) {
        super(cpu, scheduler, 0x02);
        this.isMaster = isMaster;
        this.userPortPeripheral = userPortPeripheral;
        this.reset();
    }

    portBUpdated() {
        this.userPortPeripheral.write(this.portbpins);
    }

    drivePortB() {
        this.portbpins &= this.userPortPeripheral.read();
    }
}
