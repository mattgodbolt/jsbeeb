// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit

import * as utils from "./utils.js";

/*
 * TODO: use in fingerprinting
class Crc32Builder {
    constructor() {
        this._crc = 0xffffffff;
    }

    add(data) {
        for (let i = 0; i < data.length; ++i) {
            const byte = data[i];
            this._crc ^= byte;
            for (let j = 0; j < 8; ++j) {
                const doEor = this._crc & 1;
                this._crc = this._crc >>> 1;
                if (doEor) this._crc ^= 0xedb88320;
            }
        }
    }

    get crc() {
        return ~this._crc;
    }
}
*/
class TrackBuilder {
    /**
     * @param {Track} track
     */
    constructor(track) {
        this._track = track;
        this._track.length = IbmDiscFormat.bytesPerTrack;
        this._index = 0;
        this._pulsesIndex = 0;
        this._lastMfmBit = 0;
        this._crc = 0;
    }

    get track() {
        return this._track;
    }

    setTrackLength() {
        if (this._index > IbmDiscFormat.bytesPerTrack) throw new Error("Overflowed disc size");
        if (this._index !== 0) this._track.length = this._index;
        return this;
    }

    resetCrc() {
        this._crc = IbmDiscFormat.crcInit(false);
        return this;
    }

    appendFmDataAndClocks(data, clocks) {
        if (this._index >= IbmDiscFormat.bytesPerTrack) throw new Error("Overflow in disc buliding");
        this._track.pulses2Us[this._index++] = IbmDiscFormat.fmTo2usPulses(clocks, data);
        this._crc = IbmDiscFormat.crcAddByte(this._crc, data);
        return this;
    }

    appendFmByte(data) {
        this.appendFmDataAndClocks(data, 0xff);
        return this;
    }

    appendRepeatFmByte(data, count) {
        for (let i = 0; i < count; ++i) this.appendFmByte(data);
        return this;
    }

    fillFmByte(data) {
        if (this._index >= IbmDiscFormat.bytesPerTrack) throw new Error("Overflowed disc size");
        this.appendRepeatFmByte(data, IbmDiscFormat.bytesPerTrack - this._index);
        return this;
    }

    appendRepeatFmByteWithClocks(data, clocks, count) {
        for (let i = 0; i < count; ++i) this.appendFmDataAndClocks(data, clocks);
        return this;
    }

    appendFmChunk(bytes) {
        for (const byte of bytes) this.appendFmByte(byte);
        return this;
    }

    appendCrc(isMfm) {
        // TODO consider remembering isMfM if nothing else needs to know/
        // could then break this into MFM and FM builder
        const firstByte = (this._crc >>> 8) & 0xff;
        const secondByte = this._crc & 0xff;
        if (isMfm) {
            this.appendMfmByte(firstByte);
            this.appendMfmByte(secondByte);
        } else {
            this.appendFmByte(firstByte);
            this.appendFmByte(secondByte);
        }
        return this;
    }

    appendMfmPulses(pulses) {
        if (this._index >= IbmDiscFormat.bytesPerTrack) throw new Error("Overflowed disc size");
        const existingPulses = this._track.pulses2Us[this._index];
        const mask = 0xffff << this._pulsesIndex;
        this._pulsesIndex = (this._pulsesIndex + 16) & 15;
        this._track.pulses2Us[this._index] = (existingPulses & mask) | (pulses << this._pulsesIndex);
        if (this._pulsesIndex === 0) this._index++;
        return this;
    }

    appendMfmByte(data) {
        const { lastBit, pulses } = IbmDiscFormat.mfmTo2usPulses(this._lastMfmBit, data);
        this._lastMfmBit = lastBit;
        this.appendMfmPulses(pulses);
        this._crc = IbmDiscFormat.crcAddByte(this._crc, data);
        return this;
    }

    appendRepeatMfmByte(data, count) {
        for (let i = 0; i < count; ++i) this.appendMfmByte(data);
        return this;
    }

    appendMfm3xA1Sync() {
        for (let i = 0; i < 3; ++i) {
            this.appendMfmPulses(IbmDiscFormat.mfmA1Sync);
            this._crc = IbmDiscFormat.crcAddByte(this._crc, 0xa1);
        }
        return this;
    }

    appendMfmChunk(bytes) {
        for (const byte of bytes) this.appendMfmByte(byte);
        return this;
    }

    fillMfmByte(data) {
        if (this._index >= IbmDiscFormat.bytesPerTrack) throw new Error("Overflowed disc size");
        while (this._index < IbmDiscFormat.bytesPerTrack) this.appendMfmByte(data);
        return this;
    }

    /**
     * @param {number[]} pulseDeltas array of lengths between pulses
     * @param {boolean} isMfm whether this is an MFM track
     */
    buildFromPulses(pulseDeltas, isMfm) {
        let hasWarned = false;
        for (const pulse of pulseDeltas) {
            if (!IbmDiscFormat.checkPulse(pulse, isMfm)) {
                console.log(`Found a bad pulse for ${this.track.description}`);
            }
            if (!this.appendPulseDelta(pulse, isMfm) && !hasWarned) {
                console.log(`Truncated disc data for ${this.track.description}, ignoring the rest`);
                hasWarned = true;
            }
        }
        this.setTrackLength();
    }

    appendPulseDelta(deltaUs, quantizeMfm) {
        let num2UsUnits = quantizeMfm ? Math.round(deltaUs / 2) : 2 * Math.round(deltaUs / 4);
        while (num2UsUnits--) {
            if (this._index === IbmDiscFormat.bytesPerTrack) return false;
            if (num2UsUnits === 0) {
                this._track.pulses2Us[this._index] |= 0x80000000 >>> this._pulsesIndex;
            }
            this._pulsesIndex++;
            if (this._pulsesIndex === 32) {
                this._pulsesIndex = 0;
                this._index++;
            }
        }
        return true;
    }
}

class RawDiscReader {
    /**
     * @param {Track} track
     * @param {Number} bitOffset
     */
    constructor(track, bitOffset) {
        this._track = track;
        this._pos = bitOffset;
    }

    readPulses() {
        let pulsesPos = this._pos >>> 5;
        const bitPos = this._pos & 0x1f;
        let sourcePulses = this._track.pulses2Us[pulsesPos];
        let pulses = (sourcePulses << bitPos) & 0xfffffffff;
        if (pulsesPos === this._track.length) {
            pulsesPos = 0;
            this._pos = bitPos;
        } else {
            pulsesPos++;
            this._pos += 32;
        }
        if (bitPos > 0) {
            sourcePulses = this._track.pulses2Us[pulsesPos];
            pulses |= sourcePulses >>> (32 - bitPos);
        }
        return pulses;
    }
}

class MfmReader {
    /**
     * @param {RawDiscReader} rawReader
     */
    constructor(rawReader) {
        this._rawReader = rawReader;
    }
    read(numBytes) {
        const data = new Uint8Array[numBytes]();
        let pulses = 0;
        for (let offset = 0; offset < numBytes; ++offset) {
            if ((offset & 1) === 0) {
                pulses = this._rawReader.readPulses();
            } else {
                pulses = (pulses << 16) & 0xffffffff;
            }
            data[offset] = IbmDiscFormat._2usPulsesToMfm(pulses >>> 16);
        }
        return { data, clocks: null, iffyPulses: false };
    }

    get initialCrc() {
        let crc = IbmDiscFormat.crcInit(0);
        crc = IbmDiscFormat.crcAddByte(crc, 0xa1);
        crc = IbmDiscFormat.crcAddByte(crc, 0xa1);
        crc = IbmDiscFormat.crcAddByte(crc, 0xa1);
        return crc;
    }
}

class FmReader {
    /**
     * @param {RawDiscReader} rawReader
     */
    constructor(rawReader) {
        this._rawReader = rawReader;
    }

    read(numBytes) {
        const data = new Uint8Array(numBytes);
        const clocks = new Uint8Array(numBytes);
        let iffyPulses = false;
        for (let offset = 0; offset < numBytes; ++offset) {
            const pulses = this._rawReader.readPulses();
            const { data: dataByte, clock: clockByte, iffyPulses: iffy } = IbmDiscFormat._2usPulsesToFm(pulses);
            data[offset] = dataByte;
            clocks[offset] = clockByte;
            iffyPulses |= iffy;
        }
        return { data, clocks, iffyPulses };
    }
    get initialCrc() {
        return IbmDiscFormat.crcInit(0);
    }
}

class Sector {
    constructor(track, isMfm, bitOffset) {
        this.track = track;
        this.isMfm = isMfm;
        this.bitOffset = bitOffset; // better naems ..
        this.bitPosData = null; // better names ^^
        this.isDeleted = false;
        this.header = null;
        this.data = null;
        this.hasHeaderCrcError = false;
        this.hasDataCrcError = false;
        this.byteLength = null;
    }

    _readerAt(bitOffset) {
        const rawReader = new RawDiscReader(this.track, bitOffset);
        return this.isMfm ? new MfmReader(rawReader) : new FmReader(rawReader);
    }

    /**
     * @param {Sector|undefined} nextSector
     */
    read(nextSector) {
        const idReader = this._readerAt(this.bitOffset);
        const pulsesPerByte = this.isMfm ? 16 : 32; // todo put in reader
        const { data: headerData, iffyPulses } = idReader.read(6);
        if (iffyPulses) {
            console.log(`Iffy pulse in sector header ${this.track}`);
        }
        this.header = headerData;
        let crc = idReader.initialCrc;
        crc = IbmDiscFormat.crcAddByte(crc, IbmDiscFormat.idMarkDataPattern);
        crc = IbmDiscFormat.crcAddBytes(crc, this.header.slice(0, 4));
        const discCrc = (this.header[4] << 8) | this.header[5];
        if (crc !== discCrc) {
            this.hasHeaderCrcError = true;
        }
        if (this.bitPosData === null) {
            console.log(`"Sector header without data ${this.track}"`);
            return;
        }

        const dataMarker = this.isDeleted
            ? IbmDiscFormat.deletedDataMarkDataPattern
            : IbmDiscFormat.dataMarkDataPattern;
        const sectorStartByte = this.bitPosData / pulsesPerByte;
        const sectorEndByte = nextSector ? nextSector.bitOffset / pulsesPerByte : this.track.length;
        // Account for CRC and sync bytes.
        let sectorSize = Sector.toSectorSize(sectorEndByte - sectorStartByte - 5);

        this.hasDataCrcError = true;
        let seenIffyData = false;
        do {
            const { crcOk, sectorData, iffyPulses } = this._tryLoadSectorData(dataMarker, sectorSize);
            seenIffyData = iffyPulses;
            if (crcOk) {
                this.byteLength = sectorSize;
                this.hasDataCrcError = false;
                this.sectorData = sectorData;
                break;
            }
            sectorSize = sectorSize >>> 1;
        } while (sectorSize >= 128);
        if (seenIffyData) {
            console.log(`"Iffy pulse in sector data ${this.track}"`);
        }
    }

    _tryLoadSectorData(dataMarker, sectorSize) {
        const dataReader = this._readerAt(this.bitPosData);
        let crc = IbmDiscFormat.crcAddByte(dataReader.initialCrc, dataMarker);
        const { data: sectorData, iffyPulses } = dataReader.read(sectorSize + 2);
        crc = IbmDiscFormat.crcAddBytes(crc, sectorData.slice(0, sectorSize));
        const dataCrc = (sectorData[sectorSize] << 8) | sectorData[sectorSize + 1];
        return { crcOk: dataCrc === crc, sectorData, iffyPulses };
    }

    static toSectorSize(size) {
        if (size < 256) return 128;
        if (size < 512) return 256;
        if (size < 1024) return 512;
        if (size < 2048) return 1024;
        return 2048;
    }
}

class Track {
    constructor(upper, trackNum, initialByte) {
        this.length = IbmDiscFormat.bytesPerTrack;
        this.upper = upper;
        this.trackNum = trackNum;
        this.pulses2Us = new Uint32Array(256 * 13);
        this.pulses2Us.fill(initialByte | (initialByte << 8) | (initialByte << 16) | (initialByte << 24));
    }

    get description() {
        return `Track ${this.trackNum} ${this.upper ? "upper" : "lower"}`;
    }

    /**
     * Debug functionality to try and interpret the track.
     * @returns {Sector[]}
     */
    findSectors() {
        const sectors = this.findSectorIds();
        for (let sectorIndex = 0; sectorIndex !== sectors.length; ++sectorIndex) {
            const nextSector = sectors[sectorIndex + 1]; // Will be unset for last
            sectors[sectorIndex].read(nextSector);
        }
        return sectors;
    }

    /**
     * @returns {Sector[]}
     */
    findSectorIds() {
        const sectors = [];
        // Pass 1: walk the track and find header and data markers.
        const bitLength = this.length * 32;
        let shiftRegister = 0;
        let numShifts = 0;
        let doMfmMarkerByte = false;
        let isMfm = false;
        let pulses = 0;
        let markDetector = 0n;
        let markDetectorPrev = 0n;
        const all64b = 0xffffffffffffffffn;
        const top32of64b = 0xffffffff00000000n;
        const fmMarker = 0x8888888800000000n;
        const mfmMarker = 0xaaaa448944894489n;
        let dataByte = 0;
        let sector = null;
        for (let pulseIndex = 0; pulseIndex < bitLength; ++pulseIndex) {
            if ((pulseIndex & 31) === 0) pulses = this.pulses2Us[pulseIndex >> 5];
            markDetectorPrev = (markDetectorPrev << 1n) & all64b;
            markDetectorPrev |= markDetector >> 63n;
            markDetector = (markDetector << 1n) & all64b;
            shiftRegister = (shiftRegister << 1) & 0xffffffff;
            numShifts++;
            if (pulses & 0x80000000) {
                markDetector |= 1n;
                shiftRegister |= 1;
            }
            pulses = (pulses << 1) & 0xffffffff;
            if ((markDetector & top32of64b) === fmMarker) {
                const { clocks, data, iffyPulses } = IbmDiscFormat._2usPulsesToFm(Number(markDetector & 0xffffffffn));
                if (iffyPulses || clocks !== IbmDiscFormat.markClockPattern) continue;
                isMfm = false;
                doMfmMarkerByte = false;
                let num0s = 8;
                for (let bits = markDetectorPrev; (bits & 0xfn) === 0x8n; bits >>= 4n) {
                    num0s++;
                }
                if (num0s <= 16) {
                    console.log(`Short zeros sync ${this.description}`);
                }
                dataByte = data;
            } else if (markDetector === mfmMarker) {
                // Next byte is MFM marker.
                isMfm = true;
                doMfmMarkerByte = true;
                shiftRegister = 0;
                numShifts = 0;
                continue;
            } else if (doMfmMarkerByte && numShifts === 16) {
                dataByte = IbmDiscFormat._2usPulsesToMfm(shiftRegister);
                doMfmMarkerByte = false;
            } else {
                continue;
            }
            switch (dataByte) {
                case IbmDiscFormat.idMarkDataPattern: {
                    sector = new Sector(this, isMfm, pulseIndex + 1);
                    sectors.push(sector);
                    shiftRegister = 0;
                    numShifts = 0;
                    break;
                }
                case IbmDiscFormat.dataMarkDataPattern:
                case IbmDiscFormat.deletedDataMarkDataPattern:
                    if (!sector || sector.bitPosData) {
                        console.log(`Sector data without header ${this.description}`);
                    } else {
                        sector.bitPosData = pulseIndex + 1;
                        if (dataByte === IbmDiscFormat.deletedDataMarkDataPattern) {
                            sector.isDeleted = true;
                        }
                        shiftRegister = 0;
                        numShifts = 0;
                    }
                    break;
                default:
                    console.log(`Unknown marker byte ${utils.hexbyte(dataByte)} ${this.description}`);
            }
        }
        return sectors;
    }
}

class Side {
    constructor(upper, initialByte) {
        this.tracks = [];
        for (let i = 0; i < IbmDiscFormat.tracksPerDisc; ++i) this.tracks[i] = new Track(upper, i, initialByte);
    }
}

export class DiscConfig {
    constructor() {
        this.logProtection = false;
        this.logIffyPulses = false;
        this.expandTo80 = false;
        this.isQuantizeFm = false;
        this.isSkipOddTracks = false;
        this.isSkipUpperSide = false;
        this.rev = 0;
        this.revSpec = "";
    }
}

class SsdFormat {
    static get sectorSize() {
        return 256;
    }

    static get sectorsPerTrack() {
        return 10;
    }

    static get tracksPerDisc() {
        return 80;
    }
}

/**
 * @param {Disc} disc
 * @param {Uint8Array} data
 * @param {boolean} isDsd
 */
export function loadSsd(disc, data, isDsd) {
    const numSides = isDsd ? 2 : 1;
    if (data.length % SsdFormat.sectorSize !== 0) {
        throw new Error("SSD file size is not a multiple of sector size");
    }
    const maxSize = SsdFormat.sectorSize * SsdFormat.sectorsPerTrack * SsdFormat.tracksPerDisc * numSides;
    if (data.length > maxSize) {
        throw new Error("SSD file is too large");
    }

    let offset = 0;
    for (let track = 0; track < SsdFormat.tracksPerDisc; ++track) {
        for (let side = 0; side < numSides; ++side) {
            const trackBuilder = disc.buildTrack(side === 1, track);
            // Sync pattern at start of track, as the index pulse starts, aka GAP 5.
            trackBuilder
                .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
                .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s);

            for (let sector = 0; sector < SsdFormat.sectorsPerTrack; ++sector) {
                // Sector header, aka ID.
                trackBuilder
                    .resetCrc()
                    .appendFmDataAndClocks(IbmDiscFormat.idMarkDataPattern, IbmDiscFormat.markClockPattern)
                    .appendFmByte(track)
                    .appendFmByte(0)
                    .appendFmByte(sector)
                    .appendFmByte(1)
                    .appendCrc(false);

                // Sync pattern between sector header and sector data, aka GAP 2.
                trackBuilder
                    .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
                    .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s);

                // Sector data.
                trackBuilder
                    .resetCrc()
                    .appendFmDataAndClocks(IbmDiscFormat.dataMarkDataPattern, IbmDiscFormat.markClockPattern)
                    .appendFmChunk(data.subarray(offset, offset + SsdFormat.sectorSize))
                    .appendCrc(false);

                offset += SsdFormat.sectorSize;

                if (sector !== SsdFormat.sectorsPerTrack - 1) {
                    // Sync pattern between sectors, aka GAP 3.
                    trackBuilder
                        .appendRepeatFmByte(0xff, IbmDiscFormat.std10SectorGap3FFs)
                        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s);
                }
            }
            trackBuilder.fillFmByte(0xff);
        }
    }
    return disc;
}

export class Disc {
    /**
     * @returns {Disc} a new blank disc
     */
    static createBlank() {
        return new Disc(true, true, new DiscConfig());
    }

    /**
     * @param {boolean} isWriteable
     * @param {boolean} isMutable
     * @param {DiscConfig} config
     */
    constructor(isWriteable, isMutable, config) {
        this.config = config;

        this.isDirty = false;
        this.dirtySide = -1;
        this.dirtyTrack = -1;
        this.tracksUsed = 0;
        this.isDoubleSided = false;

        // todo look up file extensions, populate write callback. of maybe support
        // in memory changes?
        this.writeTrackCallback = undefined;

        // TODO massive rethink of this
        // if (isMutable && !this.writeTrackCallback) {
        //     console.log("Cannot writeback to file type, making read only");
        //     isMutable = isWriteable = false; // TODO reconsider
        // }

        this.isWriteable = isWriteable;
        this.isMutableRequested = isMutable;
        this.isMutable = false; // set by load

        // TODO disc surface builders for
        this.load();
    }

    get writeProtected() {
        return !this.isWriteable;
    }

    /** @returns {Track} */
    getTrack(isSideUpper, trackNum) {
        return isSideUpper ? this.upperSide.tracks[trackNum] : this.lowerSide.tracks[trackNum];
    }

    buildTrack(isSideUpper, trackNum) {
        this.setTrackUsed(isSideUpper, trackNum);
        return new TrackBuilder(this.getTrack(isSideUpper, trackNum));
    }

    setTrackUsed(isSideUpper, trackNum) {
        if (isSideUpper) this.isDoubleSided = true;
        this.tracksUsed = Math.max(this.tracksUsed, trackNum + 1);
    }

    load() {
        this.initSurface(0);
        // various loads builders etc
    }

    initSurface(initialByte) {
        this.lowerSide = new Side(false, initialByte);
        this.upperSide = new Side(true, initialByte);

        this.tracksUsed = 0;
        this.isDoubleSided = false;
    }

    readPulses(isSideUpper, track, position) {
        return this.getTrack(isSideUpper, track).pulses2Us[position];
    }

    /**
     * @param {boolean} isSideUpper
     * @param {Number} track
     * @param {Number} position
     * @param {Number} pulses
     */
    writePulses(isSideUpper, track, position, pulses) {
        const trackObj = this.getTrack(isSideUpper, track);
        if (position >= trackObj.length)
            throw new Error(`Attempt to write off end of track ${position} > ${track.length}`);
        if (this.isDirty) {
            if (isSideUpper !== this.dirtySide || track !== this.dirtyTrack)
                throw new Error("Switched dirty track or side");
        }
        this.isDirty = true;
        this.dirtySide = isSideUpper;
        this.dirtyTrack = track;
        trackObj.pulses2Us[position] = pulses;
    }

    flushWrites() {
        if (!this.isDirty) {
            if (this.dirtySide !== -1 || this.dirtyTrack !== -1) throw new Error("Bad state in disc dirty tracking");
            return;
        }

        const dirtySide = this.dirtySide;
        const dirtyTrack = this.dirtyTrack;
        this.isDirty = false;
        this.dirtySide = -1;
        this.dirtyTrack = -1;
        if (!this.isMutable) return;
        const trackObj = this.getTrack(dirtySide, dirtyTrack);
        this.writeTrackCallback(this, dirtySide, dirtyTrack, trackObj.length, trackObj.pulses2Us);
        this.setTrackUsed(dirtySide, dirtyTrack);
    }

    logSummary() {
        const maxTrack = this.tracksUsed;
        const numSides = this.isDoubleSided ? 2 : 1;
        for (let side = 0; side < numSides; ++side) {
            for (let trackNum = 0; trackNum < maxTrack; ++trackNum) {
                const track = this.getTrack(side === 1, trackNum);
                const sectors = track.findSectors();
                if (sectors.length) {
                    if (track.length >= IbmDiscFormat.bytesPerTrack * 1.015) {
                        console.log(`Long track ${track.description}, ${track.length} bytes`);
                    } else if (track.length <= IbmDiscFormat.bytesPerTrack * 0.985) {
                        console.log(`Short track ${track.description}, ${track.length} bytes`);
                    }
                    if (sectors[0].isMfm) {
                        if (sectors.length !== 16 && sectors.length !== 18) {
                            console.log(`Non-standard MFM sector count ${track.description} count ${sectors.length}`);
                        }
                    } else {
                        if (sectors.length !== 10) {
                            console.log(`Non-standard FM sector count ${track.description} count ${sectors.length}`);
                        }
                    }
                } else {
                    console.log(`"Unformatted track ${track.description}"`);
                }
            }
            // TODO add fingerprintings, catalog etcetc
        }
    }
}

export class IbmDiscFormat {
    static get bytesPerTrack() {
        return 3125;
    }

    static get tracksPerDisc() {
        return 84;
    }

    static get markClockPattern() {
        return 0xc7;
    }

    static get idMarkDataPattern() {
        return 0xfe;
    }

    static get dataMarkDataPattern() {
        return 0xfb;
    }

    static get deletedDataMarkDataPattern() {
        return 0xf8;
    }

    static get mfmA1Sync() {
        return 0x4489;
    }

    static get mfmC2Sync() {
        return 0x5224;
    }

    static get stdSync00s() {
        return 6;
    }

    static get stdGap1FFs() {
        return 16;
    }

    static get stdGap2FFs() {
        return 11;
    }

    static get std10SectorGap3FFs() {
        return 21;
    }

    static crcInit(is_mfm) {
        // MFM starts with 3x 0xA1 sync bytes added.
        return is_mfm ? 0xcdb4 : 0xffff;
    }

    static crcAddByte(crc, byte) {
        for (let i = 0; i < 8; ++i) {
            const bit = byte & 0x80;
            const bitTest = (crc & 0x8000) ^ (bit << 8);
            crc = (crc << 1) & 0xffff;
            if (bitTest) crc ^= 0x1021;
            byte <<= 1;
        }
        return crc;
    }
    static crcAddBytes(crc, bytes) {
        for (const byte of bytes) crc = IbmDiscFormat.crcAddByte(crc, byte);
        return crc;
    }

    static fmTo2usPulses(clocks, data) {
        let ret = 0;
        for (let i = 0; i < 8; ++i) {
            ret <<= 4;
            if (clocks & 0x80) ret |= 0x04;
            if (data & 0x80) ret |= 0x01;
            clocks = (clocks << 1) & 0xff;
            data = (data << 1) & 0xff;
        }
        return ret;
    }

    static _2usPulsesToFm(pulses) {
        let clocks = 0;
        let data = 0;
        let iffyPulses = false;
        for (let i = 0; i < 8; ++i) {
            clocks <<= 1;
            data <<= 1;
            if (pulses & 0x80000000) clocks |= 0x01;
            if (pulses & 0x20000000) data |= 0x01;
            // Any pulses off the 2us clock are suspicious FM data.
            if (pulses & 0x50000000) iffyPulses = true;
            pulses = (pulses << 4) & 0xffffffff;
        }
        return { clocks, data, iffyPulses };
    }

    static mfmTo2usPulses(lastBit, data) {
        let pulses = 0;
        for (let i = 0; i < 8; ++i) {
            const bit = !!(data & 0x80);
            pulses = (pulses << 2) & 0xffff;
            data <<= 1;
            if (bit) pulses |= 0x01;
            else if (!lastBit) pulses |= 0x02;
            lastBit = bit;
        }
        return { lastBit, pulses };
    }

    static _2usPulsesToMfm(pulses) {
        let byte = 0;
        for (let i = 0; i < 8; ++i) {
            byte <<= 1;
            if ((pulses & 0xc000) === 0x4000) byte |= 1;
            pulses = (pulses << 2) & 0xffff;
        }
        return byte;
    }

    static checkPulse(pulseUs, isMfm) {
        if (pulseUs < 3.5 || pulseUs > 8.5) return false;
        if (isMfm && pulseUs > 5.5 && pulseUs < 6.5) return true;
        return !(pulseUs > 4.5 && pulseUs < 7.5);
    }
}
