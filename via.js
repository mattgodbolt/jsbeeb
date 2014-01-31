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
      PORTBINT = 0x18,
      PORTAINT = 0x03,
      INT_CA1 = 0x02,
      INT_CA2 = 0x01,
      INT_CB1 = 0x10,
      INT_CB2 = 0x08;

function via(ifr) {
    return {
        ora: 0, orb: 0, ira: 0, irb: 0,
        ddra: 0, ddrb: 0,
        sr: 0,
        t1l: 0, t2l: 0,
        t1c: 0, t2c: 0,
        acr: 0, pcr: 0, ifr: 0, ier: 0,
        t1hit: 0, t2hit: 0,
        porta: 0, portb: 0,
        ca1: 0, ca2: 0,

        update: function(cycles) {
            this.t1c -= cycles;
            if (!(this.acr & 0x20)) this.t2c -= cycles;
            return (this.t1c < -3 || this.t2c < -3);
        },

        setca2: function(val) {
            if (val == this.ca2 || (this.pcr & 8)) return;
            var pcrSetting = !!(this.pcr & 0x4);
            if (pcrSetting == !!val) {
                this.ifr |= INT_CA2;
                ifr.updateIFR();
            }
            this.ca2 = val;
        },

        read: function(addr) {
            switch (addr|0) {
            case DDRA: return this.ddra;
            case DDRB: return this.ddrb;
            case T1LL: return (this.t1l & 0x1fe) >> 1;
            case T1LH: return this.t1l >> 9;
            case T1CL:
               this.ifr &= ~TIMER1INT;
               ifr.updateIFR();
               if (this.t1c < -1) return 0xff;
               return ((this.t1c + 1) >> 1) & 0xff;
            case T1CH:
               if (this.t1c < -1) return 0xff;
               return (this.t1c+1) >> 9;
            case T2CL:
               this.ifr &= ~TIMER2INT;
               ifr.updateIFR();
               return ((this.t2c + 1) >> 1) & 0xff;
            case T2CH:
               return (this.t2c + 1) >> 9;
            case SR: return this.sr;
            case ACR: return this.acr;
            case PCR: return this.pcr;
            case IER: return this.ier | 0x80;
            case IFR: return this.ifr;
            default: throw "Unknown VIA read";
            }
        }
    };
}

function sysvia(cpu) {
    this.via = via(this);
    this.IC32 = 0;

    this.updateIFR = function() {
        if ((this.via.ifr & 0x7f) & (this.via.ier & 0x7f)) {
            this.via.ifr |= 0x80;
            cpu.interrupt |= 1;
        } else {
            this.via.ifr &= ~0x80;
            cpu.interrupt &= ~1;
        }
    };
    this.read = function(addr) {
        // TODO: some considerable updates here, cf b-em2.2
        var temp;
        addr &= 0xf;
        switch (addr) {
        case ORA:
            this.via.ifr &= ~PORTAINT;
            this.updateIFR();
            // falls through
        case ORAnh: // keyboard
            // if master and cmos and not compact return cmosread
            var temp = this.via.ora & this.via.ddra;
            if (this.via.acr & 1) {
                temp |= this.via.ira & ~this.via.ddra;
            } else {
                this.updateSdb();
                temp |= this.sdbval &~this.via.ddra;
            }
            return temp;
        case ORB:
            this.via.ifr &= 0xef;
            this.updateIFR();
            temp = this.via.orb & this.via.ddrb;
            // todo: compact cmos?
            this.via.irb |= 0xf0;
            // todo: joystick buttons
            temp |= (this.via.irb & ~this.via.ddrb);
            return temp;
        default:
            return this.via.read(addr);
        }
    };

    this.keycol = 0;
    this.keyrow = 0;
    this.sdbout = 0;
    this.sdbval = 0;
    this.scrsize = 0;
    this.getScrSize = function() { return this.scrsize; };
    this.keys = [];
    for (var i = 0; i < 16; ++i) { this.keys[i] = new Uint8Array(16); }

    this.vblankint = function() {
        if (!this.via.ca1 && (this.via.pcr & 1)) {
            this.via.ifr |= 2;
            this.updateIFR();
        }
        this.via.ca1 = 1;
    };
    this.vblankintlow = function() {
        if (this.via.ca1 && !(this.via.pcr & 1)) {
            this.via.ifr |= 2;
            this.updateIFR();
        }
        this.via.ca1 = 0;
    };

    this.keycodeToRowCol = (function() {
        var keys = {};
        function C(s, c, r) { keys[s.charCodeAt(0)] = [c, r]; };
        C('\r', 9, 4);
        C('\x08', 9, 5); // delete
        C('\x10', 0, 0); // shift
        C('\x1b', 0, 7); // escape
        C('\x11', 1, 0); // control
        C('\x00', 0, 4); // caps
        C('\x25', 9, 1); // arrow left TBC
        C('\x28', 9, 2); // arrow down TBC
        C('\x27', 9, 3); // arrow up TBC
        C('\x26', 9, 7); // arrow right TBC
        
        //C('TODO', 9, 6); // copy key?

        C('\xba', 7, 5);  // ';' / '+'
        C('\xbc', 6, 6);  // ','
        C('\xbd', 7, 1);  // '_' / '=' mapped to underscore
        C('\xbe', 7, 6);  // '.' (why is this 0xbe / 190) ? 
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

        C(' ', 2, 6);
        return keys;
    })();
    this.set = function(key, val) {
        console.log(key);
        var colrow = this.keycodeToRowCol[key];
        if (!colrow) return;
        this.keys[colrow[0]][colrow[1]] = val;
        this.updateKeys();
    };
    this.keyDown = function(key) { this.set(key, 1); };
    this.keyUp = function(key) { this.set(key, 0); };

    this.updateKeys = function() {
        var numCols = 10; // 13 for MASTER
        var i, j;
        if (this.IC32 & 8) {
            for (i = 0; i < numCols; ++i) {
                for (j = 1; j < 8; ++j) {
                    if (this.keys[i][j]) {
                        this.via.setca2(true);
                        return;
                    }
                }
            }
        } else {
            if (this.keycol < numCols) {
                for (j = 1; j < 8; ++j) {
                    if (this.keys[this.keycol][j]) {
                        this.via.setca2(true);
                        return;
                    }
                }
            }
        }
        this.via.setca2(false);
    };

    this.updateSdb = function() {
        this.sdbval = this.sdbout;
        // TODO cmos
        var keyrow = (this.sdbval >> 4) & 7;
        this.keycol = this.sdbval & 0xf;
        this.updateKeys();
        if (!(this.IC32 & 8) && !this.keys[this.keycol][keyrow]) {
            this.sdbval &= 0x7f;
        }
    };
    this.writeIC32 = function(val) { // addressable latch
        var oldIC32 = this.IC32;
        if (val & 8)
           this.IC32 |= (1<<(val&7));
        else
           this.IC32 &= ~(1<<(val&7));

        this.updateSdb();
        // TODO: sound
        if (!(this.IC32&1) && (oldIC32&1))
           console.log("sound: " + this.sdbval);

        this.scrsize = ((this.IC32&16)?2:0) | ((this.IC32&32)?1:0);
        //if (MASTER && !compactcmos) cmosupdate(IC32,sdbval);
    };

    this.updateDataBus = function() {
        this.sdbout = ((this.via.ora & this.via.ddra) | ~this.via.ddra) & 0xff;
        this.updateSdb();
        // CMOS write?
    };

    this.write = function(addr, val) {
        addr &= 0xf;
        switch (addr) {
        case ORA:
            this.via.ifr &= 0xfd;
            if (!(this.via.pcr & 4) || (this.via.pcr & 8)) this.via.ifr &= ~1;
            this.updateIFR();
            // Falls through to
        case ORAnh:
            this.via.ora = val;
            this.via.porta = (this.via.porta & ~this.via.ddra) | (this.via.ora & this.via.ddra);
            this.updateDataBus();
            break;
        case ORB:
            this.via.orb = val;
            // TODO: compactcmos
            this.via.portb = (this.via.portb & ~this.via.ddrb) | (this.via.orb & this.via.ddrb);
            this.via.ifr &= 0xef;
            if (!(this.via.pcr & 0x40) || (this.via.pcr & 0x80)) this.via.ifr &= ~8;
            this.writeIC32(val);
            this.updateIFR();
            // TODO: CMOS write
            break;
        case DDRA: 
            this.via.ddra = val; 
            this.updateDataBus();
            break;
        case DDRB: this.via.ddrb = val; break;
        case SR: this.via.sr = val; break;
        case ACR: this.via.acr = val; break;
        case PCR: /* TODO: latchpen? */ this.via.pcr = val; break;
        case T1LL: case T1CL:
            this.via.t1l &= 0x1fe00;
            this.via.t1l |= (val << 1);
            break;            
        case T1LH:
           this.via.t1l &= 0x1fe;
           this.via.t1l |= (val << 9);
           if (this.via.acr & 0x40) {
               this.via.ifr &= ~TIMER1INT;
               this.updateIFR();
           }
           break;
        case T1CH:
           this.via.t1l &= 0x1fe;
           this.via.t1l |= (val << 9);
           this.via.t1c = this.via.t1l + 1;
           this.via.ifr &= ~TIMER1INT;
           this.updateIFR();
           this.via.t1hit = 0;
           break;
        case T2CL:
           this.via.t2l &= 0x1fe00;
           this.via.t2l |= (val << 1);
           break;
        case T2CH:
           if (this.via.t2c == -3 && (this.via.ier & TIMER2INT) && !(this.via.ifr & TIMER2INT)) {
               cpu.interrupt |= 128;
           }
           this.via.t2l &= 0x1fe;
           this.via.t2l |= (val << 9);
           this.via.t2c = this.via.t2l + 1;
           this.via.ifr &= ~TIMER2INT;
           this.updateIFR();
           this.via.t2hit = 0;
           break;
        case IER:
           if (val & 0x80)
               this.via.ier |= (val & 0x7f);
           else
               this.via.ier &= ~(val & 0x7f);
           this.updateIFR();
           break;
        case IFR:
           this.via.ifr &= ~(val & 0x7f);
           this.updateIFR();
           break;
        default:
            throw "Sys VIA write " + hexbyte(addr) + " " + hexbyte(val);
            break;
        }
        return 0xfe;
    };

    this.polltime = function(cycles) {
        if (this.via.update(cycles)) {
            if (this.via.t1c < -3) {
                while (this.via.t1c < -3) this.via.t1c += this.via.t1l + 4;
                if (!this.via.t1hit) {
                    this.via.ifr |= TIMER1INT;
                    this.updateIFR();
                }
                if (!(this.via.acr & 0x40)) this.via.t1hit = 1;
            }
            if (!(this.via.acr & 0x20)) {
                if (this.via.t2c < -3) {
                    if (!this.via.t2hit) {
                        this.via.ifr |= TIMER2INT;
                        this.updateIFR();
                    }
                    this.via.t2hit = 1;
                }
            }
        }
    };
    this.reset = function() {
        this.via.ifr = this.via.ier = 0;
        this.via.t1c = this.via.t1l = 0x1fffe;
        this.via.t2c = this.via.t2l = 0x1fffe;
        this.via.t1hit = this.via.t2hit = 0;
    };

    this.reset();
}

function uservia(cpu) {
    this.via = via(this);
    this.timerout = 1;
    this.updateIFR = function() {
        if ((this.via.ifr & 0x7f) & (this.via.ier & 0x7f)) {
            this.via.ifr |= 0x80;
            cpu.interrupt |= 2;
        } else {
            this.via.ifr &= ~0x80;
            cpu.interrupt &= ~2;
        }
    };
    this.write = function(addr, val) {
        addr &= 0xf;
        switch (addr) {
        case ORA:
            this.via.ifr &= 0xfc;
            this.updateIFR();
            // falls to
        case ORAnh:
            this.via.ora = val;
            this.via.porta = (this.via.porta & ~this.via.ddra) | (this.via.ora & this.via.ddra);
            break;
        case ORB:
            this.via.orb = val;
            this.via.portb = (this.via.portb & ~this.via.ddrb) | (this.via.orb & this.via.ddrb);
            this.via.ifr &= 0xee;
            this.updateIFR();
            break;
        case DDRA: this.via.ddra = val; break;
        case DDRB: this.via.ddrb = val; break;
        case ACR: this.via.acr = val; break;
        case PCR: this.via.pcr = val; break;
        case SR: this.via.sr = val; break;
        case T1LL: case T1CL:
            this.via.tl1 &= 0x1fe000;
            this.via.t1l |= (val << 1);
            break;
        case T1LH:
            this.via.t1l &= 0x1fe;
            this.via.t1l |= (val << 9);
            if (this.via.acr & 0x40) {
                this.via.ifr &= ~TIMER1INT;
                this.updateIFR();
            }
            break;
        case T1CH:
            if ((this.via.acr & 0xc0) == 0x80) this.timerout  = 0;
            this.via.t1l &= 0x1fe;
            this.via.t1l |= (val << 9);
            this.via.t1c = this.via.t1l + 1;
            this.via.ift &= ~TIMER1INT;
            this.updateIFR();
            this.t1hit = 0;
            break;
        case T2CL:
            this.via.t2l &= 0x1fe00;
            this.via.t2l |= (val << 1);
            break;
        case T2CH:
            if (this.via.t2c == -3 && (this.via.ier & TIMER2INT) || 
                    (this.via.ifr & this.via.ier & TIMER2INT)) {
                cpu.interrupt |= 128;
            }
            this.via.t2l &= 0x1fe;
            this.via.t2l |= (val << 9);
            this.via.t2c = this.via.t2l + 1;
            this.via.ifr &= ~TIMER2INT;
            this.updateIFR();
            this.via.t2hit = 0;
            break;
        case IER:
            if (val & 0x80)
                this.via.ier |= (val & 0x7f);
            else
                this.via.ier &= ~(val & 0x7f);
            this.updateIFR();
            break;
        case IFR:
            this.via.ift &= ~(val & 0x7f);
            this.updateIFR();
            break;
        default:
            throw "User VIA write " + hexbyte(addr) + " " + hexbyte(val);
        }
    };
    this.read = function(addr) {
        var temp;
        addr &= 0xf;
        switch (addr) {
        case ORA:
            this.via.ifr &= ~PORTAINT;
            this.updateIFR();
            // Falls through to
        case ORAnh:
            temp = this.via.ora & this.via.ddra;
            temp |= this.via.porta & ~this.via.ddra;
            return temp & 0x7f;
        case ORB:
            this.via.ifr &= ~PORTBINT;
            this.updateIFR();
            temp = this.via.orb & this.via.ddrb;
            if (this.via.acr & 2)
                temp |= this.via.irb & ~this.via.ddrb;
            else
                temp |= this.via.portb & ~this.via.ddrb;
            if (this.timerout)
                temp |= 0x80;
            else
                temp &= 0x7f;
            return temp;
        default:
            return this.via.read(addr);
        }
        throw "User VIA read " + hexbyte(addr);
    };

    this.reset = function() {
        this.via.ora = 0x80;
        this.via.orb = 0xff;
        this.via.ifr = this.via.ier = 0;
        this.via.t1c = this.via.t1l = 0x1fffe;
        this.via.t2c = this.via.t2l = 0x1fffe;
        this.via.t1hit = this.via.t2hit = 1;
        this.timerout = 1;
        this.via.acr = 0;
    };

    this.polltime = function(cycles) {
        if (this.via.update(cycles)) {
            if (this.via.t1c < -3) {
                while (this.via.t1c < -3) this.via.t1c += this.via.t1l + 4;
                if (!this.via.t1hit) {
                    this.via.ifr |= TIMER1INT;
                    this.updateIFR();
                }
                if ((this.via.acr & 0x80) && !this.via.t1hit) {
                    this.via.orb ^= 0x80;
                    this.via.irb ^= 0x80;
                    this.via.portb ^= 0x80;
                    this.timerout ^= 1;
                }
                if (!(this.via.acr & 0x40)) this.via.t1hit = 1;
            }
            if (!(this.via.acr & 0x20)) {
                if (this.via.t2c < -3) {
                    if (!this.via.t2hit) {
                        this.via.ifr |= TIMER2INT;
                        this.updateIFR();
                    }
                    this.via.t2hit = 1;
                }
            }
        }
    };

    this.reset();
}
