"use strict";
import * as utils from "./utils.js";

const BbcCpuSpeed = 2 * 1000 * 1000;
const AtomCpuSpeed = 1 * 1000 * 1000;

function secsToClocks(secs, cpuSpeed) {
    return (cpuSpeed * secs) | 0;
}

// Atom tape encoding: bit patterns sent via receiveBit().
// '0': 4 half-cycles at 1.2 kHz (duration < 8 in the ROM's loop counter)
// '1': 8 half-cycles at 2.4 kHz (duration >= 8)
const AtomBit0Pattern = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1];
const AtomBit1Pattern = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];

function parityOf(curByte) {
    let parity = false;
    while (curByte) {
        parity = !parity;
        curByte >>>= 1;
    }
    return parity;
}

const ParityN = "N".charCodeAt(0);

class UefTape {
    constructor(stream, isAtom = false) {
        this.stream = stream;
        this.baseFrequency = 1200;
        this.isAtom = isAtom;
        this.cpuSpeed = isAtom ? AtomCpuSpeed : BbcCpuSpeed;
        this.rewind();

        this.curChunk = this.readChunk();
    }

    rewind() {
        this.dummyData = [false, false, true, false, true, false, true, false, true, true];
        this.state = -1;
        this.count = 0;
        this.curByte = 0;
        this.numDataBits = 8;
        this.parity = ParityN;
        this.numParityBits = 0;
        this.numStopBits = 1;
        this.carrierBefore = 0;
        this.carrierAfter = 0;
        this.wavebits = [];
        this.shortWave = 0;

        this.stream.seek(10);
        const minor = this.stream.readByte();
        const major = this.stream.readByte();
        if (major !== 0x00) throw "Unsupported UEF version " + major + "." + minor;
    }

    readChunk() {
        const chunkId = this.stream.readInt16();
        const length = this.stream.readInt32();
        return {
            id: chunkId,
            stream: this.stream.substream(length),
        };
    }

    // On BBC, acia is the ACIA (6850); on Atom, it's the PPIA (8255).
    // Both provide setTapeCarrier(), tone(), and receive/receiveBit().
    poll(acia) {
        if (!this.curChunk) return;

        // Atom: drain the wavebits queue first (one bit per poll).
        // Each wavebit represents one half-period of 2×baseFrequency (2400 Hz),
        // so the delay is 1/(4×baseFrequency) seconds ≈ 208 cycles at 1 MHz.
        // AtomBit1Pattern [0,1,0,1,...] toggles every wavebit → 208-cycle transitions → ROM counts ~6 → '1'.
        // AtomBit0Pattern [0,0,1,1,...] toggles every 2 wavebits → 416-cycle transitions → ROM counts ~13 → '0'.
        if (this.isAtom && this.wavebits.length > 0) {
            acia.receiveBit(this.wavebits.shift());
            return secsToClocks(0.25 / this.baseFrequency, this.cpuSpeed);
        }

        if (this.state === -1) {
            if (this.stream.eof()) {
                this.curChunk = null;
                return;
            }
            this.curChunk = this.readChunk();
        }

        let gap;
        switch (this.curChunk.id) {
            case 0x0000:
                console.log("Origin: " + this.curChunk.stream.readNulString());
                break;
            case 0x0100:
                acia.setTapeCarrier(false);
                if (this.state === -1) {
                    this.state = 0;
                    this.curByte = this.curChunk.stream.readByte();
                    acia.tone(this.baseFrequency); // Start bit
                } else if (this.state < 9) {
                    if (this.state === 0) {
                        // Start bit
                        acia.tone(this.baseFrequency);
                        if (this.isAtom) this.wavebits = Array.from(AtomBit0Pattern);
                    } else {
                        const bit = this.curByte & (1 << (this.state - 1));
                        acia.tone(bit ? 2 * this.baseFrequency : this.baseFrequency);
                        if (this.isAtom) this.wavebits = Array.from(bit ? AtomBit1Pattern : AtomBit0Pattern);
                    }
                    this.state++;
                } else {
                    acia.receive(this.curByte);
                    acia.tone(2 * this.baseFrequency); // Stop bit
                    if (this.isAtom) this.wavebits = Array.from(AtomBit1Pattern);
                    if (this.curChunk.stream.eof()) {
                        this.state = -1;
                    } else {
                        this.state = 0;
                        this.curByte = this.curChunk.stream.readByte();
                    }
                }
                if (this.isAtom) return 0; // wavebits queued, drained on next poll
                return this.cycles(1);
            case 0x0104: // Defined data
                acia.setTapeCarrier(false);
                if (this.state === -1) {
                    this.numDataBits = this.curChunk.stream.readByte();
                    this.parity = this.curChunk.stream.readByte();
                    this.numStopBits = this.curChunk.stream.readByte();
                    this.numParityBits = this.parity !== ParityN ? 1 : 0;
                    // Atom: negative stop bits (high bit set) means short wave
                    this.shortWave = 0;
                    if (this.isAtom && this.numStopBits & 0x80) {
                        this.numStopBits = Math.abs(this.numStopBits - 256);
                        this.shortWave = 1;
                    }
                    console.log(
                        `Defined data with ${this.numDataBits}${String.fromCharCode(this.parity)}${this.shortWave ? "-" : ""}${this.numStopBits}`,
                    );
                    this.state = 0;
                }
                if (this.state === 0) {
                    if (this.curChunk.stream.eof()) {
                        this.state = -1;
                    } else {
                        this.curByte = this.curChunk.stream.readByte() & ((1 << this.numDataBits) - 1);
                        acia.tone(this.baseFrequency); // Start bit
                        if (this.isAtom) this.wavebits = Array.from(AtomBit0Pattern);
                        this.state++;
                    }
                } else if (this.state < 1 + this.numDataBits) {
                    const bit = this.curByte & (1 << (this.state - 1));
                    acia.tone(bit ? 2 * this.baseFrequency : this.baseFrequency);
                    if (this.isAtom) this.wavebits = Array.from(bit ? AtomBit1Pattern : AtomBit0Pattern);
                    this.state++;
                } else if (this.state < 1 + this.numDataBits + this.numParityBits) {
                    let bit = parityOf(this.curByte);
                    if (this.parity === ParityN) bit = !bit;
                    acia.tone(bit ? 2 * this.baseFrequency : this.baseFrequency);
                    if (this.isAtom) this.wavebits = Array.from(bit ? AtomBit1Pattern : AtomBit0Pattern);
                    this.state++;
                } else if (this.state < 1 + this.numDataBits + this.numParityBits + this.numStopBits) {
                    acia.tone(2 * this.baseFrequency); // Stop bits
                    if (this.isAtom) this.wavebits = Array.from(AtomBit1Pattern);
                    this.state++;
                } else {
                    acia.receive(this.curByte);
                    this.state = 0;
                    return 0;
                }
                if (this.isAtom) return 0;
                return this.cycles(1);
            case 0x0111: // Carrier tone with dummy data
                if (this.state === -1) {
                    this.state = 0;
                    this.carrierBefore = this.curChunk.stream.readInt16();
                    this.carrierAfter = this.curChunk.stream.readInt16();
                    console.log("Carrier with", this.carrierBefore, this.carrierAfter);
                }
                if (this.state === 0) {
                    acia.setTapeCarrier(true);
                    acia.tone(2 * this.baseFrequency);
                    if (this.isAtom) this.wavebits = Array.from(AtomBit1Pattern);
                    this.carrierBefore--;
                    if (this.carrierBefore <= 0) this.state = 1;
                } else if (this.state < 11) {
                    acia.setTapeCarrier(false);
                    acia.tone(this.dummyData[this.state - 1] ? this.baseFrequency : 2 * this.baseFrequency);
                    if (this.isAtom)
                        this.wavebits = Array.from(this.dummyData[this.state - 1] ? AtomBit0Pattern : AtomBit1Pattern);
                    if (this.state === 10) {
                        acia.receive(0xaa);
                    }
                    this.state++;
                } else {
                    acia.setTapeCarrier(true);
                    acia.tone(2 * this.baseFrequency);
                    if (this.isAtom) this.wavebits = Array.from(AtomBit1Pattern);
                    this.carrierAfter--;
                    if (this.carrierAfter <= 0) this.state = -1;
                }
                if (this.isAtom) return 0;
                return this.cycles(1);
            case 0x0114:
                console.log("Ignoring security cycles");
                break;
            case 0x0115:
                console.log("Ignoring polarity change");
                break;
            case 0x0110: // Carrier tone.
                if (this.state === -1) {
                    this.state = 0;
                    this.count = this.curChunk.stream.readInt16();
                    // Each Atom carrier cycle expands to 16 wavebits, so
                    // divide the count to avoid 16x too many cycles.
                    if (this.isAtom) this.count = (this.count / 16) | 0;
                }
                acia.setTapeCarrier(true);
                acia.tone(2 * this.baseFrequency);
                if (this.isAtom) this.wavebits = Array.from(AtomBit1Pattern);
                this.count--;
                if (this.count <= 0) this.state = -1;
                if (this.isAtom) return 0;
                return this.cycles(1);
            case 0x0113:
                this.baseFrequency = this.curChunk.stream.readFloat32();
                console.log("Frequency change ", this.baseFrequency);
                break;
            case 0x0112:
                acia.setTapeCarrier(false);
                gap = 1 / (2 * this.curChunk.stream.readInt16() * this.baseFrequency);
                console.log("Tape gap of " + gap + "s");
                acia.tone(0);
                return secsToClocks(gap, this.cpuSpeed);
            case 0x0116:
                acia.setTapeCarrier(false);
                gap = this.curChunk.stream.readFloat32();
                console.log("Tape gap of " + gap + "s");
                acia.tone(0);
                return secsToClocks(gap, this.cpuSpeed);
            default:
                console.log("Skipping unknown chunk " + utils.hexword(this.curChunk.id));
                this.curChunk = this.readChunk();
                break;
        }
        return this.cycles(1);
    }

    cycles(count) {
        return secsToClocks(count / this.baseFrequency, this.cpuSpeed);
    }
}

const dividerTable = [1, 16, 64, -1];

class TapefileTape {
    constructor(stream) {
        this.count = 0;
        this.stream = stream;
    }

    rate(acia) {
        let bitsPerByte = 9;
        if (!(acia.cr & 0x80)) {
            bitsPerByte++; // Not totally correct if the AUG is to be believed.
        }
        const divider = dividerTable[acia.cr & 0x03];
        // http://beebwiki.mdfs.net/index.php/Serial_ULA says the serial rate is ignored
        // for cassette mode.
        const cpp = (2 * 1000 * 1000) / (19200 / divider);
        return Math.floor(bitsPerByte * cpp);
    }

    rewind() {
        this.stream.seek(10);
    }

    poll(acia) {
        if (this.stream.eof()) return 100000;
        let byte = this.stream.readByte();
        if (byte === 0xff) {
            byte = this.stream.readByte();
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
        return this.rate(acia);
    }
}

export async function loadTapeFromData(name, data, isAtom = false) {
    const stream = await utils.DataStream.create(name, data);
    if (stream.readByte(0) === 0xff && stream.readByte(1) === 0x04) {
        console.log("Detected a 'tapefile' tape");
        return new TapefileTape(stream);
    }
    if (stream.readNulString(0) === "UEF File!") {
        console.log("Detected a UEF tape");
        return new UefTape(stream, isAtom);
    }
    console.log("Unknown tape format");
    return null;
}

export async function loadTape(name, isAtom = false) {
    console.log("Loading tape from " + name);
    return loadTapeFromData(name, await utils.loadData(name), isAtom);
}
