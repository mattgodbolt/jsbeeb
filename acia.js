define([], function () {
    "use strict";
    // Some info:
    // http://www.playvectrex.com/designit/lecture/UP12.HTM
    // https://books.google.com/books?id=wUecAQAAQBAJ&pg=PA431&lpg=PA431&dq=acia+tdre&source=bl&ots=mp-yF-mK-P&sig=e6aXkFRfiIOb57WZmrvdIGsCooI&hl=en&sa=X&ei=0g2fVdDyFIXT-QG8-JD4BA&ved=0CCwQ6AEwAw#v=onepage&q=acia%20tdre&f=false
    // http://www.classiccmp.org/dunfield/r/6850.pdf
    return function Acia(cpu, toneGen, scheduler, rs423Handler) {
        var self = this;
        self.sr = 0x02;
        self.cr = 0x00;
        self.dr = 0x00;
        self.rs423Handler = rs423Handler;
        self.rs423Selected = false;
        self.motorOn = false;
        // TODO: set clearToSend accordingly; at the moment it stays low.
        // would need to be updated based on the "other end" of the link, and
        // we would need to generate IRQs appropriately when TDRE goes high.
        self.clearToSend = false;

        function updateIrq() {
            if (self.sr & self.cr & 0x80) {
                cpu.interrupt |= 0x04;
            } else {
                cpu.interrupt &= ~0x04;
            }
        }

        self.reset = function () {
            self.sr = (self.sr & 0x08) | 0x06;
            updateIrq();
        };
        self.reset();

        self.tone = function (freq) {
            if (!freq) toneGen.mute();
            else toneGen.tone(freq);
        };

        self.setMotor = function (on) {
            if (on && !self.motorOn)
                runTape();
            else {
                toneGen.mute();
                self.runTapeTask.cancel();
            }
            self.motorOn = on;
        };

        self.read = function (addr) {
            if (addr & 1) {
                self.sr &= ~0xa1;
                updateIrq();
                return self.dr;
            } else {
                var result = (self.sr & 0x7f) | (self.sr & self.cr & 0x80);
                if (!self.clearToSend) result &= ~0x02; // Mask off TDRE if not CTS
                result = result | 0x02 | 0x08;
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
                self.sr &= ~0x04; // Clear DCD
            } else {
                self.sr &= ~0x08; // Clear CTS
            }
            self.runRs423Task.ensureScheduled(self.rs423Selected, self.serialReceiveCyclesPerByte);
        };

        self.setDCD = function (level) {
            if (level) {
                if (self.sr & 0x04) return;
                self.sr |= 0x84;
            } else {
                self.sr &= ~0x04;
            }
            updateIrq();
        };

        self.receive = function (byte) {
            byte |= 0;
            if (self.sr & 0x01) {
                // Overrun.
                console.log("Serial overrun");
                self.sr |= 0xa0;
            } else {
                self.dr = byte;
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
                    stopBits = q;
                    parityBits = q;
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
