"use strict";
// Some info:
// http://www.playvectrex.com/designit/lecture/UP12.HTM
// https://books.google.com/books?id=wUecAQAAQBAJ&pg=PA431&lpg=PA431&dq=acia+tdre&source=bl&ots=mp-yF-mK-P&sig=e6aXkFRfiIOb57WZmrvdIGsCooI&hl=en&sa=X&ei=0g2fVdDyFIXT-QG8-JD4BA&ved=0CCwQ6AEwAw#v=onepage&q=acia%20tdre&f=false
// http://www.classiccmp.org/dunfield/r/6850.pdf

export class Acia {
    constructor(cpu, toneGen, scheduler, rs423Handler) {
        this.cpu = cpu;
        this.toneGen = toneGen;
        this.rs423Handler = rs423Handler;

        this.sr = 0x00;
        this.cr = 0x00;
        this.dr = 0x00;

        this.rs423Selected = false;
        this.motorOn = false;
        this.tapeCarrierCount = 0;
        this.tapeDcdLineLevel = false;
        this.hadDcdHigh = false;
        this.serialReceiveRate = 0;
        this.serialReceiveCyclesPerByte = 0;

        this.setSerialReceive(19200);
        this.txCompleteTask = scheduler.newTask(() => {
            this.sr |= 0x02; // set the TDRE
        });
        this.runTapeTask = scheduler.newTask(() => this.runTape());
        this.runRs423Task = scheduler.newTask(() => this.runRs423());
    }

    updateIrq() {
        if (this.sr & this.cr & 0x80) {
            this.cpu.interrupt |= 0x04;
        } else {
            this.cpu.interrupt &= ~0x04;
        }
    }

    reset() {
        // TODO: testing on a real beeb seems to suggest that reset also
        // clears CR bits (i.e. things stop working until CR is rewritten
        // with sane value). This disagrees with the datasheet.
        // CTS and DTD are based on external inputs so leave them alone.
        this.sr &= 0x08 | 0x04;
        // Reset clears the transmit register so raise the empty bit.
        this.sr |= 0x02;
        this.hadDcdHigh = false;
        this.updateIrq();
    }

    tone(freq) {
        if (!freq) this.toneGen.mute();
        else this.toneGen.tone(freq);
    }

    setMotor(on) {
        if (on && !this.motorOn) {
            this.runTape();
        } else if (!on && this.motorOn) {
            this.toneGen.mute();
            this.runTapeTask.cancel();
            this.setTapeCarrier(false);
        }
        this.motorOn = on;
    }

    read(addr) {
        if (addr & 1) {
            this.sr &= ~0xa1;
            this.hadDcdHigh = false;
            this.updateIrq();
            return this.dr;
        } else {
            let result = (this.sr & 0x7f) | (this.sr & this.cr & 0x80);
            // MC6850: "A low CTS indicates that there is a Clear-to-Send
            // from the modem. In the high state, the Transmit Data Register
            // Empty bit is inhibited".
            if (result & 0x08) {
                result &= ~0x02;
            }

            // MC6850: "It remains high after the DCD input is returned low
            // until cleared by first reading the Status Register and then
            // the Data Register".
            // Testing on a real machine shows that only the Data Register
            // read matters, and clears the "saw DCD high" condition.
            if (this.hadDcdHigh) {
                result |= 0x04;
            }

            return result;
        }
    }

    write(addr, val) {
        if (addr & 1) {
            this.sr &= ~0x02;
            // It's not clear how long this can take; it's when the shift register is loaded.
            // That could be straight away if not already tx-ing, but as we don't really tx,
            // be conservative here.
            this.txCompleteTask.reschedule(2000);
            this.updateIrq();
            if (this.rs423Selected && this.rs423Handler) this.rs423Handler.onTransmit(val);
        } else {
            if ((val & 0x03) === 0x03) {
                // According to the 6850 docs writing 3 here doesn't affect any CR bits, but
                // just resets the device.
                this.reset();
            } else {
                this.cr = val;
                this.setSerialReceive(this.serialReceiveRate);
            }
        }
    }

    selectRs423(selected) {
        this.rs423Selected = !!selected;
        if (this.rs423Selected) {
            // RS423 selected.
            // CTS is always high, meaning not Clear To Send. This is
            // because we don't yet emulate anything on the "other end",
            // so there is nothing to pull CTS low.
            this.sr |= 0x08;
        } else {
            // Cassette selected.
            // CTS is always low, meaning actually Clear To Send.
            this.sr &= ~0x08;
        }
        this.dcdLineUpdated();
        this.runRs423Task.ensureScheduled(this.rs423Selected, this.serialReceiveCyclesPerByte);
    }

    dcdLineUpdated() {
        // AUG: "It will always be low when the RS423 interface is selected".
        const level = this.rs423Selected ? false : this.tapeDcdLineLevel;

        if (level && !(this.sr & 0x04)) {
            // DCD interrupts on low -> high level change.
            this.sr |= 0x84;
            this.hadDcdHigh = true;
        } else if (!level && this.sr & 0x04) {
            this.sr &= ~0x04;
        }
        this.updateIrq();
    }

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

    receive(byte) {
        byte |= 0;
        if (this.sr & 0x01) {
            // Overrun.
            // TODO: this doesn't match the datasheet:
            // "The Overrun does not occur in the Status Register until the
            // valid character prior to Overrun has been read."
            console.log("Serial overrun");
            this.sr |= 0xa0;
        } else {
            // If bit 7 contains parity, mask it off.
            this.dr = byte & (this.cr & 0x10 ? 0xff : 0x7f);
            this.sr |= 0x81;
        }
        this.updateIrq();
    }

    setTape(tape) {
        this.tape = tape;
    }

    rewindTape() {
        if (this.tape) {
            console.log("rewinding tape");
            this.tape.rewind();
        }
    }

    secondsToCycles(sec) {
        return Math.floor(2 * 1000 * 1000 * sec) | 0;
    }

    numBitsPerByte() {
        const wordLength = this.cr & 0x10 ? 8 : 7;
        let stopBits, parityBits;
        switch ((this.cr >>> 2) & 7) {
            case 0:
                stopBits = 2;
                parityBits = 1;
                break;
            case 1:
                stopBits = 2;
                parityBits = 1;
                break;
            case 2:
                stopBits = 1;
                parityBits = 1;
                break;
            case 3:
                stopBits = 1;
                parityBits = 1;
                break;
            case 4:
                stopBits = 2;
                parityBits = 0;
                break;
            case 5:
                stopBits = 1;
                parityBits = 0;
                break;
            case 6:
                stopBits = 1;
                parityBits = 1;
                break;
            case 7:
                stopBits = 1;
                parityBits = 1;
                break;
        }
        return wordLength + stopBits + parityBits;
    }

    rts() {
        // True iff CR6 = 0 or CR5 and CR6 are both 1.
        return (this.cr & 0x40) === 0 || (this.cr & 0x60) === 0x60;
    }

    setSerialReceive(rate) {
        this.serialReceiveRate = rate;
        this.serialReceiveCyclesPerByte = this.secondsToCycles(this.numBitsPerByte() / rate);
    }

    runTape() {
        if (this.tape) this.runTapeTask.reschedule(this.tape.poll(this));
    }

    runRs423() {
        if (!this.rs423Handler) return;
        const rcv = this.rs423Handler.tryReceive(this.rts());
        if (rcv >= 0) this.receive(rcv);
        this.runRs423Task.reschedule(this.serialReceiveCyclesPerByte);
    }
}
