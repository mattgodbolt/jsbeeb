define(['jsunzip'], function (jsunzip) {
    "use strict";
    var exports = {};

    function hexbyte(value) {
        return ((value >> 4) & 0xf).toString(16) + (value & 0xf).toString(16);
    }

    exports.hexbyte = hexbyte;

    function hexword(value) {
        return hexbyte(value >> 8) + hexbyte(value & 0xff);
    }

    exports.hexword = hexword;

    function signExtend(val) {
        return val >= 128 ? val - 256 : val;
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

    function loadData(url) {
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

    exports.loadData = loadData;

    function readInt32(data, offset) {
        return (data[offset + 3] << 24)
            | (data[offset + 2] << 16)
            | (data[offset + 1] << 8)
            | (data[offset + 0]);
    }

    exports.readInt32 = readInt32;

    function readInt16(data, offset) {
        var request = new XMLHttpRequest();
        return (data[offset + 1] << 8)
            | (data[offset + 0]);
    }

    exports.readInt16 = readInt16;

    function ungzip(data) {
        var request = new XMLHttpRequest();
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
