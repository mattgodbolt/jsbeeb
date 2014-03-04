const ORB   = 0x0,
      ORA   = 0x1,
      DDRB  = 0x2,
      DDRA  = 0x3,
      T1CL  = 0x4,
      T1CH  = 0x5,
      T1LL  = 0x6,
      T1LH  = 0x7,
      T2CL  = 0x8,
      T2CH  = 0x9,
      SR    = 0xa,
      ACR   = 0xb,
      PCR   = 0xc,
      IFR   = 0xd,
      IER   = 0xe,
      ORAnh = 0xf,
      TIMER1INT = 0x40,
      TIMER2INT = 0x20,
      INT_CA1 = 0x02,
      INT_CA2 = 0x01,
      INT_CB1 = 0x10,
      INT_CB2 = 0x08;

function via(cpu, irq) {
    "use strict";
    var self = {
        ora: 0, orb: 0, ira: 0, irb: 0,
        ddra: 0, ddrb: 0,
        sr: 0,
        t1l: 0, t2l: 0,
        t1c: 0, t2c: 0,
        acr: 0, pcr: 0, ifr: 0, ier: 0,
        t1hit: 0, t2hit: 0,
        porta: 0, portb: 0,
        ca1: 0, ca2: 0,

        reset: function() {
            self.ora = self.orb = 0xff;
            self.ddra = self.ddrb = 0xff;
            self.ifr = self.ier = 0x00;
            self.t1c = self.t1l = self.t2c = self.t2l = 0x1fffe;
            self.t1hit = self.t2hit = 1;
            self.acr = self.pcr = 0;
        },

        polltime: function(cycles) {
            self.t1c -= cycles;
            if (!(self.acr & 0x20)) self.t2c -= cycles;
            if (self.t1c < -3) {
                while (self.t1c < -3) self.t1c += self.t1l + 4;
                if (!self.t1hit) {
                    self.ifr |= TIMER1INT;
                    self.updateIFR();
                    if ((self.acr & 0x80)) {
                        // b-em comment is "Output to PB7"
                        self.orb ^= 0x80;
                    }
                }
                if (!(this.acr & 0x40)) self.t1hit = 1;
            }
            if (self.acr & 0x20) return;
            if (self.t2c < -3 && !self.t2hit) {
                self.ifr |= TIMER2INT;
                self.updateIFR();
                self.t2hit = 1;
            }
        },

        updateIFR: function() {
            if (self.ifr & self.ier & 0x7f) {
                self.ifr |= 0x80;
                cpu.interrupt |= irq;
            } else {
                self.ifr &= ~0x80;
                cpu.interrupt &= ~irq;
            }
        },

        write: function(addr, val) {
            val|= 0;
            switch (addr&0xf) {
            case ORA:
                self.ifr &= ~INT_CA1;
                if ((self.pcr & 0x0a) != 0x02) {
                    // b-em: Not independent interrupt for CA2
                    self.ifr &= ~INT_CA2;
                }
                self.updateIFR();

                var mode = (self.pcr & 0x0e);
                if (mode == 8) { // Handshake mode
                    self.setca2(0);
                } else if (mode == 0x0a) { // Pulse mode
                    self.setca2(0);
                    self.setca2(1);
                }
                // Falls through to...
            case ORAnh:
                self.ora = val;
                self.writePortA(((self.ora & self.ddra) | ~self.ddra) & 0xff);
                break;

            case ORB:
                self.ifr &= ~INT_CB1;
                if ((self.pcr & 0xa0) != 0x20) {
                    // b-em: Not independent interrupt for CB2
                    self.ifr &= ~INT_CB2;
                }
                self.updateIFR();

                self.orb = val;
                self.writePortB(((self.orb & self.ddrb) | ~self.ddrb) & 0xff);

                var mode = (self.pcr & 0xe0) >>> 4;
                if (mode == 8) { // Handshake mode
                    self.setcb2(0);
                } else if (mode == 0x0a) { // Pulse mode
                    self.setcb2(0);
                    self.setcb2(1);
                }
                break;

            case DDRA:
                self.ddra = val; 
                self.writePortA(((self.ora & self.ddra) | ~self.ddra) & 0xff);
                break;

            case DDRB:
                self.ddrb = val; 
                self.writePortB(((self.orb & self.ddrb) | ~self.ddrb) & 0xff);
                break;

            case ACR: 
                self.acr = val; 
                break;

            case PCR:
                self.pcr = val;
                if ((val & 0xe) == 0xc) self.setca2(0);
                else if (val & 0x08) self.setca2(1);
                if ((val & 0xe0) == 0xc0) self.setcb2(0);
                else if (val & 0x80) self.setcb2(1);
                break;

            case SR:
                self.sr = val;
                break;

            case T1LL: 
            case T1CL:
                self.t1l &= 0x1fe00;
                self.t1l |= (val << 1);
                break;

            case T1LH:
                self.t1l &= 0x1fe;
                self.t1l |= (val << 9);
                if (self.acr & 0x40) {
                    self.ifr &= ~TIMER1INT;
                    self.updateIFR();
                }
                break;

            case T1CH:
                if ((self.acr & 0xc0) == 0x80) self.orb &= ~0x80; // One-shot timer
                self.t1l &= 0x1fe;
                self.t1l |= (val << 9);
                self.t1c = self.t1l + 1;
                self.t1hit = 0;
                self.ifr &= ~TIMER1INT;
                self.updateIFR();
                break;

            case T2CL:
                self.t2l &= 0x1fe00;
                self.t2l |= (val << 1);
                break;

            case T2CH:
                // TODO: b-em has a Kevin Edwards protection specific hack here. hopefully that's not necessary if we get instruction timings more correct.
                self.t2l &= 0x1fe;
                self.t2l |= (val << 9);
                self.t2c = self.t2l + 1;
                self.ifr &= ~TIMER2INT;
                self.updateIFR();
                self.t2hit = 0;
                break;

            case IER:
                if (val & 0x80)
                    self.ier |= (val & 0x7f);
                else
                    self.ier &= ~(val & 0x7f);
                self.updateIFR();
                break;

            case IFR:
                self.ifr &= ~(val & 0x7f);
                self.updateIFR();
                break;
            }
        },

        read: function(addr) {
            var temp;
            switch (addr & 0xf) {
            case ORA:
                self.ifr &= ~INT_CA1;
                if ((self.pcr & 0xa) != 0x2)
                    self.ifr &= ~INT_CA2;
                self.updateIFR();
                // Falls to
            case ORAnh:
                temp = self.ora & self.ddra;
                if (self.acr & 1)
                    return temp | (self.ira & ~self.ddra);
                else 
                    return temp | (self.readPortA() & ~self.ddra);

            case ORB:
                self.ifr &= ~INT_CB1;
                if ((self.pcr & 0xa0) != 0x20)
                    self.ifr &= ~INT_CB2;
                self.updateIFR();

                temp = self.orb & self.ddrb;
                if (self.acr & 2)
                    return temp | (self.irb & ~self.ddrb);
                else
                    return temp | (self.readPortB() & ~self.ddrb);

            case DDRA: return self.ddra;
            case DDRB: return self.ddrb;
            case T1LL: return (self.t1l & 0x1fe) >> 1;
            case T1LH: return self.t1l >> 9;

            case T1CL:
               self.ifr &= ~TIMER1INT;
               self.updateIFR();
               if (self.t1c < -1) return 0xff;
               return ((self.t1c + 1) >> 1) & 0xff;

            case T1CH:
               if (self.t1c < -1) return 0xff;
               return (self.t1c+1) >> 9;

            case T2CL:
               self.ifr &= ~TIMER2INT;
               self.updateIFR();
               return ((self.t2c + 1) >> 1) & 0xff;

            case T2CH:
               return (self.t2c + 1) >> 9;

            case SR: return self.sr;
            case ACR: return self.acr;
            case PCR: return self.pcr;
            case IER: return self.ier | 0x80;
            case IFR: return self.ifr;
            default: throw "Unknown VIA read";
            }
        },

        setca1: function(val) {
            var level = !!val;
            if (level === self.ca1) return;
            if (!!(self.pcr & 1) === level) {
                if (self.acr & 1) self.ira = self.readPortA();
                self.ifr |= INT_CA1;
                self.updateIFR();
                if ((self.pcr & 0xc) == 0x8) { // handshaking
                    self.setca2(1);
                }
            }
            self.ca1 = level;
        },

        setca2: function(val) {
            var level = !!val;
            if (level === self.ca2) return;
            if (self.pcr & 8) return; // output
            if (!!(self.pcr & 4) == level) {
                self.ifr |= INT_CA2;
                self.updateIFR();
            }
            self.ca2 = level;
        },

        setcb1: function(val) {
            var level = !!val;
            if (level === self.cb1) return;
            if (!!(self.pcr & 0x10) === level) {
                if (self.acr & 2) self.irb = self.readPortB();
                self.ifr |= INT_CB1;
                self.updateIFR();
                if ((self.pcr & 0xc0) == 0x80) { // handshaking
                    self.setcb2(1);
                }
            }
            self.cb1 = level;
        },

        setcb2: function(val) {
            var level = !!val;
            if (level === self.cb2) return;
            if (self.pcr & 0x80) return; // output
            if (!!(self.pcr & 0x40) == level) {
                self.ifr |= INT_CB2;
                self.updateIFR();
            }
            self.cb2 = level;
        },
    };
    return self;
}

function sysvia(cpu, soundChip) {
    "use strict";
    var self = via(cpu, 0x01);

    self.IC32 = 0;
    self.keycol = 0;
    self.keyrow = 0;
    self.sdbout = 0;
    self.sdbval = 0;
    self.scrsize = 0;
    self.getScrSize = function() { return self.scrsize; };
    self.keys = [];
    for (var i = 0; i < 16; ++i) { self.keys[i] = new Uint8Array(16); }

    self.vblankint = function() {
        self.setca1(1);
    };
    self.vblankintlow = function() {
        self.setca1(0);
    };

    self.keycodeToRowCol = (function() {
        var keys = {};
        function C(s, c, r) { keys[s.charCodeAt(0)] = [c, r]; };
        C('\r', 9, 4);
        C('\x08', 9, 5); // delete
        C('\x10', 0, 0); // shift
        C('\x1b', 0, 7); // escape
        C('\x11', 1, 0); // control
        C('\x00', 0, 4); // caps
        C('\x25', 9, 1); // arrow left
        C('\x26', 9, 3); // arrow up
        C('\x27', 9, 7); // arrow right
        C('\x28', 9, 2); // arrow down
        
        //C('TODO', 9, 6); // copy key?

        C('\xba', 7, 5);  // ';' / '+'
        C('\xbc', 6, 6);  // ','
        C('\xbd', 7, 1);  // '_' / '=' mapped to underscore
        C('\xbe', 7, 6);  // '.' (why is self 0xbe / 190) ? 
        C('\xbf', 8, 6);  // '/' / '?'
        C("\xdb", 8, 3);  // ' maps to [{
        C("\xdd", 8, 5);  // ' maps to ]}
        C("\xde", 8, 4);  // ' maps to :*

        C('0', 2, 0);
        C('1', 0, 3);
        C('2', 1, 3);
        C('3', 1, 1);
        C('4', 2, 1);
        C('5', 3, 1);
        C('6', 4, 3);
        C('7', 4, 2);
        C('8', 5, 1);
        C('9', 6, 2);
        C('0', 7, 2);

        C('Q', 0, 1);
        C('W', 1, 2);
        C('E', 2, 2);
        C('R', 3, 3);
        C('T', 3, 2);
        C('Y', 4, 4);
        C('U', 5, 3);
        C('I', 5, 2);
        C('O', 6, 3);
        C('P', 7, 3);
        //C('', 7, 4); todo: @ character

        C('A', 1, 4);
        C('S', 1, 5);
        C('D', 2, 3);
        C('F', 3, 4);
        C('G', 3, 5);
        C('H', 4, 5);
        C('J', 5, 4);
        C('K', 6, 4);
        C('L', 6, 5);

        C('Z', 1, 6);
        C('X', 2, 4);
        C('C', 2, 5);
        C('V', 3, 6);
        C('B', 4, 6);
        C('N', 5, 5);
        C('M', 5, 6);

        C('\x79', 0, 2); // F0 (mapped to F10)
        C('\x70', 1, 7); // F1
        C('\x71', 2, 7); // F2
        C('\x72', 3, 7); // F3
        C('\x73', 4, 1); // F4
        C('\x74', 4, 7); // F5
        C('\x75', 5, 7); // F6
        C('\x76', 6, 1); // F7
        C('\x77', 6, 7); // F8
        C('\x78', 7, 7); // F9

        C(' ', 2, 6);
        return keys;
    })();
    self.set = function(key, val) {
        var colrow = self.keycodeToRowCol[key];
        if (!colrow) return;
        self.keys[colrow[0]][colrow[1]] = val;
        self.updateKeys();
    };
    self.keyDown = function(key) { self.set(key, 1); };
    self.keyUp = function(key) { self.set(key, 0); };

    self.updateKeys = function() {
        var numCols = 10; // 13 for MASTER
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
            if (self.keycol < numCols) {
                for (j = 1; j < 8; ++j) {
                    if (self.keys[self.keycol][j]) {
                        self.setca2(true);
                        return;
                    }
                }
            }
        }
        self.setca2(false);
    };

    self.updateSdb = function() {
        self.sdbval = self.sdbout;
        // TODO cmos
        var keyrow = (self.sdbval >> 4) & 7;
        self.keycol = self.sdbval & 0xf;
        self.updateKeys();
        if (!(self.IC32 & 8) && !self.keys[self.keycol][keyrow]) {
            self.sdbval &= 0x7f;
        }
    };

    self.writeIC32 = function(val) { // addressable latch
        var oldIC32 = self.IC32;
        if (val & 8)
           self.IC32 |= (1<<(val&7));
        else
           self.IC32 &= ~(1<<(val&7));

        self.updateSdb();
        if (!(self.IC32&1) && (oldIC32&1))
            soundChip.poke(self.sdbval);

        self.scrsize = ((self.IC32&16)?2:0) | ((self.IC32&32)?1:0);
        //if (MASTER && !compactcmos) cmosupdate(IC32,sdbval);
    };
    
    self.writePortA = function(val) {
        self.sdbout = val;
        self.updateSdb();
        // TODO: CMOS write
    };

    self.writePortB = function(val) {
        self.writeIC32(val);
        // TODO: master/compact CMOS
    };

    self.readPortA = function() {
        self.updateSdb();
        return self.sdbval;
    };

    self.readPortB = function() {
        // TODO: compact CMOS, joystick
        return 0xff;
    };

    self.reset();
    return self;
}

function uservia(cpu) {
    "use strict";
    self = via(cpu, 0x02);

    self.writePortA = function(val) {
        // printer port
    };

    self.writePortB = function(val) {
        // user port
    };

    self.readPortA = function() {
        return 0xff; // printer port
    };

    self.readPortB = function() {
        return 0xff; // user port (TODO: mouse, compact joystick)
    };
    self.reset();
    return self;
}
