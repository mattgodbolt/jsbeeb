/* 6850 ACIA */
function Acia(cpu) {
    "use strict";
    var self = this;
    self.sr = 0x00;
    self.cr = 0x00;
    self.dr = 0x00;
    self.motorOn = false;

    function updateIrq() {
        if (self.sr & self.cr & 0x80) {
            cpu.interrupt |= 0x04;
        } else {
            cpu.interrupt &= ~0x04;
        }
    }

    self.reset = function() {
        self.sr = (self.sr & 0x08) | 0x04;
        self.motorOn = false;
        updateIrq();
    };
    self.reset();

    self.setMotor = function(on) {
        self.motorOn = on;
    };

    self.read = function(addr) {
        if (addr & 1) {
            self.sr &= ~0x81;
            updateIrq();
            return self.dr;
        } else {
            // Return with the TDRE set. Not sure this is any different from just keeping the
            // TDRE bit set all the time.
            return (self.sr & 0x7f) | (self.sr & self.cr & 0x80) | 0x02;
        }
    };

    self.write = function(addr, val) {
        if (addr & 1) {
            // Ignore sends, except for clearing the TDRE.
            self.sr &= ~0x02;
            updateIrq();
        } else {
            self.cr = val;
            if ((self.cr & 0x03) == 0x03) {
                self.reset();
            }
            updateRate();
        }
    };

    self.selectRs423 = function(selected) {
        if (selected) {
            self.sr &= ~0x04; // Clear DCD
        } else {
            self.sr &= ~0x08; // Clear CTS
        }
    };

    self.setDCD = function(level) {
        if (level) {
            if (self.sr & 0x04) return;
            self.sr |= 0x84;
        } else {
            self.sr &= ~0x04;
        }
        updateIrq();
    };

    self.receive = function (byte) {
        byte|=0;
        self.dr = byte;
        self.sr |= 0x81;
        updateIrq();
    };

    self.setTape = function(tape) {
        self.tape = tape;
    };

    var runCounter = 0;
    var cyclesPerPoll = (2 * 1000 * 1000) / 30;
    var serialReceiveRate = 19200;

    self.setSerialReceive = function(rate) {
        serialReceiveRate = rate;
        updateRate();
    };

    var dividerTable = [1, 16, 64, 1];
    function updateRate() {
        var bitsPerByte = 8;
        if (!(self.cr & 0x80)) {
            bitsPerByte++; // Not totally correct if the AUG is to be believed.
        }
        var divider = dividerTable[self.cr & 0x03];
        var newCyclesPerPoll = (64 * 2 * 1000 * 1000) / serialReceiveRate / divider;
        newCyclesPerPoll = Math.floor(bitsPerByte * newCyclesPerPoll);
        if (cyclesPerPoll != newCyclesPerPoll) {
            cyclesPerPoll = newCyclesPerPoll;
            console.log("Serial/ACIA - new cycles per poll = " + cyclesPerPoll);
            console.log("Serial recv rate", serialReceiveRate);
            console.log("Divider", divider);
            console.log("Bits per byte", bitsPerByte);
        }
    }

    function run() {
        self.tape.poll(self);
    }

    self.polltime = function(cycles) {
        if (!self.motorOn) return;
        runCounter -= cycles;
        if (runCounter < 0) {
            runCounter += cyclesPerPoll;
            run();
        }
    };
}

function TapefileTape(data) {
    var self = this;
    
    self.count = 0;
    self.ptr = 0;

    self.poll = function(acia) {
        if (self.count) {
            if (--self.count) return;
        }
        if (self.ptr >= data.length) return;
        var byte = data[self.ptr++];
        if (byte === 0xff) {
            byte = data[self.ptr++];
            if (byte === 0) {
                return acia.setDCD(false);
            } else if (byte === 0x04) {
                return acia.setDCD(true);
            }else if (byte !== 0xff) {
                throw "Got a weird byte in the tape";
            }
        }
        acia.receive(byte);
    };
}

function loadTape(name) {
    console.log("Loading tape from " + name);
    var data = loadData(name);
    if (!data) return null;
    if (data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
        // It's gzipped, un-gzip before we detect further.
        console.log("Tape is gzipped");
        data = ungzip(data);
    }
    if (data[0] === 0xff && data[1] === 0x04) {
        console.log("Detected a 'tapefile' tape");
        return new TapefileTape(data);
    }
    console.log("Unknown tape format");
    return null;
}
