define(['utils'], function (utils) {
    "use strict";

    function UefTape(stream) {
        var self = this;

        var dummyData, state, curByte, numDataBits, parity;
        var numParityBits, numStopBits, carrierBefore, carrierAfter;


        self.rewind = function () {

            dummyData = [false, false, true, false, true, false, true, false, true, true];
            state = -1;
            curByte = 0;
            numDataBits = 8;
            parity = 'N';
            numParityBits = 0;
            numStopBits = 1;
            carrierBefore = 0;
            carrierAfter = 0;

            stream.seek(10);
            var minor = stream.readByte();
            var major = stream.readByte();
            if (major !== 0x00) throw "Unsupported UEF version " + major + "." + minor;
        };

        self.rewind();

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

            var gap;
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
                case 0x0111: // Carrier tone with dummy data
                    acia.setDCD(true);
                    if (state === -1) {
                        carrierBefore = curChunk.stream.readInt16();
                        carrierAfter = curChunk.stream.readInt16();
                        console.log("Carrier with", carrierBefore, carrierAfter);
                        state = 0;
                        acia.tone(2 * baseFrequency);
                        return cycles(carrierBefore);
                    } else if (state < 10) {
                        acia.tone(dummyData[state] ? baseFrequency : (2 * baseFrequency));
                        state++;
                    } else if (state === 10) {
                        acia.receive(0xaa);
                        acia.tone(2 * baseFrequency);
                        state++;
                        return cycles(carrierAfter);
                    } else {
                        state = -1;
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
                    gap = 1 / (2 * curChunk.stream.readInt16() * baseFrequency);
                    console.log("Tape gap of " + gap + "s");
                    acia.tone(0);
                    return secsToClocks(gap);
                case 0x0116:
                    gap = curChunk.stream.readFloat32();
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

    function loadTapeFromData(name, data) {
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
        return utils.loadData(name).then(function (data) {
            return loadTapeFromData(name, data);
        });
    }

    return {
        loadTape: loadTape,
        loadTapeFromData: loadTapeFromData
    };
});
