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
    }

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

function Tape(stringData) {
    var self = this;
    
    //TODO: ugly and duplicated with disc code
    var data;
    if (typeof(data) == "string") {
        data = stringData;
    } else {
        var len = stringData.length;
        data = new Uint8Array(len);
        for (var i = 0; i < len; ++i) data[i] = stringData.charCodeAt(i) & 0xff;
    }
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
    }
}
