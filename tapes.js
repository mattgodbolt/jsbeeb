define(['utils'], function (utils) {
    "use strict";

    function UefTape(stream) {
        var self = this;

        var dummyData, state, count, curByte, numDataBits, parity;
        var numParityBits, numStopBits, carrierBefore, carrierAfter;


        self.rewind = function () {

            dummyData = [false, false, true, false, true, false, true, false, true, true];
            state = -1;
            count = 0;
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

            var gap;
            switch (curChunk.id) {
                case 0x0000:
                    console.log("Origin: " + curChunk.stream.readNulString());
                    break;
                case 0x0100:
                    acia.setTapeCarrier(false);
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
                    acia.setTapeCarrier(false);
                    if (state === -1) {
                        numDataBits = curChunk.stream.readByte();
                        parity = curChunk.stream.readByte();
                        numStopBits = curChunk.stream.readByte();
                        numParityBits = parity !== 'N' ? 1 : 0;
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
                        if (parity === 'N') bit = !bit;
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
                    if (state === -1) {
                        state = 0;
                        carrierBefore = curChunk.stream.readInt16();
                        carrierAfter = curChunk.stream.readInt16();
                        console.log("Carrier with", carrierBefore, carrierAfter);
                    }
                    if (state === 0) {
                        acia.setTapeCarrier(true);
                        acia.tone(2 * baseFrequency);
                        carrierBefore--;
                        if (carrierBefore <= 0) state = 1;
                    } else if (state < 11) {
                        acia.setTapeCarrier(false);
                        acia.tone(dummyData[(state - 1)] ? baseFrequency : (2 * baseFrequency));
                        if (state === 10) {
                            acia.receive(0xaa);
                        }
                        state++;
                    } else {
                        acia.setTapeCarrier(true);
                        acia.tone(2 * baseFrequency);
                        carrierAfter--;
                        if (carrierAfter <= 0) state = -1;
                    }
                    return cycles(1);
                case 0x0114:
                    console.log("Ignoring security cycles");
                    break;
                case 0x0115:
                    console.log("Ignoring polarity change");
                    break;
                case 0x0110: // Carrier tone.
                    if (state === -1) {
                        state = 0;
                        count = curChunk.stream.readInt16();
                    }
                    acia.setTapeCarrier(true);
                    acia.tone(2 * baseFrequency);
                    count--;
                    if (count <= 0) state = -1;
                    return cycles(1);
                case 0x0113:
                    baseFrequency = curChunk.stream.readFloat32();
                    console.log("Frequency change ", baseFrequency);
                    break;
                case 0x0112:
                    acia.setTapeCarrier(false);
                    gap = 1 / (2 * curChunk.stream.readInt16() * baseFrequency);
                    console.log("Tape gap of " + gap + "s");
                    acia.tone(0);
                    return secsToClocks(gap);
                case 0x0116:
                    acia.setTapeCarrier(false);
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


    function TapefileTape(stream) {
        var self = this;

        self.count = 0;
        self.stream = stream;

        var dividerTable = [1, 16, 64, -1];

        function rate(acia) {
            var bitsPerByte = 9;
            if (!(acia.cr & 0x80)) {
                bitsPerByte++; // Not totally correct if the AUG is to be believed.
            }
            var divider = dividerTable[acia.cr & 0x03];
            // http://beebwiki.mdfs.net/index.php/Serial_ULA says the serial rate is ignored
            // for cassette mode.
            var cpp = (2 * 1000 * 1000) / (19200 / divider);
            return Math.floor(bitsPerByte * cpp);
        }

        self.rewind = function () {
            stream.seek(10);
        };

        self.poll = function (acia) {
            if (stream.eof()) return 100000;
            var byte = stream.readByte();
            if (byte === 0xff) {
                byte = stream.readByte();
                if (byte === 0) {
                    acia.setTapeCarrier(false);
                    return 0;
                } else if (byte === 0x04) {
                    acia.setTapeCarrier(true);
                    // Simulate 5 seconds of carrier.
                    return 5 * 2 * 1000 * 1000;
                } else if (byte !== 0xff) {
                    throw "Got a weird byte in the tape";
                }
            }
            acia.receive(byte);
            return rate(acia);
        };
    }

    function loadTapeFromData(name, data) {
        var stream = new utils.DataStream(name, data);
        if (stream.readByte(0) === 0xff && stream.readByte(1) === 0x04) {
            console.log("Detected a 'tapefile' tape");
            return new TapefileTape(stream);
        }
        if (stream.readNulString(0) === "UEF File!") {
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
