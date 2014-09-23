define(['utils'], function (utils) {
    "use strict";

    function UefTape(stream) {
        var self = this;
        stream.seek(10);
        var minor = stream.readByte();
        var major = stream.readByte();
        if (major !== 0x00) throw "Unsupported UEF version " + major + "." + minor;

        function readChunk() {
            var chunkId = stream.readInt16();
            var length = stream.readInt32();
            return {
                id: chunkId,
                stream: stream.substream(length)
            };
        }

        var curChunk = readChunk();
        var baseFrequency = 1200;

        function secsToClocks(secs) {
            return (2 * 1000 * 1000 * secs) | 0;
        }

        function cycles(count) {
            return secsToClocks(count / baseFrequency);
        }

        var state = -1;
        var curByte = 0;
        var numDataBits = 8;
        var parity = 'N';
        var numParityBits = 0;
        var numStopBits = 1;

        function parityOf(curByte) {
            var parity = false;
            while (curByte) {
                parity = !parity;
                curByte >>>= 1;
            }
            return parity;
        }

        self.poll = function (acia) {
            if (!curChunk) return;
            if (state === -1) {
                if (stream.eof()) {
                    curChunk = null;
                    return;
                }
                curChunk = readChunk();
            }

            acia.setDCD(false);

            switch (curChunk.id) {
                case 0x0000:
                    console.log("Origin: " + curChunk.stream.readNulString());
                    break;
                case 0x0100:
                    if (state === -1) {
                        state = 0;
                        curByte = curChunk.stream.readByte();
                        acia.tone(baseFrequency); // Start bit
                    } else if (state < 9) {
                        if (state === 0) {
                            // Start bit
                            acia.tone(baseFrequency);
                        } else {
                            acia.tone((curByte & (1 << (state - 1))) ? (2 * baseFrequency) : baseFrequency);
                        }
                        state++;
                    } else {
                        acia.receive(curByte);
                        acia.tone(2 * baseFrequency); // Stop bit
                        if (curChunk.stream.eof()) {
                            state = -1;
                        } else {
                            state = 0;
                            curByte = curChunk.stream.readByte();
                        }
                    }
                    return cycles(1);
                case 0x0104: // Defined data
                    if (state === -1) {
                        numDataBits = curChunk.stream.readByte();
                        parity = curChunk.stream.readByte();
                        numStopBits = curChunk.stream.readByte();
                        numParityBits = parity != 'N' ? 1 : 0;
                        console.log("Defined data with " + numDataBits + String.fromCharCode(parity) + numStopBits);
                        state = 0;
                    }
                    if (state === 0) {
                        if (curChunk.stream.eof()) {
                            state = -1;
                        } else {
                            curByte = curChunk.stream.readByte() & ((1 << numDataBits) - 1);
                            acia.tone(baseFrequency); // Start bit
                            state++;
                        }
                    } else if (state < (1 + numDataBits)) {
                        acia.tone((curByte & (1 << (state - 1))) ? (2 * baseFrequency) : baseFrequency);
                        state++;
                    } else if (state < (1 + numDataBits + numParityBits)) {
                        var bit = parityOf(curByte);
                        if (parity == 'N') bit = !bit;
                        acia.tone(bit ? (2 * baseFrequency) : baseFrequency);
                        state++;
                    } else if (state < (1 + numDataBits + numParityBits + numStopBits)) {
                        acia.tone(2 * baseFrequency); // Stop bits
                        state++;
                    } else {
                        acia.receive(curByte);
                        state = 0;
                        return 0;
                    }
                    return cycles(1);
                case 0x0114:
                    console.log("Ignoring security cycles");
                    break;
                case 0x0115:
                    console.log("Ignoring polarity change");
                    break;
                case 0x0110:
                    var count = curChunk.stream.readInt16();
                    acia.setDCD(true);
                    acia.tone(2 * baseFrequency);
                    return cycles(count);
                case 0x0113:
                    baseFrequency = curChunk.stream.readFloat32();
                    console.log("Frequency change ", baseFrequency);
                    break;
                case 0x0112:
                    var gap = 1 / (2 * curChunk.stream.readInt16() * baseFrequency);
                    console.log("Tape gap of " + gap + "s");
                    acia.tone(0);
                    return secsToClocks(gap);
                case 0x0116:
                    var gap = curChunk.stream.readFloat32();
                    console.log("Tape gap of " + gap + "s");
                    acia.tone(0);
                    return secsToClocks(gap);
                default:
                    console.log("Skipping unknown chunk " + utils.hexword(curChunk.id));
                    curChunk = readChunk();
                    break;
            }
            return cycles(1);
        };
    }

    function loadTapeFromData(data) {
        var stream = new utils.DataStream(name, data);
        if (stream.readByte(0) === 0xff && stream.readByte(1) === 0x04) {
            console.log("Detected a 'tapefile' tape");
            return new TapefileTape(stream);
        }
        if (stream.readNulString(0) == "UEF File!") {
            console.log("Detected a UEF tape");
            return new UefTape(stream);
        }
        console.log("Unknown tape format");
        return null;
    }

    function loadTape(name) {
        console.log("Loading tape from " + name);
        var data = utils.loadData(name);
        if (!data) return null;
        return loadTapeFromData(data);
    }

    return {
        loadTape: loadTape,
        loadTapeFromData: loadTapeFromData
    };
});
