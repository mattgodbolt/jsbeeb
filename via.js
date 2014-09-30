define(['utils'], function (utils) {
    const ORB = 0x0,
    ORA = 0x1,
    DDRB = 0x2,
    DDRA = 0x3,
    T1CL = 0x4,
    T1CH = 0x5,
    T1LL = 0x6,
    T1LH = 0x7,
    T2CL = 0x8,
    T2CH = 0x9,
    SR = 0xa,
    ACR = 0xb,
    PCR = 0xc,
    IFR = 0xd,
    IER = 0xe,
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
                t1hit: false, t2hit: false,
                porta: 0, portb: 0,
                ca1: 0, ca2: 0,
                justhit: 0,

                reset: function () {
                    self.ora = self.orb = 0xff;
                    self.ddra = self.ddrb = 0xff;
                    self.ifr = self.ier = 0x00;
                    self.t1c = self.t1l = self.t2c = self.t2l = 0x1fffe;
                    self.t1hit = self.t2hit = true;
                    self.acr = self.pcr = 0;
                },

                polltime: function (cycles) {
                    cycles |= 0;
                    self.justhit = 0;
                    var newT1c = self.t1c - cycles;
                    if (newT1c < -2 && self.t1c > -3) {
                        if (!self.t1hit) {
                            self.ifr |= TIMER1INT;
                            self.updateIFR();
                            if (newT1c === -3) {
                                self.justhit |= 1;
                            }
                            // b-em comment is "Output to PB7"
                            self.orb ^= (self.acr & 0x80);
                        }
                        if (!(this.acr & 0x40)) self.t1hit = true;
                    }
                    while (newT1c < -3) newT1c += self.t1l + 4;
                    self.t1c = newT1c;

                    if (!(self.acr & 0x20)) {
                        var newT2c = self.t2c - cycles;
                        if (newT2c < -2) {
                            if (!self.t2hit) {
                                self.ifr |= TIMER2INT;
                                self.updateIFR();
                                if (newT2c === -3) {
                                    self.justhit |= 2;
                                }
                                self.t2hit = true;
                            }
                            newT2c += 0x20000;
                        }
                        self.t2c = newT2c;
                    }
                },

                updateIFR: function () {
                    if (self.ifr & self.ier & 0x7f) {
                        self.ifr |= 0x80;
                        cpu.interrupt |= irq;
                    } else {
                        self.ifr &= ~0x80;
                        cpu.interrupt &= ~irq;
                    }
                },

                write: function (addr, val) {
                    var mode;
                    val |= 0;
                    switch (addr & 0xf) {
                    case ORA:
                        self.ifr &= ~INT_CA1;
                        if ((self.pcr & 0x0a) != 0x02) {
                            // b-em: Not independent interrupt for CA2
                            self.ifr &= ~INT_CA2;
                        }
                        self.updateIFR();

                        mode = (self.pcr & 0x0e);
                        if (mode == 8) { // Handshake mode
                            self.setca2(false);
                        } else if (mode == 0x0a) { // Pulse mode
                            self.setca2(false);
                            self.setca2(true);
                        }
                        /* falls through */
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

                        mode = (self.pcr & 0xe0) >>> 4;
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
                        if ((val & 0xe) == 0xc) self.setca2(false);
                        else if (val & 0x08) self.setca2(true);
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
                        self.t1hit = false;
                        self.ifr &= ~TIMER1INT;
                        self.updateIFR();
                        break;

                    case T2CL:
                        self.t2l &= 0x1fe00;
                        self.t2l |= (val << 1);
                        break;

                    case T2CH:
                        self.t2l &= 0x1fe;
                        self.t2l |= (val << 9);
                        self.t2c = self.t2l + 1;
                        self.ifr &= ~TIMER2INT;
                        self.updateIFR();
                        self.t2hit = false;
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

                read: function (addr) {
                    var temp;
                    switch (addr & 0xf) {
                    case ORA:
                        self.ifr &= ~INT_CA1;
                        if ((self.pcr & 0xa) != 0x2)
                            self.ifr &= ~INT_CA2;
                        self.updateIFR();
                        /* falls through */
                    case ORAnh:
                        temp = self.ora & self.ddra;
                        if (self.acr & 1)
                            return temp | (self.ira & ~self.ddra);
                        else
                            return temp | (self.readPortA() & ~self.ddra);
                        break;

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
                        break;

                    case DDRA:
                        return self.ddra;
                    case DDRB:
                        return self.ddrb;
                    case T1LL:
                        return ((self.t1l & 0x1fe) >>> 1) & 0xff;
                    case T1LH:
                        return (self.t1l >>> 9) & 0xff;

                    case T1CL:
                        if (!(self.justhit & 1)) {
                            self.ifr &= ~TIMER1INT;
                            self.updateIFR();
                        }
                        return ((self.t1c + 1) >>> 1) & 0xff;

                    case T1CH:
                        return ((self.t1c + 1) >>> 9) & 0xff;

                    case T2CL:
                        if (!(self.justhit & 2)) {
                            self.ifr &= ~TIMER2INT;
                            self.updateIFR();
                        }
                        return ((self.t2c + 1) >>> 1) & 0xff;

                    case T2CH:
                        return ((self.t2c + 1) >>> 9) & 0xff;

                    case SR:
                        return self.sr;
                    case ACR:
                        return self.acr;
                    case PCR:
                        return self.pcr;
                    case IER:
                        return self.ier | 0x80;
                    case IFR:
                        return self.ifr;
                    default:
                        throw "Unknown VIA read";
                    }
                },

                setca1: function (val) {
                    var level = !!val;
                    if (level === self.ca1) return;
                    var pcrSet = !!(self.pcr & 1);
                    if (pcrSet === level) {
                        if (self.acr & 1) self.ira = self.readPortA();
                        self.ifr |= INT_CA1;
                        self.updateIFR();
                        if ((self.pcr & 0xc) == 0x8) { // handshaking
                            self.setca2(1);
                        }
                    }
                    self.ca1 = level;
                },

                setca2: function (val) {
                    var level = !!val;
                    if (level === self.ca2) return;
                    if (self.pcr & 8) return; // output
                    var pcrSet = !!(self.pcr & 4);
                    if (pcrSet === level) {
                        self.ifr |= INT_CA2;
                        self.updateIFR();
                    }
                    self.ca2 = level;
                },

                setcb1: function (val) {
                    var level = !!val;
                    if (level === self.cb1) return;
                    var pcrSet = !!(self.pcr & 0x10);
                    if (pcrSet === level) {
                        if (self.acr & 2) self.irb = self.readPortB();
                        self.ifr |= INT_CB1;
                        self.updateIFR();
                        if ((self.pcr & 0xc0) == 0x80) { // handshaking
                            self.setcb2(1);
                        }
                    }
                    self.cb1 = level;
                },

                setcb2: function (val) {
                    var level = !!val;
                    if (level === self.cb2) return;
                    if (self.pcr & 0x80) return; // output
                    var pcrSet = !!(self.pcr & 0x40);
                    if (pcrSet === level) {
                        self.ifr |= INT_CB2;
                        self.updateIFR();
                    }
                    self.cb2 = level;
                }
        };
        return self;
    }

    function sysvia(cpu, soundChip, cmos, isMaster) {
        "use strict";
        var self = via(cpu, 0x01);

        self.IC32 = 0;
        self.keycol = 0;
        self.keyrow = 0;
        self.sdbout = 0;
        self.sdbval = 0;
        self.scrsize = 0;
        self.capsLockLight = false;
        self.shiftLockLight = false;
        self.getScrSize = function () {
            return self.scrsize;
        };
        self.keys = [];
        for (var i = 0; i < 16; ++i) {
            self.keys[i] = new Uint8Array(16);
        }

        self.setVBlankInt = self.setca1;

        function detectKeyboardLayout() {
            if (utils.runningInNode) {
                return "UK";
            }
            if (localStorage.keyboardLayout) {
                return localStorage.keyboardLayout;
            }
            if (navigator.language) {
                if (navigator.language.toLowerCase() == "en-gb") return "UK";
                if (navigator.language.toLowerCase() == "en-us") return "US";
            }
            return "UK";  // Default guess of UK
        }


        self.keycodeToRowCol = (function () {
            var keys = {};

            function map(s, colRow) {
                if ((!s  && s !== 0) || !colRow) {
                    console.log("error binding key", s, colRow);
                }
                if (typeof(s) == "string")
                    s = s.charCodeAt(0);
                if (keys[s]) console.log("Duplicate binding for key", s, colRow, keys[s]);
                keys[s] = colRow;
            }

            // With thanks to http://stackoverflow.com/questions/9847580/how-to-detect-safari-chrome-ie-firefox-and-opera-browser
            // Opera 8.0+ (UA detection to detect Blink/v8-powered Opera)
            var isFirefox = typeof InstallTrigger !== 'undefined';   // Firefox 1.0+
            var isUKlayout = detectKeyboardLayout() == "UK";

            var keyCodes = utils.keyCodes;
            var BBC = utils.BBC;

            console.log("isUKlayout", isUKlayout);

            if (isUKlayout) {

                map(keyCodes.HASH, BBC.HASH); // UK PC hash key maps to pound underscore
                map(keyCodes.BACKSLASH, BBC.PIPE_BACKSLASH); // pipe, backslash is pipe, backslash
                map(keyCodes.APOSTROPHE, BBC.COLON_STAR); // maps to :*

            } else {
                map(keyCodes.HASH, BBC.COLON_STAR); // maps to :*
                map(keyCodes.BACKSLASH, BBC.HASH); // pipe, backlash is underscore, pound
                map(keyCodes.APOSTROPHE, BBC.AT); // @ mapped to backtic
            }

            // hack for Matt's laptop (Firefox bug?)
            if (isFirefox) {
                // Mike's UK Windows laptop returns 20 in Chrome and Firefox for Caps Lock
                // TODO: 225 is definitely strange
                map(225, BBC.CAPSLOCK); 
            } 


            var BBC = utils.BBC;

            map(keyCodes.EQUALS, BBC.HAT_TILDE); // ^~ on +/=
            map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS); // ';' / '+'
            map(keyCodes.MINUS, BBC.MINUS); // '-' / '=' mapped to underscore
            map(keyCodes.LEFT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET); // maps to [{
            map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.RIGHT_SQUARE_BRACKET); // maps to ]}
            map(keyCodes.COMMA, BBC.COMMA); // ',' / '<'
            map(keyCodes.PERIOD, BBC.PERIOD); // '.' / '>'
            map(keyCodes.SLASH, BBC.SLASH); // '/' / '?'
            map(keyCodes.WINDOWS, BBC.SHIFTLOCK); // shift lock mapped to "windows" key
            map(keyCodes.TAB, BBC.TAB); // tab
            map(keyCodes.ENTER, BBC.RETURN); // return
            map(keyCodes.DELETE, BBC.DELETE); // delete
            map(keyCodes.BACKSPACE, BBC.DELETE); // delete
            map(keyCodes.END, BBC.COPY); // copy key is end
            map(keyCodes.F11, BBC.COPY); // copy key is end for Apple
            map(keyCodes.SHIFT, BBC.SHIFT); // shift
            map(keyCodes.ESCAPE, BBC.ESCAPE); // escape
            map(keyCodes.CTRL, BBC.CTRL); // control
            map(keyCodes.CAPSLOCK, BBC.CAPSLOCK); // caps (on Rich's/Mike's computer)
            map(keyCodes.LEFT, BBC.LEFT); // arrow left
            map(keyCodes.UP, BBC.UP); // arrow up
            map(keyCodes.RIGHT, BBC.RIGHT); // arrow right
            map(keyCodes.DOWN, BBC.DOWN); // arrow down

            map(keyCodes.K0, BBC.K0);
            map(keyCodes.K1, BBC.K1);
            map(keyCodes.K2, BBC.K2);
            map(keyCodes.K3, BBC.K3);
            map(keyCodes.K4, BBC.K4);
            map(keyCodes.K5, BBC.K5);
            map(keyCodes.K6, BBC.K6);
            map(keyCodes.K7, BBC.K7);
            map(keyCodes.K8, BBC.K8);
            map(keyCodes.K9, BBC.K9);

            map(keyCodes.Q, BBC.Q);
            map(keyCodes.W, BBC.W);
            map(keyCodes.E, BBC.E);
            map(keyCodes.R, BBC.R);
            map(keyCodes.T, BBC.T);
            map(keyCodes.Y, BBC.Y);
            map(keyCodes.U, BBC.U);
            map(keyCodes.I, BBC.I);
            map(keyCodes.O, BBC.O);
            map(keyCodes.P, BBC.P);


            map(keyCodes.A, BBC.A);
            map(keyCodes.S, BBC.S);
            map(keyCodes.D, BBC.D);
            map(keyCodes.F, BBC.F);
            map(keyCodes.G, BBC.G);
            map(keyCodes.H, BBC.H);
            map(keyCodes.J, BBC.J);
            map(keyCodes.K, BBC.K);
            map(keyCodes.L, BBC.L);

            map(keyCodes.Z, BBC.Z);
            map(keyCodes.X, BBC.X);
            map(keyCodes.C, BBC.C);
            map(keyCodes.V, BBC.V);
            map(keyCodes.B, BBC.B);
            map(keyCodes.N, BBC.N);
            map(keyCodes.M, BBC.M);

            map(keyCodes.F10, BBC.F0); // F0 (mapped to F10)
            map(keyCodes.F1, BBC.F1); 
            map(keyCodes.F2, BBC.F2); 
            map(keyCodes.F3, BBC.F3); 
            map(keyCodes.F4, BBC.F4); 
            map(keyCodes.F5, BBC.F5); 
            map(keyCodes.F6, BBC.F6); 
            map(keyCodes.F7, BBC.F7); 
            map(keyCodes.F8, BBC.F8); 
            map(keyCodes.F9, BBC.F9); 

            map(keyCodes.BACK_QUOTE, BBC.ESCAPE); // top left UK keyboard -> Escape

            map(keyCodes.SPACE, BBC.SPACE);
            
            // Master
            map(keyCodes.NUMPAD0, BBC.NUMPAD0);
            map(keyCodes.NUMPAD1, BBC.NUMPAD1);
            map(keyCodes.NUMPAD2, BBC.NUMPAD2);
            map(keyCodes.NUMPAD3, BBC.NUMPAD3);
            map(keyCodes.NUMPAD4, BBC.NUMPAD4);
            map(keyCodes.NUMPAD5, BBC.NUMPAD5);
            map(keyCodes.NUMPAD6, BBC.NUMPAD6);
            map(keyCodes.NUMPAD7, BBC.NUMPAD7);
            map(keyCodes.NUMPAD8, BBC.NUMPAD8);
            map(keyCodes.NUMPAD9, BBC.NUMPAD9);
            // small hack in main.js/keyCode() to make this work (Chrome only)
            map(keyCodes.NUMPAD_DECIMAL_POINT, BBC.NUMPAD_DECIMAL_POINT);
           
            // "natural" mapping
            map(keyCodes.NUMPADPLUS, BBC.NUMPADPLUS);
            map(keyCodes.NUMPADMINUS, BBC.NUMPADMINUS);
            map(keyCodes.NUMPADSLASH, BBC.NUMPADSLASH);
            map(keyCodes.NUMPADASTERISK, BBC.NUMPADASTERISK);
            //map(???, BBC.NUMPADCOMMA);
            //map(???, BBC.NUMPADHASH);
            // no keycode for NUMPADENTER, small hack in main.js/keyCode() (Chrome only)
            map(keyCodes.NUMPADENTER, BBC.NUMPADENTER);
            
            // TODO: "game" mapping
            // eg Master Dunjunz needs # Del 3 , * Enter
            // https://web.archive.org/web/20080305042238/http://bbc.nvg.org/doc/games/Dunjunz-docs.txt
            
            return keys;
        })();
        
        self.keyboardEnabled = true;
        
        self.set = function (key, val) {

            if (!self.keyboardEnabled) {
                return;
            }

            console.log("key code: " + key);
            var colrow = self.keycodeToRowCol[key];
            if (!colrow) {
                console.log("Unknown keycode: " + key);
                console.log("Please check here: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.keyCode");
                return;
            }

            self.keys[colrow[0]][colrow[1]] = val;
            self.updateKeys();
        };
        self.keyDown = function (key) {
            self.set(key, 1);
        };
        self.keyUp = function (key) {
            self.set(key, 0);
        };

        self.keyDownRaw = function (colrow) {
            self.keys[colrow[0]][colrow[1]] = 1;
            self.updateKeys();
        };
        self.keyUpRaw = function (colrow) {
            self.keys[colrow[0]][colrow[1]] = 0;
            self.updateKeys();
        };
        self.keyToggleRaw = function (colrow) {
            self.keys[colrow[0]][colrow[1]] = 1 - self.keys[colrow[0]][colrow[1]];
            self.updateKeys();
        };

        self.updateKeys = function () {
            // 10 for BBC, 13 for Master 128
            var numCols = 13;
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

        self.updateSdb = function () {
            self.sdbval = self.sdbout;
            if (isMaster) self.sdbval &= cmos.read(self.IC32);
            var keyrow = (self.sdbval >>> 4) & 7;
            self.keycol = self.sdbval & 0xf;
            self.updateKeys();
            if (!(self.IC32 & 8) && !self.keys[self.keycol][keyrow]) {
                self.sdbval &= 0x7f;
            }
        };

        self.writeIC32 = function (val) { // addressable latch
            var oldIC32 = self.IC32;
            if (val & 8)
                self.IC32 |= (1 << (val & 7));
            else
                self.IC32 &= ~(1 << (val & 7));

            self.updateSdb();
            if (!(self.IC32 & 1) && (oldIC32 & 1))
                soundChip.poke(self.sdbval);

            self.capsLockLight = !(self.IC32 & 0x40);
            self.shiftLockLight = !(self.IC32 & 0x80);

            self.scrsize = ((self.IC32 & 16) ? 2 : 0) | ((self.IC32 & 32) ? 1 : 0);
            if (isMaster) cmos.write(self.IC32, self.sdbval);
        };

        self.writePortA = function (val) {
            self.sdbout = val;
            self.updateSdb();
            if (isMaster) cmos.write(self.IC32, self.sdbval);
        };

        self.writePortB = function (val) {
            self.writeIC32(val);
            if (isMaster) cmos.writeAddr(val, self.sdbval);
        };

        self.readPortA = function () {
            self.updateSdb();
            return self.sdbval;
        };

        self.readPortB = function () {
            return 0xff;
        };

        self.reset();
        return self;
    }

    function uservia(cpu, isMaster) {
        "use strict";
        var self = via(cpu, 0x02);

        self.writePortA = function (val) {
            // printer port
        };

        self.writePortB = function (val) {
            // user port
        };

        self.readPortA = function () {
            return 0xff; // printer port
        };

        self.readPortB = function () {
            return 0xff; // user port (TODO: mouse, compact joystick)
        };
        self.reset();
        return self;
    }

    return {
        UserVia: uservia,
        SysVia: sysvia
    };
});