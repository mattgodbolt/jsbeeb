define(['utils'], function (utils) {
    "use strict";

    function UefTape(stream) {
        var self = this;
        stream.seek(10);
        var minor = stream.readByte();
        var major = stream.readByte();
        if (major !== 0x00) throw "Unsupported UEF version " + major + "." + minor;

        function cyclesPerPoll(suggested) {
            return 16 / 13 * 1000 * 1000;
        }

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

        function cycles(count) {
            return 2 * 1000 * 1000 * count / baseFrequency;
        }

        var state = -1;
        var curByte = 0;

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
                    } else if (state < 8) {
                        acia.tone((curByte & (1 << state)) ? (2 * baseFrequency) : baseFrequency);
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
                case 0x0110:
                    var count = curChunk.stream.readInt16();
                    acia.setDCD(true);
                    acia.tone(2 * baseFrequency);
                    return cycles(count);
                case 0x0112:
                    console.log("Ignoring gap");
                    acia.tone(0);
                    break;
                default:
                    console.log("Skipping unknown chunk " + hexword(curChunk.id));
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
