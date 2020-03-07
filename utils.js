define(['jsunzip', 'promise'], function (jsunzip) {
    "use strict";
    var exports = {};

    exports.runningInNode = typeof window === 'undefined';

    exports.isFirefox = function () {
        // With thanks to http://stackoverflow.com/questions/9847580/how-to-detect-safari-chrome-ie-firefox-and-opera-browser
        // Opera 8.0+ (UA detection to detect Blink/v8-powered Opera)
        return typeof InstallTrigger !== 'undefined';   // Firefox 1.0+
    };

    exports.parseAddr = function (s) {
        if (s[0] === '$' || s[0] === '&') return parseInt(s.substr(1), 16);
        if (s.indexOf("0x") === 0) return parseInt(s.substr(2), 16);
        return parseInt(s, 16);
    };

    exports.userKeymap = [];

    exports.BBC = {
        SEMICOLON_PLUS: [7, 5],
        MINUS: [7, 1],
        LEFT_SQUARE_BRACKET: [8, 3],
        RIGHT_SQUARE_BRACKET: [8, 5],
        COMMA: [6, 6],
        PERIOD: [7, 6],
        SLASH: [8, 6],
        SHIFTLOCK: [0, 5],
        TAB: [0, 6],
        RETURN: [9, 4],
        DELETE: [9, 5],
        COPY: [9, 6],
        SHIFT: [0, 0],
        ESCAPE: [0, 7],
        CTRL: [1, 0],
        CAPSLOCK: [0, 4],
        LEFT: [9, 1],
        UP: [9, 3],
        RIGHT: [9, 7],
        DOWN: [9, 2],
        K0: [7, 2],
        K1: [0, 3],
        K2: [1, 3],
        K3: [1, 1],
        K4: [2, 1],
        K5: [3, 1],
        K6: [4, 3],
        K7: [4, 2],
        K8: [5, 1],
        K9: [6, 2],

        Q: [0, 1],
        W: [1, 2],
        E: [2, 2],
        R: [3, 3],
        T: [3, 2],
        Y: [4, 4],
        U: [5, 3],
        I: [5, 2],
        O: [6, 3],
        P: [7, 3],

        A: [1, 4],
        S: [1, 5],
        D: [2, 3],
        F: [3, 4],
        G: [3, 5],
        H: [4, 5],
        J: [5, 4],
        K: [6, 4],
        L: [6, 5],

        Z: [1, 6],
        X: [2, 4],
        C: [2, 5],
        V: [3, 6],
        B: [4, 6],
        N: [5, 5],
        M: [5, 6],

        F0: [0, 2],
        F1: [1, 7],
        F2: [2, 7],
        F3: [3, 7],
        F4: [4, 1],
        F5: [4, 7],
        F6: [5, 7],
        F7: [6, 1],
        F8: [6, 7],
        F9: [7, 7],

        SPACE: [2, 6],

        UNDERSCORE_POUND: [8, 2],
        AT: [7, 4],
        COLON_STAR: [8, 4],
        PIPE_BACKSLASH: [8, 7],
        HAT_TILDE: [8, 1],

        // row 1
        NUMPADPLUS: [10, 3],
        NUMPADMINUS: [11, 3],
        NUMPADSLASH: [10, 4],
        NUMPADASTERISK: [11, 5],

        // row 2
        NUMPAD7: [11, 1],
        NUMPAD8: [10, 2],
        NUMPAD9: [11, 2],
        NUMPADHASH: [10, 5],
        // row 3
        NUMPAD4: [10, 7],
        NUMPAD5: [11, 7],
        NUMPAD6: [10, 1],
        NUMPAD_DELETE: [11, 4],
        //row4
        NUMPAD1: [11, 6],
        NUMPAD2: [12, 7],
        NUMPAD3: [12, 6],
        NUMPADCOMMA: [12, 5],

        //row 5
        NUMPAD0: [10, 6],
        NUMPAD_DECIMAL_POINT: [12, 4],
        NUMPADENTER: [12, 3],


    };

    exports.stringToBBCKeys = function(str) {
        var BBC = exports.BBC;
        var array = [];
        var i;
        var shiftState = false;
        var capsLockState = true;
        for (i = 0; i < str.length; ++i) {
            var c = str.charCodeAt(i);
            var charStr = str.charAt(i);
            var bbcKey = null;
            var needsShift = false;
            var needsCapsLock = true;
            if (c >= 65 && c <= 90) {
                // A-Z
                bbcKey = BBC[charStr];
            } else if (c >= 97 && c <= 122) {
                // a-z
                charStr = String.fromCharCode(c - 32);
                bbcKey = BBC[charStr];
                needsCapsLock = false;
            } else if (c >= 48 && c <= 57) {
                // 0-9
                bbcKey = BBC["K" + charStr];
            } else if (c >= 33 && c <= 41) {
                // ! to )
                charStr = String.fromCharCode(c + 16);
                bbcKey = BBC["K" + charStr];
                needsShift = true;
            } else {
                switch (charStr) {
                case '\n':
                    bbcKey = BBC.RETURN;
                    break;
                case '\t':
                    bbcKey = BBC.TAB;
                    break;
                case ' ':
                    bbcKey = BBC.SPACE;
                    break;
                case '-':
                    bbcKey = BBC.MINUS;
                    break;
                case '=':
                    bbcKey = BBC.MINUS; needsShift = true;
                    break;
                case '^':
                    bbcKey = BBC.HAT_TILDE;
                    break;
                case '~':
                    bbcKey = BBC.HAT_TILDE; needsShift = true;
                    break;
                case '\\':
                    bbcKey = BBC.PIPE_BACKSLASH;
                    break;
                case '|':
                    bbcKey = BBC.PIPE_BACKSLASH; needsShift = true;
                    break;
                case '@':
                    bbcKey = BBC.AT;
                    break;
                case '[':
                    bbcKey = BBC.LEFT_SQUARE_BRACKET;
                    break;
                case '{':
                    bbcKey = BBC.LEFT_SQUARE_BRACKET; needsShift = true;
                    break;
                case '_':
                    bbcKey = BBC.UNDERSCORE_POUND;
                    break;
                case ';':
                    bbcKey = BBC.SEMICOLON_PLUS;
                    break;
                case '+':
                    bbcKey = BBC.SEMICOLON_PLUS; needsShift = true;
                    break;
                case ':':
                    bbcKey = BBC.COLON_STAR;
                    break;
                case '*':
                    bbcKey = BBC.COLON_STAR; needsShift = true;
                    break;
                case ']':
                    bbcKey = BBC.RIGHT_SQUARE_BRACKET;
                    break;
                case '}':
                    bbcKey = BBC.RIGHT_SQUARE_BRACKET; needsShift = true;
                    break;
                case ',':
                    bbcKey = BBC.COMMA;
                    break;
                case '<':
                    bbcKey = BBC.COMMA; needsShift = true;
                    break;
                case '.':
                    bbcKey = BBC.PERIOD;
                    break;
                case '>':
                    bbcKey = BBC.PERIOD; needsShift = true;
                    break;
                case '/':
                    bbcKey = BBC.SLASH;
                    break;
                case '?':
                    bbcKey = BBC.SLASH; needsShift = true;
                    break;
                }
            }

            if (!bbcKey) continue;

            if ((needsShift && !shiftState) || (!needsShift && shiftState)) {
                array.push(BBC.SHIFT);
                shiftState = !shiftState;
            }
            if ((needsCapsLock && !capsLockState) || (!needsCapsLock && capsLockState)) {
                array.push(BBC.CAPSLOCK);
                capsLockState = !capsLockState;
            }
            array.push(bbcKey);
        }

        if (shiftState) array.push(BBC.SHIFT);
        if (!capsLockState) array.push(BBC.CAPSLOCK);
        return array;
    };

    /**
     * Useful references:
     * http://www.cambiaresearch.com/articles/15/javascript-char-codes-key-codes
     * https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.keyCode
     */
    exports.keyCodes = {
        UNDEFINED: 0,
        BACKSPACE: 8,
        TAB: 9,
        CLEAR: 12,
        ENTER: 13,
        SHIFT: 16,
        CTRL: 17,
        ALT: 18,
        BREAK: 19,
        CAPSLOCK: 20,
        ESCAPE: 27,
        SPACE: 32,
        PAGEUP: 33,
        PAGEDOWN: 34,
        END: 35,
        HOME: 36,
        LEFT: 37,
        UP: 38,
        RIGHT: 39,
        DOWN: 40,
        PRINTSCREEN: 44,
        INSERT: 45,
        DELETE: 46,
        K0: 48,
        K1: 49,
        K2: 50,
        K3: 51,
        K4: 52,
        K5: 53,
        K6: 54,
        K7: 55,
        K8: 56,
        K9: 57,
        A: 65,
        B: 66,
        C: 67,
        D: 68,
        E: 69,
        F: 70,
        G: 71,
        H: 72,
        I: 73,
        J: 74,
        K: 75,
        L: 76,
        M: 77,
        N: 78,
        O: 79,
        P: 80,
        Q: 81,
        R: 82,
        S: 83,
        T: 84,
        U: 85,
        V: 86,
        W: 87,
        X: 88,
        Y: 89,
        Z: 90,
        /* also META on Mac */
        WINDOWS: 91,
        MENU: 93,
        NUMPAD0: 96,
        NUMPAD1: 97,
        NUMPAD2: 98,
        NUMPAD3: 99,
        NUMPAD4: 100,
        NUMPAD5: 101,
        NUMPAD6: 102,
        NUMPAD7: 103,
        NUMPAD8: 104,
        NUMPAD9: 105,
        NUMPADASTERISK: 106,
        NUMPADPLUS: 107,
        /* on numeric keypad in eg Germany*/
        NUMPAD_DECIMAL_COMMA: 108,
        NUMPADMINUS: 109,
        /* on numeric keypad */
        NUMPAD_DECIMAL_POINT: 110,
        NUMPADSLASH: 111,
        F1: 112,
        F2: 113,
        F3: 114,
        F4: 115,
        F5: 116,
        F6: 117,
        F7: 118,
        F8: 119,
        F9: 120,
        F10: 121,
        F11: 122,
        F12: 123,
        NUMLOCK: 144,
        SCROLL_LOCK: 145,
        VOLUMEUP: 174,
        VOLUMEDOWN: 175,
        FASTFORWARD: 176,
        FASTREWIND: 177,
        PLAYPAUSE: 179,
        COMMA: 188,
        PERIOD: 190,
        SLASH: 191,
        LEFT_SQUARE_BRACKET: 219,
        BACKSLASH: 220,
        RIGHT_SQUARE_BRACKET: 221,
        NUMPADENTER: 255, // hack, jsbeeb only
        SHIFT_LEFT: 256, // hack, jsbeeb only
        SHIFT_RIGHT: 257, // hack, jsbeeb only
        ALT_LEFT: 258, // hack, jsbeeb only
        ALT_RIGHT: 259, // hack, jsbeeb only
        CTRL_LEFT: 260, // hack, jsbeeb only
        CTRL_RIGHT: 261 // hack, jsbeeb only
    };

    var keyCodes = exports.keyCodes;

    function detectKeyboardLayout() {
        if (exports.runningInNode) {
            return "UK";
        }
        if (localStorage.keyboardLayout) {
            return localStorage.keyboardLayout === "US" ? "US" : "UK";
        }
        if (navigator.language) {
            if (navigator.language.toLowerCase() === "en-gb") return "UK";
            if (navigator.language.toLowerCase() === "en-us") return "US";
        }
        return "UK";  // Default guess of UK
    }

    var isUKlayout = detectKeyboardLayout() === "UK";

    if (exports.isFirefox()) {
        keyCodes.SEMICOLON = 59;
        // #~ key (not on US keyboard)
        keyCodes.HASH = 163;
        keyCodes.APOSTROPHE = 222;
        keyCodes.BACK_QUOTE = 192;
        // Firefox doesn't return a keycode for this
        keyCodes.MUTE = -1;
        keyCodes.MINUS = 173;
        keyCodes.EQUALS = 61;
    } else {
        // Chrome
        // TODO: check other browsers
        // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.keyCode
        keyCodes.SEMICOLON = 186;
        // #~ key (not on US keyboard)
        keyCodes.HASH = isUKlayout ? 222 : 223;
        keyCodes.APOSTROPHE = isUKlayout ? 192 : 222;
        keyCodes.MUTE = 173;
        keyCodes.MINUS = 189;
        keyCodes.EQUALS = 187;
        keyCodes.BACK_QUOTE = isUKlayout ? 223 : 192;
    }

    // Swap APOSTROPHE and BACK_QUOTE keys around for Mac users.  They are the opposite to what jsbeeb expects.
    // Swap them to what jsbeeb expects, and tidy up the hash key to prevent duplicate key mappings.
    if (!exports.runningInNode && window.navigator.userAgent.indexOf("Mac") !== -1) {
        keyCodes.BACK_QUOTE = 192;
        keyCodes.APOSTROPHE = 222;
        keyCodes.HASH = 223;
    }

    exports.getKeyMap = function (keyLayout) {
        var keys2 = [];

        // shift pressed
        keys2[true] = {};

        // shift not pressed
        keys2[false] = {};

        // shiftDown MUST be true or false (not undefined)
        function doMap(s, colRow, shiftDown) {
            if (keys2[shiftDown][s] && keys2[shiftDown][s] !== colRow) {
                console.log("Warning: duplicate binding for key", (shiftDown ? "<SHIFT>" : "") + s, colRow, keys2[shiftDown][s]);
            }
            keys2[shiftDown][s] = colRow;
        }

        // shiftDown undefined -> map both
        function map(s, colRow, shiftDown) {

            if ((!s && s !== 0) || !colRow) {
                console.log("error binding key", s, colRow);
            }
            if (typeof s === "string") {
                s = s.charCodeAt(0);
            }

            if (shiftDown === undefined) {
                doMap(s, colRow, true);
                doMap(s, colRow, false);
            } else {
                doMap(s, colRow, shiftDown);
            }
        }

        var BBC = exports.BBC;

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

        // these keys are in the same place on PC and BBC keyboards
        // including shifted characters
        // so can be the same for "natural" and "gaming"
        map(keyCodes.COMMA, BBC.COMMA);
        map(keyCodes.PERIOD, BBC.PERIOD);
        map(keyCodes.SLASH, BBC.SLASH);
        map(keyCodes.SPACE, BBC.SPACE);
        map(keyCodes.TAB, BBC.TAB);
        map(keyCodes.ENTER, BBC.RETURN);

        map(keyCodes.SHIFT, BBC.SHIFT);
        // see later map(keyCodes.SHIFT_LEFT, BBC.SHIFT_LEFT);
        map(keyCodes.SHIFT_RIGHT, BBC.SHIFT);

        // other keys to map to these in "game" layout too
        map(keyCodes.LEFT, BBC.LEFT);
        map(keyCodes.UP, BBC.UP);
        map(keyCodes.RIGHT, BBC.RIGHT);
        map(keyCodes.DOWN, BBC.DOWN);

        if (keyLayout === "natural") {

            // "natural" keyboard

            map(keyCodes.SHIFT_LEFT, BBC.SHIFT);

            // US Keyboard: has Tilde on <Shift>BACK_QUOTE
            map(keyCodes.BACK_QUOTE, isUKlayout ? BBC.UNDERSCORE_POUND : BBC.HAT_TILDE);
            map(keyCodes.APOSTROPHE, isUKlayout ? BBC.AT : BBC.K2, true);
            map(keyCodes.K2, isUKlayout ? BBC.K2 : BBC.AT, true);

            // 1st row
            map(keyCodes.K3, BBC.UNDERSCORE_POUND, true);
            map(keyCodes.K7, BBC.K6, true);
            map(keyCodes.K8, BBC.COLON_STAR, true);
            map(keyCodes.K9, BBC.K8, true);
            map(keyCodes.K0, BBC.K9, true);

            map(keyCodes.K2, BBC.K2, false);
            map(keyCodes.K3, BBC.K3, false);
            map(keyCodes.K7, BBC.K7, false);
            map(keyCodes.K8, BBC.K8, false);
            map(keyCodes.K9, BBC.K9, false);
            map(keyCodes.K0, BBC.K0, false);

            map(keyCodes.K1, BBC.K1);
            map(keyCodes.K4, BBC.K4);
            map(keyCodes.K5, BBC.K5);
            map(keyCodes.K6, BBC.K6);

            map(keyCodes.MINUS, BBC.MINUS);

            // 2nd row
            map(keyCodes.LEFT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET);

            map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.RIGHT_SQUARE_BRACKET);

            // 3rd row

            map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS);

            map(keyCodes.APOSTROPHE, BBC.COLON_STAR, false);

            map(keyCodes.HASH, BBC.HAT_TILDE); // OK for <Shift> at least

            map(keyCodes.EQUALS, BBC.SEMICOLON_PLUS); // OK for <Shift> at least

            map(keyCodes.WINDOWS, BBC.SHIFTLOCK);

            map(keyCodes.END, BBC.COPY);

            map(keyCodes.F11, BBC.COPY);

            map(keyCodes.ESCAPE, BBC.ESCAPE);

            map(keyCodes.CTRL, BBC.CTRL);
            map(keyCodes.CTRL_LEFT, BBC.CTRL);
            map(keyCodes.CTRL_RIGHT, BBC.CTRL);

            map(keyCodes.CAPSLOCK, BBC.CAPSLOCK);

            map(keyCodes.DELETE, BBC.DELETE);

            map(keyCodes.BACKSPACE, BBC.DELETE);

            map(keyCodes.BACKSLASH, BBC.PIPE_BACKSLASH);

        } else if (keyLayout === "gaming") {
            // gaming keyboard

            // 1st row
            map(keyCodes.ESCAPE, BBC.F0);

            // 2nd row
            map(keyCodes.BACK_QUOTE, BBC.ESCAPE);
            map(keyCodes.K1, BBC.K1);
            map(keyCodes.K2, BBC.K2);
            map(keyCodes.K3, BBC.K3);
            map(keyCodes.K4, BBC.K4);
            map(keyCodes.K5, BBC.K5);
            map(keyCodes.K6, BBC.K6);
            map(keyCodes.K7, BBC.K7);
            map(keyCodes.K8, BBC.K8);
            map(keyCodes.K9, BBC.K9);
            map(keyCodes.K0, BBC.K0);
            map(keyCodes.MINUS, BBC.MINUS);
            map(keyCodes.EQUALS, BBC.HAT_TILDE);
            map(keyCodes.BACKSPACE, BBC.PIPE_BACKSLASH);
            map(keyCodes.INSERT, BBC.LEFT);
            map(keyCodes.HOME, BBC.RIGHT);

            // 3rd row
            map(keyCodes.LEFT_SQUARE_BRACKET, BBC.AT);
            map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET);
            // no key for BBC.UNDERSCORE_POUND in UK
            // see 4th row for US mapping keyCodes.BACKSLASH
            map(keyCodes.DELETE, BBC.UP);
            map(keyCodes.END, BBC.DOWN);

            // 4th row
            // no key for BBC.CAPSLOCK (mapped to CTRL_LEFT below)
            map(keyCodes.CAPSLOCK, BBC.CTRL);
            map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS);
            map(keyCodes.APOSTROPHE, BBC.COLON_STAR);
            // UK keyboard (key missing on US)
            map(keyCodes.HASH, BBC.RIGHT_SQUARE_BRACKET);

            // UK has extra key \| for SHIFT
            map(keyCodes.SHIFT_LEFT, isUKlayout ? BBC.SHIFTLOCK : BBC.SHIFT);
            // UK: key is between SHIFT and Z
            // US: key is above ENTER
            map(keyCodes.BACKSLASH, isUKlayout ? BBC.SHIFT : BBC.UNDERSCORE_POUND);

            // 5th row

            // for Zalaga
            map(keyCodes.CTRL_LEFT, BBC.CAPSLOCK);
            map(keyCodes.ALT_LEFT, BBC.CTRL);

            // should be 4th row, not enough keys
            map(keyCodes.MENU, BBC.DELETE);
            map(keyCodes.CTRL_RIGHT, BBC.COPY);

            // not in correct location
            map(keyCodes.ALT_RIGHT, BBC.SHIFTLOCK);
            map(keyCodes.WINDOWS, BBC.SHIFTLOCK);
        } else {
            // Physical, and default
            map(keyCodes.K1, BBC.K1);
            map(keyCodes.K2, BBC.K2);
            map(keyCodes.K3, BBC.K3);
            map(keyCodes.K4, BBC.K4);
            map(keyCodes.K5, BBC.K5);
            map(keyCodes.K6, BBC.K6);
            map(keyCodes.K7, BBC.K7);
            map(keyCodes.K8, BBC.K8);
            map(keyCodes.K9, BBC.K9);
            map(keyCodes.K0, BBC.K0);
            map(keyCodes.SHIFT_LEFT, BBC.SHIFT);
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
            map(keyCodes.CTRL, BBC.CTRL);
            map(keyCodes.CTRL_LEFT, BBC.CTRL);
            map(keyCodes.CTRL_RIGHT, BBC.CTRL);
            map(keyCodes.CAPSLOCK, BBC.CAPSLOCK); // caps (on Rich's/Mike's computer)
            map(keyCodes.LEFT, BBC.LEFT); // arrow left
            map(keyCodes.UP, BBC.UP); // arrow up
            map(keyCodes.RIGHT, BBC.RIGHT); // arrow right
            map(keyCodes.DOWN, BBC.DOWN); // arrow down
            map(keyCodes.APOSTROPHE, BBC.COLON_STAR);
            map(keyCodes.HASH, BBC.RIGHT_SQUARE_BRACKET);

            // None of this last group in great locations.
            // But better to have them mapped at least somewhere.
            map(keyCodes.BACK_QUOTE, BBC.AT);
            map(keyCodes.BACKSLASH, BBC.PIPE_BACKSLASH);
            map(keyCodes.PAGEUP, BBC.UNDERSCORE_POUND);
        }

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
        // small hack in main.js/keyCode() to make this work 
        map(keyCodes.NUMPAD_DECIMAL_POINT, BBC.NUMPAD_DECIMAL_POINT);

        // "natural" mapping
        map(keyCodes.NUMPADPLUS, BBC.NUMPADPLUS);
        map(keyCodes.NUMPADMINUS, BBC.NUMPADMINUS);
        map(keyCodes.NUMPADSLASH, BBC.NUMPADSLASH);
        map(keyCodes.NUMPADASTERISK, BBC.NUMPADASTERISK);
        //map(???, BBC.NUMPADCOMMA);
        //map(???, BBC.NUMPADHASH);
        // no keycode for NUMPADENTER, small hack in main.js/keyCode()
        map(keyCodes.NUMPADENTER, BBC.NUMPADENTER);

        // TODO: "game" mapping
        // eg Master Dunjunz needs # Del 3 , * Enter
        // https://web.archive.org/web/20080305042238/http://bbc.nvg.org/doc/games/Dunjunz-docs.txt

        // user keymapping
        // do last (to override defaults)
        while (exports.userKeymap.length > 0) {
            var mapping = exports.userKeymap.pop();
            map(keyCodes[mapping.native], BBC[mapping.bbc]);
        }

        return keys2;
    };

    function hexbyte(value) {
        return ((value >>> 4) & 0xf).toString(16) + (value & 0xf).toString(16);
    }

    exports.hexbyte = hexbyte;

    function hexword(value) {
        return hexbyte(value >>> 8) + hexbyte(value & 0xff);
    }

    exports.hexword = hexword;

    function hd(reader, start, end, opts) {
        opts = opts || {};
        var width = opts.width || 16;
        var gap = opts.gap === undefined ? 8 : opts.gap;
        var res = [];
        var str = "";
        var j = 0;
        for (var i = start; i < end; ++i) {
            str += " ";
            str += hexbyte(reader(i));
            if (++j === gap) str += " ";
            if (j === width) {
                res.push(str);
                str = "";
                j = 0;
            }
        }
        if (str) res.push(str);
        var joined = "";
        for (i = 0; i < res.length; ++i) {
            joined += hexword(start + i * width) + " :" + res[i] + "\n";
        }
        return joined;
    }

    exports.hd = hd;

    var signExtendTable = (function () {
        var table = [];
        for (var i = 0; i < 256; ++i) table[i] = i >= 128 ? i - 256 : i;
        return table;
    })();

    function signExtend(val) {
        return signExtendTable[val | 0] | 0;
    }

    exports.signExtend = signExtend;

    exports.noop = function noop() {
    };

    exports.bench = function () {
        for (var j = 0; j < 10; ++j) {
            var res = 0;
            var start = Date.now();
            for (var i = 0; i < 4096 * 1024; ++i) {
                res += signExtend(i & 0xff);
            }
            var tt = Date.now() - start;
            console.log(res, tt);
        }
    };

    exports.noteEvent = function noteEvent(category, type, label) {
        if (!exports.runningInNode && window.location.origin === "https://bbc.godbolt.org") {
            // Only note events on the public site
            ga('send', 'event', category, type, label);
        }
        console.log('event noted:', category, type, label);
    };

    var baseUrl = "";
    exports.setBaseUrl = function (url) {
        baseUrl = url;
    };

    function uint8ArrayToString(array) {
        var str = "";
        for (var i = 0; i < array.length; ++i) str += String.fromCharCode(array[i]);
        return str;
    }

    exports.uint8ArrayToString = uint8ArrayToString;

    function stringToUint8Array(str) {
        if (str instanceof Uint8Array) return str;
        var len = str.length;
        var array = new Uint8Array(len);
        for (var i = 0; i < len; ++i) array[i] = str.charCodeAt(i) & 0xff;
        return array;
    }

    exports.stringToUint8Array = stringToUint8Array;

    function loadDataHttp(url) {
        return new Promise(function (resolve, reject) {
            var request = new XMLHttpRequest();
            request.open("GET", baseUrl + url, true);
            request.overrideMimeType('text/plain; charset=x-user-defined');
            request.onload = function () {
                if (request.status !== 200) reject(new Error("Unable to load " + url + ", http code " + request.status));
                if (typeof request.response !== "string") {
                    resolve(request.response);
                } else {
                    resolve(stringToUint8Array(request.response));
                }
            };
            request.onerror = function () {
                reject(new Error("A network error occurred loading " + url));
            };
            request.send(null);
        });
    }

    function loadDataNode(url) {
        return new Promise(function (resolve, reject) {
            if (typeof readbuffer !== "undefined") {
                // d8 shell
                var buffer = readbuffer(url); // jshint ignore:line
                resolve(new Uint8Array(buffer));
            } else if (typeof read !== "undefined") {
                // SpiderMonkey shell
                var bytes = read(url, "binary"); // jshint ignore:line
                resolve(bytes);
            } else {
                // Node
                var fs = require('fs');
                if (url[0] === '/') url = "." + url;
                resolve(fs.readFileSync(url));
            }
        });
    }

    if (exports.runningInNode) {
        exports.loadData = loadDataNode;
    } else {
        exports.loadData = loadDataHttp;
    }

    function readInt32(data, offset) {
        return (data[offset + 3] << 24)
            | (data[offset + 2] << 16)
            | (data[offset + 1] << 8)
            | (data[offset + 0]);
    }

    exports.readInt32 = readInt32;

    function readInt16(data, offset) {
        return (data[offset + 1] << 8)
            | (data[offset + 0]);
    }

    exports.readInt16 = readInt16;
    var tempBuf = new ArrayBuffer(4);
    var tempBuf8 = new Uint8Array(tempBuf);
    var tempBufF32 = new Float32Array(tempBuf);

    function readFloat32(data, offset) {
        tempBuf8[0] = data[offset];
        tempBuf8[1] = data[offset + 1];
        tempBuf8[2] = data[offset + 2];
        tempBuf8[3] = data[offset + 3];
        return tempBufF32[0];
    }

    exports.readFloat32 = readFloat32;

    function ungzip(data) {
        var tinf = new jsunzip.TINF();
        tinf.init();
        var results = [];
        while (data.length) {
            if (results.length > 1000) throw new Error("Seems like something went wrong");
            if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error("Corrupt data");
            var dataOffset = 10;
            if (data[3] & 0x02) dataOffset += 2; // Header CRC
            if (data[3] & 0x04) {
                dataOffset += 2 + readInt16(data, dataOffset); // FEXTRA
            }
            if (data[3] & 0x08) {
                while (data[dataOffset] !== 0) dataOffset++; // FILENAME
                dataOffset++;
            }
            if (data[3] & 0x10) {
                while (data[dataOffset] !== 0) dataOffset++; // FCOMMENT
                dataOffset++;
            }
            var maxDecompressSize = 16384;
            var result;
            for (; ;) {
                // Loop around trying to decompress this block, doubling in size if we can't fit a block.
                result = tinf.uncompress(data, dataOffset, maxDecompressSize);
                if (result.status !== 0) throw "Unable to ungzip";
                if (result.dataSize < maxDecompressSize) break;
                maxDecompressSize *= 2;
            }
            results.push(result.data.subarray(0, result.dataSize));
            var nextOffset = result.offset + 8; // skip CRC and uncompressed length
            data = data.subarray(nextOffset);
        }
        var total = results.reduce(function (prev, cur) {
            return prev + cur.length;
        }, 0);
        var finalData = new Uint8Array(total);
        var offset = 0;
        results.forEach(function (res) {
            finalData.set(res, offset);
            offset += res.length;
        });
        return finalData;
    }

    exports.ungzip = ungzip;

    function DataStream(name_, data_, dontUnzip_) {
        var self = this;
        self.name = name_;
        self.pos = 0;
        self.data = stringToUint8Array(data_);
        if (!dontUnzip_ && self.data && self.data.length > 4 && self.data[0] === 0x1f && self.data[1] === 0x8b) {
            console.log("Ungzipping " + name_);
            self.data = ungzip(self.data);
        }
        if (!self.data) {
            throw new Error("No data in " + name_);
        }

        self.end = self.data.length;

        self.bytesLeft = function () {
            return self.end - self.pos;
        };

        self.eof = function () {
            return self.bytesLeft() === 0;
        };

        self.advance = function (distance) {
            if (self.bytesLeft() < distance) throw new RangeError("EOF in " + self.name);
            self.pos += distance;
            return self.pos - distance;
        };

        self.readFloat32 = function (pos) {
            if (pos === undefined) pos = self.advance(4);
            return readFloat32(self.data, pos);
        };

        self.readInt32 = function (pos) {
            if (pos === undefined) pos = self.advance(4);
            return readInt32(self.data, pos);
        };

        self.readInt16 = function (pos) {
            if (pos === undefined) pos = self.advance(2);
            return readInt16(self.data, pos);
        };

        self.readByte = function (pos) {
            if (pos === undefined) pos = self.advance(1);
            return self.data[pos];
        };

        self.readNulString = function (pos, maxLength) {
            if (!maxLength) maxLength = 1024;
            var posToUse = pos === undefined ? self.pos : pos;
            var result = "";
            var c;
            while ((c = self.readByte(posToUse++)) !== 0 && --maxLength) {
                result += String.fromCharCode(c);
            }
            if (maxLength === 0) return "";
            if (pos === undefined) self.pos = posToUse;
            return result;
        };

        self.substream = function (posOrLength, length) {
            var pos;
            if (length === undefined) {
                length = posOrLength;
                pos = self.advance(length);
            } else {
                pos = posOrLength;
                if (pos + length >= self.end) throw new RangeError("EOF in " + self.name);
            }
            return new DataStream(self.name + ".sub", self.data.subarray(pos, pos + length));
        };

        self.seek = function (to) {
            if (to >= self.end) throw new RangeError("Seek out of range in " + self.name);
            self.pos = to;
        };
    }

    exports.DataStream = DataStream;

    exports.makeFast32 = function (u32) {
        // Firefox is ~5% faster with signed 32-bit arrays. Chrome is the same speed
        // either way, so here we unconditionally wrap all u32 buffers as i32.
        // Having a function do this makes it easy to test u32 vs i32, and means we
        // keep the rest of the code using u32 (which makes more sense to me).
        return new Int32Array(u32.buffer);
    };

    var knownDiscExtensions = {
        'uef': true,
        'ssd': true,
        'dsd': true
    };

    var knownRomExtensions = {
        'rom': true
    };

    function unzipImage(data, knownExtensions) {
        var unzip = new jsunzip.JSUnzip();
        console.log("Attempting to unzip");
        var result = unzip.open(data);
        if (!result.status) {
            throw new Error("Error unzipping " + result.error);
        }
        var uncompressed = null;
        var loadedFile;
        for (var f in unzip.files) {
            var match = f.match(/.*\.([a-z]+)/i);
            if (!match || !knownExtensions[match[1].toLowerCase()]) {
                console.log("Skipping file", f);
                continue;
            }
            if (uncompressed) {
                console.log("Ignoring", f, "as already found a file");
                continue;
            }
            loadedFile = f;
            uncompressed = unzip.read(f);
        }
        if (!uncompressed) {
            throw new Error("Couldn't find any compatible files in the archive");
        }
        if (!uncompressed.status) {
            throw new Error("Failed to uncompress file '" + loadedFile + "' - " + uncompressed.error);
        }
        console.log("Unzipped '" + loadedFile + "'");
        return {data: uncompressed.data, name: loadedFile};
    }

    exports.unzipDiscImage = function unzipDiscImage(data) {
        return unzipImage(data, knownDiscExtensions);
    };
    exports.unzipRomImage = function unzipDiscImage(data) {
        return unzipImage(data, knownRomExtensions);
    };
    exports.discImageSize = function(name) {
        // SSD, aka. single-sided disc, is:
        // - 1 side :)
        // - 80 tracks.
        // - 10 sectors per track.
        // - 256 bytes per sector.
        var isDsd = false;
        var byteSize = 80 * 10 * 256;
        // DSD, aka. double-sided disc is twice the size.
        if (name.toLowerCase().endsWith(".dsd")) {
            byteSize *= 2;
            isDsd = true;
        }
        return { isDsd: isDsd, byteSize: byteSize };
    };

    exports.setDiscName = function(data, name) {
        for (var i = 0; i < 8; ++i)
            data[i] = name.charCodeAt(i) & 0xff;
    };

    exports.resizeUint8Array = function(array, byteSize) {
        var newArray = new Uint8Array(byteSize);
        newArray.set(array.subarray(0, byteSize));
        return newArray;
    };

    function Fifo(capacity) {
        this.buffer = new Uint8Array(capacity);
        this.size = 0;
        this.wPtr = 0;
        this.rPtr = 0;
    }

    Fifo.prototype.full = function () {
        return this.size === this.buffer.length;
    };

    Fifo.prototype.empty = function () {
        return this.size === 0;
    };

    Fifo.prototype.clear = function () {
        this.size = 0;
        this.wPtr = 0;
        this.rPtr = 0;
    };

    Fifo.prototype.put = function (b) {
        if (this.full()) return;
        this.buffer[this.wPtr % this.buffer.length] = b;
        this.wPtr++;
        this.size++;
    };

    Fifo.prototype.get = function () {
        if (this.empty()) return;
        var res = this.buffer[this.rPtr % this.buffer.length];
        this.rPtr++;
        this.size--;
        return res;
    };

    exports.Fifo = Fifo;

    return exports;
});
