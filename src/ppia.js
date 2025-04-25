"use strict";
import * as utils_atom from "./utils_atom.js";

const PORTA = 0x0,
    PORTB = 0x1,
    PORTC = 0x2,
    CREG = 0x3; // control register

/*
 http://mdfs.net/Docs/Comp/Acorn/Atom/atap25.htm

 25.5 Input/Output Port Allocations
 The 8255 Programmable Peripheral Interface Adapter contains three 8-bit ports, and all but one of these lines is used by the ATOM.

 Port A - #B000
        Output bits:      Function:
             0 - 3      Keyboard row
             4 - 7      Graphics mode

 Port B - #B001
        Input bits:       Function:
             0 - 5      Keyboard column
               6        CTRL key (low when pressed)
               7        SHIFT keys {low when pressed)

 Port C - #B002
        Output bits:      Function:
             0          Tape output
             1          Enable 2.4 kHz to cassette output
             2          Loudspeaker
             3          Not used (Colour Set Select)

        Input bits:       Function:
             4          2.4 kHz input
             5          Cassette input
             6          REPT key (low when pressed)
             7          60 Hz sync signal (low during flyback)
 The port C output lines, bits 0 to 3, may be used for user applications when the cassette interface is not being used.


Hardware:   PPIA 8255

output  b000    0 - 3 keyboard row, 4 - 7 graphics mode
 b002    0 cas output, 1 enable 2.4kHz, 2 buzzer, 3 colour set

input   b001    0 - 5 keyboard column, 6 CTRL key, 7 SHIFT key
 b002    4 2.4kHz input, 5 cas input, 6 REPT key, 7 60 Hz input



            // http://mdfs.net/Docs/Comp/Acorn/Atom/MemoryMap

            B000    PPIA I/O Device
                  &B000 b7-b4: 6847 video mode
                  &B000 b3-b0: keyboard matix row, defaults to 0 so &B001 reads
                          Escape. Setting &B000 to 10 (or anything larger than 9)
                          "disables" background escape checking.

                  &B001 - keyboard matrix column:
                       ~b0 : SPC  [   \   ]   ^  LCK <-> ^-v Lft Rgt
                       ~b1 : Dwn Up  CLR ENT CPY DEL  0   1   2   3
                       ~b2 :  4   5   6   7   8   9   :   ;   <   =
                       ~b3 :  >   ?   @   A   B   C   D   E   F   G
                       ~b4 :  H   I   J   K   L   M   N   O   P   Q
                       ~b5 :  R   S   T   U   V   W   X   Y   Z  ESC
                       ~b6 :                                          Ctrl
                       ~b7 :                                          Shift
                              9   8   7   6   5   4   3   2   1   0

                  &B002 - various I/O
                       ~b0 -> CASOUT
                       ~b1 -> CASOUT
                       ~b2 -> Speaker
                       ~b3 -> VDU CSS
                       ~b4 <- CAS
                       ~b5 <- CASIN
                       ~b6 <- REPEAT key
                       ~b7 <- VSync



             */

class PPIA {
    constructor(cpu) {
        this.cpu = cpu;

        this.latcha = 0;
        this.latchb = 0;
        this.latchc = 0;
        this.portapins = 0;
        this.portbpins = 0;
        this.portcpins = 0;
        this.cr = 0;
        this.processor = cpu;
        this.speaker = 0;
        this.prevcas = 0;
    }

    reset() {
        //http://members.casema.nl/hhaydn/8255_pin.html
        this.latcha = this.latchb = this.latchc = 0x00;
    }

    setVBlankInt(level) {
        // level == 1 when in the vsync
        // FE66_wait_for_flyback_start will loop until bit 7 (copied into N register using BIT)
        // of B002 is not 0 (i.e until BPL fails when bit 7 is 1)
        // then
        // FE6B_wait_for_flyback will loop until bit 7 of B002 is (copied into N register using BIT)
        // of B002 is not 1 (i.e until BMI fails when bit 7 is 0)

        //60 Hz sync signal - normally 1 during the frame, but goes 0 at start of flyback (at the end of a frame).
        //opposite of the 'level'
        if (!level) {
            // set bit 7 to 1 - in frame
            this.latchc |= 0x80;
        } else {
            // set bit 7 to 0 - in vsync
            this.latchc &= ~0x80;
        }
        this.recalculatePortCPins();
    }

    // polltime(cycles) {
    //     cycles |= 0;

    // }
    /*
 Port C - #B002
        Output bits:      Function:
             0          Tape output
             1          Enable 2.4 kHz to cassette output
             2          Loudspeaker
             3          Not used

        Input bits:       Function:
             4          2.4 kHz input
             5          Cassette input
             6          REPT key (low when pressed)
             7          60 Hz sync signal (low during flyback)
 The port C output lines, bits 0 to 3, may be used for user applications when the cassette interface is not being used.

 */
    write(addr, val) {
        val |= 0;
        switch (addr & 0xf) {
            case PORTA:
                this.latcha = val;
                // console.log("write porta "+this.latcha);
                this.recalculatePortAPins();
                break;

            case PORTB:
                // cannot write to port B
                console.log("cannot write portb " + val);
                // this.recalculatePortBPins();
                break;

            case PORTC:
                //11110000 - 0xF0
                //00001111 - 0x0F -- only write to the bottom 4 bits
                this.latchc = (this.portcpins & 0xf0) | (val & 0x0f);

                // if (this.portcpins & 0x01) {
                //     console.log("casout");
                // }
                // if (this.portcpins & 0x02) {
                //     console.log("hzout");
                // }
                // if ((this.portcpins & 0x04) !== (this.latchc & 0x04)) {
                // console.log(cpu.currentCycles+" PORTC Speaker "+ (this.latchc & 0x04));
                // speaker = val & 4;
                // portc pins - not separate variable

                // }
                // if ((this.portcpins & 0x08) !== (this.latchc & 0x08)) {
                // console.log(cpu.currentCycles+" PORTC CSS "+ (this.latchc & 0x08));
                // css = (val & 8) >> 2;
                // portc pins - not separate variable
                // }

                //     console.log("spk "+(this.portcpins & 0x04)+ " at " + this.processor.cycleSeconds + "seconds, " + this.processor.currentCycles + "cycles } ");

                // console.log("write portc "+this.latchc);
                this.recalculatePortCPins();
                break;
            case CREG:
                // bit 7 is 0 for Bit Set/Reset (BSR) mode of PPIA
                // using the CREG to quickly activate B2,B1,B0 of port C
                // bit 0 is the set/reset value
                var speaker = 0;
                var css = 0;
                switch (val & 0xe) {
                    case 0x4: //0xxx010v is port C pin 2 set to v
                        speaker = (val & 1) << 2;
                        // console.log(cpu.currentCycles+" CREG Speaker "+ (val & 1));
                        break;

                    case 0x6: //0xxx011v is port C pin 3 set to v
                        css = (val & 1) << 3;

                        // console.log(cpu.currentCycles+" CREG CSS "+ (val & 1));
                        break;
                }
                // NOT STRICTLY CORRECT - SHOULD BE ABLE TO FORCE CPINS SET/RESET
                // this is just forcing them rather than latching anything
                // console.log(cpu.currentCycles+" CREG  "+ (val ));
                this.portcpins = (this.portcpins & 0xf0) | css | speaker;
                this.portCUpdated();
                break;
        }
    }

    read(addr) {
        switch (addr & 0xf) {
            case PORTA:
                this.recalculatePortAPins();
                // console.log("read porta "+this.portapins);
                return this.portapins;
            case PORTB:
                this.recalculatePortBPins();
                // return the keys based on values in porta
                // console.log("read portb "+this.portbpins);
                // expecting 1 means unpressed, 0 means pressed: but keymap has 1 if pressed and 0 if unpressed
                var keyrow = this.portapins & 0x0f;
                var n = this.keys[keyrow];
                var r = 0xff; // all keys unpressed
                for (var b = 0; b <= 9; b++) r &= ~(n[b] << b);

                // if (this.portapins & 15 == 9)
                //     console.log("reading "+(this.portapins & 15)+" and pressed "+n.toString(2)+" -> "+r.toString(2));

                // for CTRL and SHIFT which doesn't use porta - they just set bit 6 and bit 7
                // the keymap assumes CTRL and SHIFT read from row0
                // fixup CTRL and SHIFT regardless of the row being read
                var ctrl_shift = (this.keys[0][7] << 7) | (this.keys[0][6] << 6);
                r &= ~(ctrl_shift & 0xc0);

                return r;
            case PORTC:
                this.recalculatePortCPins();
                // console.log("read portc "+this.portcpins);
                // only read top 4 bits
                // if (this.portcpins & 0x20)
                //     console.log("casin");

                // pump in the HZIN value - should be ???
                this.portcpins = (this.portcpins & 0xef) | (1 << 4);

                // if (this.portcpins & 0x10) {
                //     console.log(this.processor.cycleSeconds+"."+(this.processor.currentCycles/1000)+" : hzin");
                // }
                // if (this.portcpins & 0x80) {
                //     console.log(this.processor.cycleSeconds+"."+(this.processor.currentCycles/1000)+" : vsync");
                // }

                // only read top 4 bits
                var val = this.portcpins & 0xf0;

                // var flyback = this.portcpins & 0x80;
                // var rept = this.portcpins & 0x40;  // low when pressed
                var casin = this.portcpins & 0x20; //
                // var hzin = this.portcpins & 0x10;

                var casbit = casin ? 1 : 0;

                // make sure REPT key bit is HIGH (low means pressed)
                var rept_key = (!this.keys[1][6] << 6) & 0x40;
                val |= rept_key;

                // include speaker and css values
                val |= 0x0f; // initially high
                if (!(this.portcpins & 0x04))
                    // speaker
                    val &= ~4;
                if (!(this.portcpins & 0x08))
                    // css
                    val &= ~8;

                // TAPE - 0xfc0a  (every 3.340ms/3340us), -OSBGET Get Byte from Tape subroutine; get a bit and count duration of tape pulse (using FCD2)
                // TAPE - 0xfcd2  (every 0.033ms/3.3us), -Test state of #B002 tape input pulse subroutine (has there been a change?)
                // TAPE - 0xFCC2 (every 8.446ms/8446us), -Count Duration of Tape Pulse subroutine (<8 loops, >=8 loops)
                // FLYBACK - 0xfe6e, 0XFE9D, 0xfe69,
                var myPC = this.processor.pc;
                if (![0xfe6e, 0xfe9d, 0xfe69, 0xfcd2].includes(myPC)) {
                    var clocksPerSecond = (1 * 1000 * 1000) | 0;
                    var millis =
                        this.processor.cycleSeconds * 1000 + this.processor.currentCycles / (clocksPerSecond / 1000);
                    // var tt = millis - this.lastTime;
                    this.lastTime = millis;

                    // for fc0a - it is called every 3.34ms and in this time it should change from 0 to 1 either
                    // 8 or 16 times (which the ASM compares against 12)

                    // this is called once every 33 clock cycles from FCCF
                    // there are 6 calls this between every change
                    // of a bit due to 'receiveBit'.

                    // if([0xfc0a,0xFCC2].includes(myPC) )
                    // {
                    //     console.log("." + myPC.toString(16) + " ppia_read " + ((val&0x20)>>5) + " at " + this.processor.cycleSeconds + "seconds, " + this.processor.currentCycles + "cycles ("+tt+") } ");
                    // }
                    // else
                    // {
                    //     console.log("#" + this.processor.pc.toString(16) + " ppia_read " + val.toString(2).padStart(8, '0') + " at " + this.processor.cycleSeconds + "seconds, " + this.processor.currentCycles + "cycles ("+tt+") } ");
                    // }

                    if (casbit !== this.prevcas) {
                        //                            var t = millis - this.lasttime;
                        //                            this.lasttime = millis;
                        this.prevcas = casbit;
                        // console.log("#" + this.processor.pc.toString(16) + " ppia_read casin switched to " + this.prevcas + " } ");
                    }

                    // console.log("} "+(flyback?"F":"_")+(rept?"_":"R")+(casin?"1":"0")+(hzin?"h":"_"));
                    //                        console.log("} "+val.toString(2).padStart(10,'0'));
                }
                return val;
            default:
                throw "Unknown PPIA read";
        }
    }

    recalculatePortAPins() {
        this.portapins = this.latcha;
        this.drivePortA();
        this.portAUpdated();
    }

    recalculatePortBPins() {
        this.portbpins = this.latchb;
        this.drivePortB();
        this.portBUpdated();
    }

    recalculatePortCPins() {
        this.portcpins = this.latchc;
        this.drivePortC();
        this.portCUpdated();
    }
}

export class AtomPPIA extends PPIA {
    constructor(cpu, initialLayout, scheduler) {
        super(cpu);

        this.keys = [];
        for (var i = 0; i < 16; ++i) {
            this.keys[i] = new Uint8Array(16);
        }

        this.setKeyLayoutAtom(initialLayout);

        this.keyboardEnabled = true;

        this.reset();

        this.lastTime = 0;

        this.runTapeTask = scheduler.newTask(this.runTape);
    }

    setKeyLayoutAtom(map) {
        this.keycodeToRowCol = utils_atom.getKeyMapAtom(map);
    }

    clearKeys() {
        for (var i = 0; i < this.keys.length; ++i) {
            for (var j = 0; j < this.keys[i].length; ++j) {
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
        if (!this.keyboardEnabled) {
            return;
        }

        var colrow = this.keycodeToRowCol[!!shiftDown][key];
        if (!colrow) {
            console.log("Unknown code or key: " + key);

            console.log(
                "Please check here: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.code or https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.key",
            );
            return;
        }

        // console.log(" keycode: " + colrow[0] +","+colrow[1]+":"+val);
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
        // 10 for ATOM
        var numCols = 10;
        var i, j;
        for (i = 0; i < numCols; ++i) {
            for (j = 0; j < 8; ++j) {
                if (this.keys[i][j]) {
                    return true;
                }
            }
        }
        return false;
    }

    updateKeys() {}

    polltime(cycles) {
        this.cpu.soundChip.updateSpeaker(
            !!this.speaker,
            this.processor.currentCycles,
            this.processor.cycleSeconds,
            cycles,
        );
    }

    portAUpdated() {
        this.updateKeys();
    }

    portBUpdated() {}

    portCUpdated() {
        this.speaker = (this.portcpins & 0x04) >>> 2;
    }

    drivePortA() {
        this.updateKeys();
    }

    drivePortB() {
        // Nothing driving here.
    }

    drivePortC() {
        // Nothing driving here.
    }

    // ATOM TAPE SUPPORT

    // set by TAPE
    tone(freq) {
        if (!freq) this.cpu.soundChip.toneGenerator.mute();
        else this.cpu.soundChip.toneGenerator.tone(freq);
    }

    // set by TAPE
    setTapeCarrier(level) {
        if (!level) {
            this.tapeCarrierCount = 0;
            this.tapeDcdLineLevel = false;
        } else {
            this.tapeCarrierCount++;
            // The tape hardware doesn't raise DCD until the carrier tone
            // has persisted for a while. The BBC service manual opines,
            // "The DCD flag in the 6850 should change 0.1 to 0.4 seconds
            // after a continuous tone appears".
            // Star Drifter doesn't load without this.
            // We use 0.174s, measured on an issue 3 model B.
            // Testing on real hardware, DCD is blipped, it lowers about
            // 210us after it raises, even though the carrier tone
            // may be continuing.
            if (this.tapeCarrierCount === 209) {
                this.tapeDcdLineLevel = true;
            } else {
                this.tapeDcdLineLevel = false;
            }
        }
        this.dcdLineUpdated();
    }
    dcdLineUpdated() {}

    // receive is set by the TAPE POLL
    receiveBit(bit) {
        // var clocksPerSecond = (1 * 1000 * 1000) | 0;
        // var millis = this.processor.cycleSeconds * 1000 + this.processor.currentCycles / (clocksPerSecond / 1000);

        //           var t = millis - this.lasttime;
        //           this.lasttime = millis;
        bit |= 0;
        // var casin = (this.portcpins & 0x20)>>5; //

        this.latchc = (this.portcpins & 0xdf) | (bit << 5);

        // this is called once every 208 clock cycles (208us or 0.2ms at 1Mhz)

        /*
            for this to be recognised as a '1'; it needs to be 4 cycles at 1.2khz (or is this '0') - duration of tape pulse < 8
            for this to be recognised as a '0'; it needs to be 8 cycles at 2.4khz (or is this '1')
             leader tone is a '1' - so reading 8 half cycles at 2.4khz

             */

        // console.log("#  receiveBit " + this.latchc.toString(2).padStart(8, '0') + " at " + this.processor.cycleSeconds + "seconds, " + this.processor.currentCycles + "cycles } ");

        // if (casin != bit) {
        //     // var flyback = this.latchc & 0x80;
        //     // var rept = this.latchc & 0x40;  // low when pressed
        //     casin = this.latchc & 0x20; //
        //     var hzin = this.latchc & 0x10;
        //     console.log("> " + millis.toFixed(1) + " portcpins " + (casin | hzin).toString(2).padStart(10, '0'));
        // }
    }

    receive(/*_byte*/) {
        // _byte |= 0;
        // if (this.sr & 0x01) {
        //     // Overrun.
        //     // TODO: this doesn't match the datasheet:
        //     // "The Overrun does not occur in the Status Register until the
        //     // valid character prior to Overrun has been read."
        //     console.log("Serial overrun");
        //     this.sr |= 0xa0;
        // } else {
        //     this.dr = byte;
        //     this.sr |= 0x81;
        // }

        // console.log("]- 0x" + _byte.toString(16).padStart(2, "0") + " : " + String.fromCharCode(_byte));
        this.updateIrq();
    }

    setTape(tape) {
        this.tape = tape;
    }

    // this.counterTimer = null;
    // this.tape_counter = 0;

    rewindTape() {
        if (this.tape) {
            console.log("rewinding tape");
            this.tape.rewind();
            // this.tape_counter = 0;
            // var display_div = $("#counter_id");
            // var display_str = "";
            // display_str = this.tape_counter.toString().padStart(8,'0');
            // display_div.empty();
            // for (var i = 0; i < display_str.length; i++) {
            //     display_div.append("<span class='cas counter num_tiles'>"+display_str[i]+"</span>");
            // }
        }
    }

    // this.incrementCount = function(d_div) {
    //     this.counterTimer = setInterval(function(){
    //         // clear count
    //         d_div.empty();

    // this.tape_counter++;
    // if (this.tape_counter > 100000) {
    //     this.tape_counter = 0; // reset count
    // }
    // var display_str = "";
    // display_str = this.tape_counter.toString().padStart(8,'0');
    // for (var i = 0; i < display_str.length; i++) {
    //     d_div.append("<span class='cas counter num_tiles'>"+display_str[i]+"</span>");
    // }
    // },1000);
    // };

    playTape() {
        if (this.tape) {
            console.log("playing tape");
            //start
            this.runTape();

            // var display_div = $("#counter_id");

            // example of a counter.
            // this.incrementCount(display_div);
        }
    }

    stopTape() {
        if (this.tape) {
            console.log("stopping tape");

            this.cpu.soundChip.toneGenerator.mute();
            this.runTapeTask.cancel();
            this.setTapeCarrier(false);

            // clearInterval(this.counterTimer);
            // this.counterTimer = null;
        }
    }

    runTape() {
        if (this.tape) this.runTapeTask.reschedule(this.tape.poll(self));
    }

    updateIrq() {}
}

/*
pia 8255 - 0x3fc mirror : device read/write
6522 - 0x3f0 mirror

int m_hz2400;
int m_pc0;
int m_pc1;




 */
