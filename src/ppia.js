import { getKeyMapAtom } from "./utils_atom.js";

// 8255 Programmable Peripheral Interface Adapter for the Acorn Atom.
// Reference: http://mdfs.net/Docs/Comp/Acorn/Atom/atap25.htm
// Memory map: http://mdfs.net/Docs/Comp/Acorn/Atom/MemoryMap
//
// Port A - 0xB000 (output)
//   bits 0-3: Keyboard row select
//   bits 4-7: MC6847 graphics mode
//
// Port B - 0xB001 (input)
//   bits 0-5: Keyboard column (active low)
//   bit 6:    CTRL key (low when pressed)
//   bit 7:    SHIFT key (low when pressed)
//
// Port C - 0xB002 (mixed I/O)
//   Output bits:
//     0: Tape output
//     1: Enable 2.4 kHz to cassette output
//     2: Loudspeaker
//     3: Colour Set Select (CSS)
//   Input bits:
//     4: 2.4 kHz input
//     5: Cassette input
//     6: REPT key (low when pressed)
//     7: 60 Hz VSync signal (low during flyback)
//
// Keyboard matrix (active low, active when key pressed):
//   Port A row →    9   8   7   6   5   4   3   2   1   0
//   Port B col ↓
//        ~b0 :     SPC  [   \   ]   ^  LCK <-> ^-v Lft Rgt
//        ~b1 :     Dwn Up  CLR ENT CPY DEL  0   1   2   3
//        ~b2 :      4   5   6   7   8   9   :   ;   <   =
//        ~b3 :      >   ?   @   A   B   C   D   E   F   G
//        ~b4 :      H   I   J   K   L   M   N   O   P   Q
//        ~b5 :      R   S   T   U   V   W   X   Y   Z  ESC
//        ~b6 :                                          Ctrl
//        ~b7 :                                          Shift

const PORTA = 0x0,
    PORTB = 0x1,
    PORTC = 0x2,
    CREG = 0x3; // control register

class PPIA {
    constructor(cpu) {
        this.cpu = cpu;

        this.latcha = 0;
        this.latchb = 0;
        this.latchc = 0;
        this.portapins = 0;
        this.portbpins = 0;
        this.portcpins = 0;
        this.creg = 0;
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
                this.recalculatePortAPins();
                break;

            case PORTB:
                // cannot write to port B
                console.warn("PPIA: cannot write to port B");
                break;

            case PORTC:
                this.latchc = (this.portcpins & 0xf0) | (val & 0x0f);

                this.recalculatePortCPins();
                break;
            case CREG: {
                this.creg = val & 0xff;
                // Bit Set/Reset (BSR) mode: quickly set/clear individual port C bits.
                // NOTE: Not strictly correct — the 8255 BSR mode should set/reset a
                // single bit via read-modify-write. This simplified version only handles
                // bits 2 (speaker) and 3 (CSS), and rebuilds the lower nibble from
                // scratch, which will zero the other output bit. Works in practice
                // because the Atom ROM only BSR-toggles one bit at a time.
                let speaker = 0;
                let css = 0;
                switch (val & 0xe) {
                    case 0x4: // port C pin 2 (speaker)
                        speaker = (val & 1) << 2;
                        break;
                    case 0x6: // port C pin 3 (CSS)
                        css = (val & 1) << 3;
                        break;
                }
                this.portcpins = (this.portcpins & 0xf0) | css | speaker;
                this.portCUpdated();
                break;
            }
        }
    }

    read(addr) {
        switch (addr & 0xf) {
            case PORTA:
                this.recalculatePortAPins();
                return this.portapins;
            case PORTB: {
                this.recalculatePortBPins();
                const keyrow = this.portapins & 0x0f;
                const n = this.keys[keyrow];
                let r = 0xff; // all keys unpressed
                for (let b = 0; b <= 9; b++) r &= ~(n[b] << b);
                // CTRL and SHIFT are always readable regardless of row selection
                const ctrl_shift = (this.keys[0][7] << 7) | (this.keys[0][6] << 6);
                r &= ~(ctrl_shift & 0xc0);
                return r;
            }
            case PORTC: {
                this.recalculatePortCPins();

                // Force HZIN (bit 4) high
                this.portcpins = (this.portcpins & 0xef) | (1 << 4);

                // Read top 4 bits (input), merge with bottom 4 (output)
                let val = this.portcpins & 0xf0;

                const casin = this.portcpins & 0x20;
                const casbit = casin ? 1 : 0;

                // REPT key: bit 6 is LOW when pressed
                const rept_key = (!this.keys[1][6] << 6) & 0x40;
                val |= rept_key;

                // Include speaker (bit 2) and CSS (bit 3) output values
                val |= 0x0f;
                if (!(this.portcpins & 0x04)) val &= ~4; // speaker
                if (!(this.portcpins & 0x08)) val &= ~8; // CSS

                // Track cassette input transitions. The Atom ROM tape routines:
                //   0xfc0a - OSBGET: get byte from tape (every 3.34ms)
                //   0xfcd2 - test tape input pulse (every 0.033ms / 33 cycles)
                //   0xfcc2 - count duration of tape pulse (<8 loops = '1', >=8 = '0')
                //   0xfe6e, 0xfe9d, 0xfe69 - flyback/VSync routines
                // Between each receiveBit, fcd2 is called ~6 times (33 cycles each).
                const myPC = this.cpu.pc;
                if (![0xfe6e, 0xfe9d, 0xfe69, 0xfcd2].includes(myPC)) {
                    const clocksPerSecond = (1 * 1000 * 1000) | 0;
                    const millis = this.cpu.cycleSeconds * 1000 + this.cpu.currentCycles / (clocksPerSecond / 1000);
                    this.lastTime = millis;

                    if (casbit !== this.prevcas) {
                        this.prevcas = casbit;
                    }
                }
                return val;
            }
            default:
                throw new Error(`Unknown PPIA read address: 0x${(addr & 0xf).toString(16)}`);
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

// On the atom, the PPIA does the keyboard, speaker and tape.
// On the BBC, sysVIA does the keyboard and pokes the soundchip
// and the ACIA does the tape
export class AtomPPIA extends PPIA {
    constructor(cpu, initialLayout, scheduler) {
        super(cpu);

        this.keys = [];
        for (let i = 0; i < 16; ++i) {
            this.keys[i] = new Uint8Array(16);
        }

        this.setKeyLayoutAtom(initialLayout);

        this.keyboardEnabled = true;

        this.reset();

        this.lastTime = 0;

        // from ACIA
        this.runTapeTask = scheduler.newTask(() => this.runTape());
    }

    // from SysVIA
    setKeyLayoutAtom(map) {
        this.keycodeToRowCol = getKeyMapAtom(map);
    }

    // from SysVIA
    clearKeys() {
        for (let i = 0; i < this.keys.length; ++i) {
            for (let j = 0; j < this.keys[i].length; ++j) {
                this.keys[i][j] = 0;
            }
        }
        this.updateKeys();
    }

    // from SysVIA
    disableKeyboard() {
        this.keyboardEnabled = false;
        this.clearKeys();
    }

    // from SysVIA
    enableKeyboard() {
        this.keyboardEnabled = true;
        this.clearKeys();
    }

    // from SysVIA
    set(key, val, shiftDown) {
        if (!this.keyboardEnabled) return;
        const colrow = this.keycodeToRowCol[!!shiftDown][key];
        if (!colrow) {
            console.warn(`PPIA: unmapped key code: ${key}`);
            return;
        }

        this.keys[colrow[0]][colrow[1]] = val;
        this.updateKeys();
    }

    // from SysVIA
    keyDown(key, shiftDown) {
        this.set(key, 1, shiftDown);
    }

    // from SysVIA
    keyUp(key) {
        // set up for both keymaps
        // (with and without shift)
        this.set(key, 0, true);
        this.set(key, 0, false);
    }

    // from SysVIA
    keyDownRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 1;
        this.updateKeys();
    }

    // from SysVIA
    keyUpRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 0;
        this.updateKeys();
    }

    // from SysVIA
    keyToggleRaw(colrow) {
        this.keys[colrow[0]][colrow[1]] = 1 - this.keys[colrow[0]][colrow[1]];
        this.updateKeys();
    }

    // from SysVIA
    hasAnyKeyDown() {
        // 10 for ATOM
        const numCols = 10;

        for (let i = 0; i < numCols; ++i) {
            for (let j = 0; j < 8; ++j) {
                if (this.keys[i][j]) {
                    return true;
                }
            }
        }
        return false;
    }

    // nothing on ATOM
    updateKeys() {}

    // nothing on ATOM
    polltime() {}

    portAUpdated() {
        this.updateKeys();
    }

    // nothing on ATOM
    portBUpdated() {}

    portCUpdated() {
        this.cpu.soundChip.speakerGenerator.pushBit(
            (this.portcpins & 0x04) >>> 2,
            this.cpu.currentCycles,
            this.cpu.cycleSeconds,
        );
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
    // from ACIA on BBC

    // set by TAPE
    tone(freq) {
        let toneGen = this.cpu.soundChip.toneGenerator;
        if (!freq) toneGen.mute();
        else toneGen.tone(freq);
    }

    // nothing on ATOM
    dcdLineUpdated() {}

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
            this.tapeDcdLineLevel = this.tapeCarrierCount === 209;
        }
        this.dcdLineUpdated();
    }

    // Receive bits from tape (called by tape.poll via PPIA, not ACIA like BBC).
    // Called once every ~208 clock cycles (208us at 1 MHz).
    // Recognition: '1' = 4 half-cycles at 1.2 kHz (duration < 8),
    //              '0' = 8 half-cycles at 2.4 kHz (duration >= 8).
    // Leader tone is a stream of '1' bits.
    receiveBit(bit) {
        bit |= 0;
        this.latchc = (this.portcpins & 0xdf) | (bit << 5);
    }

    // nothing on ATOM
    receive(/*_byte*/) {}

    setTape(tape) {
        this.tape = tape;
    }

    rewindTape() {
        if (this.tape) {
            this.tape.rewind();
        }
    }

    playTape() {
        if (this.tape) {
            //start
            this.runTape();
        }
    }

    stopTape() {
        if (this.tape) {
            let toneGen = this.cpu.soundChip.toneGenerator;
            toneGen.mute();
            this.runTapeTask.cancel();
            this.setTapeCarrier(false);
        }
    }

    runTape() {
        if (this.tape) this.runTapeTask.reschedule(this.tape.poll(this));
    }

    updateIrq() {}
}
