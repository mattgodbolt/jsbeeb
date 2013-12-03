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
      PORTAINT = 0x03;

function via() {
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
        }
    };
}

function sysvia(cpu) {
    this.via = via();
    this.IC32 = 0;

    this.updateIFR = function() {
        if ((this.via.ifr&0x7f) & (this.via.ier & 0x7f)) {
            this.via.ifr |= 0x80;
            cpu.interrupt |= 1;
        } else {
            this.via.ifr &= 0x80;
            cpu.interrupt &= ~1;
        }
    };
    this.read = function(addr) {
        addr &= 0xf;
        switch (addr) {
        case ORA:
            this.via.ifr &= ~PORTAINT;
            this.updateIFR();
            // falls through
        case ORAnh: // keyboard
            // if master and cmos and not compact return cmosread
            var temp = this.via.ora & this.via.ddra;
            temp |= (this.via.porta & ~this.vis.ddra);
            temp &= 0x7f;
            // TODO: if key press temp |= 0x80
            return temp;
        case SR: return this.via.sr;
        case ACR: return this.via.acr;
        case PCR: return this.via.pcr;
        case IER: return this.via.ier|0x80;
        case IFR: return this.via.ifr;
        default:
            throw "Sys VIA read " + hexbyte(addr);
            break;
        }
        return 0xfe;
    };

    this.sdbval = 0;

    this.writeIC32 = function(val) { // addressable latch
        var oldIC32 = this.IC32;
        if (val & 8)
           this.IC32 |= (1<<(val&7));
        else
           this.IC32 &= ~(1<<(val&7));

        // TODO: screen size
        //scrsize = ((this.IC32&16)?2:0) | ((this.IC32&32)?1:0);
        if (!(this.IC32&8) && (oldIC32&8)) {
            // TODO: keyboard
                //keyrow = (sdbval>>4)&7;
                //keycol = sdbval&0xF;
                //updatekeyboard();
        }
        // TODO: sound
        if (!(this.IC32&1) && (oldIC32&1))
           console.log("sound: " + this.sdbval);
        //if (MASTER && !compactcmos) cmosupdate(IC32,sdbval);
    };

    this.writeDataBus = function(val) {
        this.sdbval = val;
        // TODO: keyboard, cmos
        // [NB commented-out code in b-em for sound]
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
            this.writeDataBus(val);
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
        case DDRA: this.via.ddra = val; break;
        case DDRB: this.via.ddrb = val; break;
        case SR: this.via.sr = val; break;
        case ACR: this.via.acr = val; break;
        case PCR: /* TODO: latchpen? */ this.via.pcr = val; break;
        case T1LL: case T1CL:
            this.via.t1l &= 0x1fe00;
            this.t1l |= (val << 1);
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
           this.t2c = this.via.t2l + 1;
           this.via.ifr &= ~TIMER2INT;
           this.updateIFR();
           this.via.t2hit = 0;
           break;
        case IER:
           if (val & 0x80)
               this.ier |= (val & 0x7f);
           else
               this.ier &= ~(val & 0x7f);
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
                    this.ifr |= TIMER1INT;
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
    this.via = via();
    this.timerout = 1;
    this.updateIFR = function() {
        if ((this.via.ifr&0x7f) & (this.via.ier & 0x7f)) {
            this.via.ifr |= 0x80;
            cpu.interrupt |= 2;
        } else {
            this.via.ifr &= 0x80;
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
        case DDRA: return this.via.ddra;
        case DDRB: return this.via.ddrb;
        case T1LL: return (this.t1l & 0x1fe) >> 1;
        case T1LH: return this.t1l >> 9;
        case T1CL:
            this.via.ifr &= ~TIMER1INT;
            this.updateIFR();
            if (this.via.t1c < -1) return 0xff;
            return ((this.via.t1c + 1) >> 1) & 0xff;
        case T1CH:
            if (this.via.t1c < -1) return 0xff;
            return (this.via.t1c+1) >> 9;
        case T2CL:
            this.ifr &= ~TIMER2INT;
            this.updateIFR();
            return ((this.via.t2c + 1) >> 1) & 0xff;
        case T2CH:
            return (this.via.t2c + 1) >> 9;
        case SR: return this.via.sr;
        case ACR: return this.via.acr;
        case PCR: return this.via.pcr;
        case IER: return this.via.ier | 0x80;
        case IFR: return this.via.ifr;
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
        }
    };

    this.reset();
}
