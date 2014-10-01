define(['jsunzip'], function (jsunzip) {
    "use strict";
    var exports = {};

    exports.runningInNode = typeof window === 'undefined';

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

        HASH: [8, 2],
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
        NUMPADENTER: 255 // hack, jsbeeb only
    };

    // With thanks to http://stackoverflow.com/questions/9847580/how-to-detect-safari-chrome-ie-firefox-and-opera-browser
    // Opera 8.0+ (UA detection to detect Blink/v8-powered Opera)
    var isFirefox = typeof InstallTrigger !== 'undefined';   // Firefox 1.0+
    var keyCodes = exports.keyCodes;

    if (isFirefox) {
        keyCodes.SEMICOLON = 59;
        // # key
        keyCodes.HASH = 163;
        keyCodes.APOSTROPHE = 222;
        // Firefox doesn't return a keycode for this
        keyCodes.MUTE = -1;
        keyCodes.MINUS = 173;
        keyCodes.EQUALS = 61;
        keyCodes.BACK_QUOTE = 192;
    } else {
        // Chrome
        // TODO: check other browsers
        // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent.keyCode
        keyCodes.SEMICOLON = 186;
        // # key
        keyCodes.HASH = 222;
        keyCodes.APOSTROPHE = 192;
        keyCodes.MUTE = 173;
        keyCodes.MINUS = 189;
        keyCodes.EQUALS = 187;
        keyCodes.BACK_QUOTE = 223;
    }

    function hexbyte(value) {
        return ((value >> 4) & 0xf).toString(16) + (value & 0xf).toString(16);
    }

    exports.hexbyte = hexbyte;

    function hexword(value) {
        return hexbyte(value >> 8) + hexbyte(value & 0xff);
    }

    exports.hexword = hexword;

    var signExtendTable = (function () {
        var table = [];
        for (var i = 0; i < 256; ++i) table[i] = i >= 128 ? i - 256 : i;
        return table;
    })();

    function signExtend(val) {
        return signExtendTable[val | 0] | 0;
    }

    exports.signExtend = signExtend;

    exports.noteEvent = function noteEvent(category, type, label) {
        if (window.location.origin == "http://bbc.godbolt.org") {
            // Only note events on the public site
            ga('send', 'event', category, type, label);
        }
        console.log('event noted:', category, type, label);
    };

    function makeBinaryData(dataIn) {
        if (dataIn instanceof Uint8Array) return dataIn;
        var len = dataIn.length;
        var result = new Uint8Array(len);
        for (var i = 0; i < len; ++i) result[i] = dataIn.charCodeAt(i) & 0xff;
        return result;
    }

    function loadDataHttp(url) {
        var request = new XMLHttpRequest();
        request.open("GET", url, false);
        request.overrideMimeType('text/plain; charset=x-user-defined');
        request.send(null);
        if (request.status != 200) return null;
        if (typeof(request.response) != "string") {
            return request.response;
        }
        return makeBinaryData(request.response);
    }

    function loadDataNode(url) {
        var fs = require('fs');
        if (url[0] == '/') url = "." + url;
        return fs.readFileSync(url);
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
        var tinf = new jsunzip.TINF();
        tinf.init();
        var uncompressedSize = readInt32(data, data.length - 4);
        var result = tinf.uncompress(data, dataOffset, uncompressedSize);
        if (result.status === 0) return result.data;
        throw "Unable to ungzip";
    }

    exports.ungzip = ungzip;

    function DataStream(name_, data_, dontUnzip_) {
        var self = this;
        self.name = name_;
        self.pos = 0;
        self.data = makeBinaryData(data_);
        if (!dontUnzip_ && self.data && self.data.length > 4 && self.data[0] === 0x1f && self.data[1] === 0x8b && self.data[2] === 0x08) {
            self.data = ungzip(self.data);
        }
        if (!self.data) {
            throw new Error("No data");
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
        }

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

    return exports;
});
