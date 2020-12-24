define([], function () {
    "use strict";
    // Some info:
    // http://www.playvectrex.com/designit/lecture/UP12.HTM
    // https://books.google.com/books?id=wUecAQAAQBAJ&pg=PA431&lpg=PA431&dq=acia+tdre&source=bl&ots=mp-yF-mK-P&sig=e6aXkFRfiIOb57WZmrvdIGsCooI&hl=en&sa=X&ei=0g2fVdDyFIXT-QG8-JD4BA&ved=0CCwQ6AEwAw#v=onepage&q=acia%20tdre&f=false
    // http://www.classiccmp.org/dunfield/r/6850.pdf
    return function Acia(cpu, toneGen, scheduler, rs423Handler) {
        var self = this;
        self.sr = 0x00;
        self.cr = 0x00;
        self.dr = 0x00;
        self.rs423Handler = rs423Handler;
        self.rs423Selected = false;
        self.motorOn = false;
        self.tapeCarrierCount = 0;
        self.tapeDcdLineLevel = false;
        self.hadDcdHigh = false;

        function updateIrq() {
            if (self.sr & self.cr & 0x80) {
                cpu.interrupt |= 0x04;
            } else {
                cpu.interrupt &= ~0x04;
            }
        }

        self.reset = function () {
            // TODO: testing on a real beeb seems to suggest that reset also
            // clears CR bits (i.e. things stop working until CR is rewritten
            // with sane value). This disagrees with the datasheet.
            // CTS and DTD are based on external inputs so leave them alone.
            self.sr &= (0x08 | 0x04);
            // Reset clears the transmit register so raise the empty bit.
            self.sr |= 0x02;
            self.hadDcdHigh = false;
            updateIrq();
        };

        self.reset();

        self.tone = function (freq) {
            if (!freq) toneGen.mute();
            else toneGen.tone(freq);
        };

        self.setMotor = function (on) {
            if (on && !self.motorOn) {
                runTape();
            } else if (!on && self.motorOn) {
                toneGen.mute();
                self.runTapeTask.cancel();
                self.setTapeCarrier(false);
            }
            self.motorOn = on;
        };

        self.read = function (addr) {
            if (addr & 1) {
                self.sr &= ~0xa1;
                self.hadDcdHigh = false;
                updateIrq();
                return self.dr;
            } else {
                var result = (self.sr & 0x7f) | (self.sr & self.cr & 0x80);
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
                if (self.hadDcdHigh) {
                    result |= 0x04;
                }

                return result;
            }
        };

        self.write = function (addr, val) {
            if (addr & 1) {
                self.sr &= ~0x02;
                // It's not clear how long this can take; it's when the shift register is loaded.
                // That could be straight away if not already tx-ing, but as we don't really tx,
                // be conservative here.
                self.txCompleteTask.reschedule(2000);
                updateIrq();
                if (self.rs423Selected && self.rs423Handler) self.rs423Handler.onTransmit(val);
            } else {
                if ((val & 0x03) === 0x03) {
                    // According to the 6850 docs writing 3 here doesn't affect any CR bits, but
                    // just resets the device.
                    self.reset();
                } else {
                    self.cr = val;
                    self.setSerialReceive(self.serialReceiveRate);
                }
            }
        };

        self.selectRs423 = function (selected) {
            self.rs423Selected = !!selected;
            if (self.rs423Selected) {
                // RS423 selected.
                // CTS is always high, meaning not Clear To Send. This is
                // because we don't yet emulate anything on the "other end",
                // so there is nothing to pull CTS low.
                self.sr |= 0x08;
            } else {
                // Cassette selected.
                // CTS is always low, meaning actually Clear To Send.
                self.sr &= ~0x08;
            }
            self.dcdLineUpdated();
            self.runRs423Task.ensureScheduled(self.rs423Selected, self.serialReceiveCyclesPerByte);
        };

        self.dcdLineUpdated = function () {
            var level;
            if (self.rs423Selected) {
                // AUG: "It will always be low when the RS423 interface is
                // selected".
                level = false;
            } else {
                level = self.tapeDcdLineLevel;
            }

            if (level && !(self.sr & 0x04)) {
                // DCD interrupts on low -> high level change.
                self.sr |= 0x84;
                self.hadDcdHigh = true;
            } else if (!level && (self.sr & 0x04)) {
                self.sr &= ~0x04;
            }
            updateIrq();
        };

        self.setTapeCarrier = function (level) {
            if (!level) {
                self.tapeCarrierCount = 0;
                self.tapeDcdLineLevel = false;
            } else {
                self.tapeCarrierCount++;
                // The tape hardware doesn't raise DCD until the carrier tone
                // has persisted for a while. The BBC service manual opines,
                // "The DCD flag in the 6850 should change 0.1 to 0.4 seconds
                // after a continuous tone appears".
                // Star Drifter doesn't load without this.
                // We use 0.174s, measured on an issue 3 model B.
                // Testing on real hardware, DCD is blipped, it lowers about
                // 210us after it raises, even though the carrier tone
                // may be continuing.
                if (self.tapeCarrierCount === 209) {
                    self.tapeDcdLineLevel = true;
                } else {
                    self.tapeDcdLineLevel = false;
                }
            }
            self.dcdLineUpdated();
        };

        self.receive = function (byte) {
            byte |= 0;
            if (self.sr & 0x01) {
                // Overrun.
                // TODO: this doesn't match the datasheet:
                // "The Overrun does not occur in the Status Register until the
                // valid character prior to Overrun has been read."
                console.log("Serial overrun");
                self.sr |= 0xa0;
            } else {
                // If bit 7 contains parity, mask it off.
                self.dr = byte & ((self.cr & 0x10) ? 0xff : 0x7f);
                self.sr |= 0x81;
            }
            updateIrq();
        };

        self.setTape = function (tape) {
            self.tape = tape;
        };

        self.rewindTape = function () {
            if (self.tape) {
                console.log("rewinding tape");
                self.tape.rewind();
            }
        };

        self.secondsToCycles = function (sec) {
            return Math.floor(2 * 1000 * 1000 * sec) | 0;
        };

        self.serialReceiveRate = 0;
        self.serialReceiveCyclesPerByte = 0;

        self.numBitsPerByte = function () {
            var wordLength = (self.cr & 0x10) ? 8 : 7;
            var stopBits, parityBits;
            switch ((self.cr >>> 2) & 7) {
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
        };

        self.rts = function () {
            // True iff CR6 = 0 or CR5 and CR6 are both 1.
            if ((self.cr & 0x40) === 0) return true;
            if ((self.cr & 0x60) === 0x60) return true;
            return false;
        };

        self.setSerialReceive = function (rate) {
            self.serialReceiveRate = rate;
            self.serialReceiveCyclesPerByte = self.secondsToCycles(self.numBitsPerByte() / rate);
        };
        self.setSerialReceive(19200);

        self.txCompleteTask = scheduler.newTask(function () {
            self.sr |= 0x02; // set the TDRE
        });

        function runTape() {
            if (self.tape) self.runTapeTask.reschedule(self.tape.poll(self));
        }

        self.runTapeTask = scheduler.newTask(runTape);

        function runRs423() {
            if (!rs423Handler) return;
            var rcv = self.rs423Handler.tryReceive(self.rts());
            if (rcv >= 0) self.receive(rcv);
            self.runRs423Task.reschedule(self.serialReceiveCyclesPerByte);
        }

        self.runRs423Task = scheduler.newTask(runRs423);
    };
});
