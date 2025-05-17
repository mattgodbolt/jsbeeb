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
        if (this._index > this._track.pulses2Us.length)
            throw new Error(`Track buffer overflow in ${this._track.description}`);
        if (this._index !== 0) this._track.length = this._index;
        return this;
    }

    resetCrc() {
        this._crc = IbmDiscFormat.crcInit(false);
        return this;
    }

    appendFmDataAndClocks(data, clocks) {
        if (this._index >= this._track.pulses2Us.length)
            throw new Error(`Track buffer overflow in ${this._track.description}`);
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
        if (this._index >= this._track.pulses2Us.length)
            throw new Error(`Track buffer overflow in ${this._track.description}`);
        // Fill to standard track size or buffer capacity, whichever is smaller
        const fillCount = Math.min(IbmDiscFormat.bytesPerTrack, this._track.pulses2Us.length) - this._index;
        this.appendRepeatFmByte(data, fillCount);
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
        if (this._index >= this._track.pulses2Us.length)
            throw new Error(`Track buffer overflow in ${this._track.description}`);
        const existingPulses = this._track.pulses2Us[this._index];
        const mask = 0xffff << this._pulsesIndex;
        this._pulsesIndex = (this._pulsesIndex + 16) & 31;
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
        if (this._index >= this._track.pulses2Us.length)
            throw new Error(`Track buffer overflow in ${this._track.description}`);
        // Fill to standard track size or buffer capacity, whichever is smaller
        const maxFill = Math.min(IbmDiscFormat.bytesPerTrack, this._track.pulses2Us.length);
        while (this._index < maxFill) this.appendMfmByte(data);
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
            if (this._index >= this._track.pulses2Us.length) return false;
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
        const data = new Uint8Array(numBytes);
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
        let crc = IbmDiscFormat.crcInit(false);
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
        return IbmDiscFormat.crcInit(false);
    }
}

class Sector {
    /**
     * @param {Track} track
     * @param {boolean} isMfm
     * @param {Number} idPosBitOffset
     */
    constructor(track, isMfm, idPosBitOffset) {
        this.track = track;
        this.isMfm = isMfm;
        this.idPosBitOffset = idPosBitOffset;
        this.dataPosBitOffset = null;
        this.isDeleted = false;
        this.sectorData = null;
        this.hasDataCrcError = false;
        this.byteLength = null;

        const idReader = this._readerAt(this.idPosBitOffset);
        const { data: headerData, iffyPulses } = idReader.read(6);
        if (iffyPulses) {
            console.log(`Iffy pulse in sector header ${this.description}`);
        }
        this.header = headerData;
        let crc = idReader.initialCrc;
        crc = IbmDiscFormat.crcAddByte(crc, IbmDiscFormat.idMarkDataPattern);
        crc = IbmDiscFormat.crcAddBytes(crc, this.header.slice(0, 4));
        const discCrc = (this.header[4] << 8) | this.header[5];
        this.hasHeaderCrcError = crc !== discCrc;
    }

    _readerAt(bitOffset) {
        const rawReader = new RawDiscReader(this.track, bitOffset);
        return this.isMfm ? new MfmReader(rawReader) : new FmReader(rawReader);
    }

    get trackNumber() {
        return this.header ? this.header[0] : undefined;
    }

    get sectorNumber() {
        return this.header ? this.header[2] : undefined;
    }

    get description() {
        return `${this.track.description} idpos ${this.idPosBitOffset} idtrack ${this.trackNumber} idsector ${this.sectorNumber} datapos ${this.dataPosBitOffset}`;
    }

    /**
     * @param {Sector|undefined} nextSector
     */
    read(nextSector) {
        const pulsesPerByte = this.isMfm ? 16 : 32; // todo put in reader
        if (this.dataPosBitOffset === null) {
            console.log(`"Sector header without data ${this.description}"`);
            return;
        }

        const dataMarker = this.isDeleted
            ? IbmDiscFormat.deletedDataMarkDataPattern
            : IbmDiscFormat.dataMarkDataPattern;
        const sectorStartByte = (this.dataPosBitOffset / pulsesPerByte) | 0;
        const sectorEndByte =
            (nextSector ? nextSector.idPosBitOffset / pulsesPerByte : (this.track.length * 32) / pulsesPerByte) | 0;
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
            console.log(`"Iffy pulse in sector data ${this.description}"`);
        }
    }

    _tryLoadSectorData(dataMarker, sectorSize) {
        const dataReader = this._readerAt(this.dataPosBitOffset);
        let crc = IbmDiscFormat.crcAddByte(dataReader.initialCrc, dataMarker);
        const { data: sectorData, iffyPulses } = dataReader.read(sectorSize + 2);
        crc = IbmDiscFormat.crcAddBytes(crc, sectorData.slice(0, sectorSize));
        const dataCrc = (sectorData[sectorSize] << 8) | sectorData[sectorSize + 1];
        // The CRC bytes are used for error-checking and are not part of the actual sector data payload.
        // Therefore, we exclude the last two bytes (CRC) from the returned `sectorData`.
        return { crcOk: dataCrc === crc, sectorData: sectorData.slice(0, sectorSize), iffyPulses };
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
        this.length = IbmDiscFormat.bytesPerTrack; // Default size, will be updated when track is populated
        this.upper = upper;
        this.trackNum = trackNum;
        // Make room for any extra pulses that might come from non-standard discs.
        this.pulses2Us = new Uint32Array(IbmDiscFormat.bytesPerTrack * 2);
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
            if ((pulseIndex & 31) === 0) pulses = this.pulses2Us[pulseIndex >>> 5];
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
                    if (!sector || sector.dataPosBitOffset) {
                        console.log(
                            `Sector data without header ${this.description}; mark bitpos ${pulseIndex}; previous good sector ${sector ? sector.description : "none"}`,
                        );
                    } else {
                        sector.dataPosBitOffset = pulseIndex + 1;
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
        // TODO is this even useful?
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
 * Load a disc image in SSD (Single Sided Disc) or DSD (Double Sided Disc) format
 * @param {Disc} disc - The disc object to load into
 * @param {Uint8Array} data - The disc image data
 * @param {boolean} isDsd - True if loading a double-sided disc
 * @param {function(Uint8Array): void} onChange - Optional callback when disc content changes
 */
export function loadSsd(disc, data, isDsd, onChange) {
    const blankSector = new Uint8Array(SsdFormat.sectorSize);
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
                const sectorData =
                    offset < data.length ? data.subarray(offset, offset + SsdFormat.sectorSize) : blankSector;
                offset += SsdFormat.sectorSize;
                trackBuilder
                    .resetCrc()
                    .appendFmDataAndClocks(IbmDiscFormat.dataMarkDataPattern, IbmDiscFormat.markClockPattern)
                    .appendFmChunk(sectorData)
                    .appendCrc(false);

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

    if (onChange) {
        // TODO, maybe construct the disc directly with this stuff?
        // TODO maybe change this entirely and make it lazy; and have the onChange "pull" the disc as the format it wants
        // instead of doing this here. Most stuff doesn't care about changes and only needs the image on save.
        // Create a dataCopy large enough for all the sectors and tracks.
        const dataCopy = new Uint8Array(maxSize);
        dataCopy.set(data);
        disc.setWriteTrackCallback(
            /** @param {Track} trackObj  */
            (side, trackNum, trackObj) => {
                const trackOffset =
                    SsdFormat.sectorSize * SsdFormat.sectorsPerTrack * (trackNum * numSides + (side ? 1 : 0));
                for (const sector of trackObj.findSectors()) {
                    const sectorOffset = sector.sectorNumber * SsdFormat.sectorSize;
                    for (let x = 0; x < SsdFormat.sectorSize; ++x)
                        dataCopy[trackOffset + sectorOffset + x] = sector.sectorData[x];
                }
                onChange(dataCopy);
            },
        );
    }
    return disc;
}

class AdfFormat {
    static get sectorSize() {
        return 256;
    }

    static get sectorsPerTrack() {
        return 16;
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
export function loadAdf(disc, data, isDsd) {
    const blankSector = new Uint8Array(AdfFormat.sectorSize);
    const numSides = isDsd ? 2 : 1;
    if (data.length % AdfFormat.sectorSize !== 0) {
        throw new Error("ADF file size is not a multiple of sector size");
    }
    const maxSize = AdfFormat.sectorSize * AdfFormat.sectorsPerTrack * AdfFormat.tracksPerDisc * numSides;
    if (data.length > maxSize) {
        throw new Error("ADF file is too large");
    }

    let offset = 0;
    for (let track = 0; track < AdfFormat.tracksPerDisc; ++track) {
        if (offset >= data.length) break;

        for (let side = 0; side < numSides; ++side) {
            // Using recommended values from the 177x datasheet.
            const trackBuilder = disc.buildTrack(side === 1, track);
            trackBuilder.appendRepeatMfmByte(0x4e, 60);
            for (let sector = 0; sector < AdfFormat.sectorsPerTrack; ++sector) {
                trackBuilder
                    .appendRepeatMfmByte(0x00, 12)
                    .resetCrc()
                    .appendMfm3xA1Sync()
                    .appendMfmByte(IbmDiscFormat.idMarkDataPattern)
                    .appendMfmByte(track)
                    .appendMfmByte(0)
                    .appendMfmByte(sector)
                    .appendMfmByte(1)
                    .appendCrc(true);

                // Sync pattern between sector header and sector data, aka GAP 2.
                trackBuilder.appendRepeatMfmByte(0x4e, 22).appendRepeatMfmByte(0x00, 12);

                // Sector data.
                const sectorData =
                    offset < data.length ? data.subarray(offset, offset + AdfFormat.sectorSize) : blankSector;
                offset += AdfFormat.sectorSize;
                trackBuilder
                    .resetCrc()
                    .appendMfm3xA1Sync()
                    .appendMfmByte(IbmDiscFormat.dataMarkDataPattern)
                    .appendMfmChunk(sectorData)
                    .appendCrc(true);

                // Sync pattern between sectors, aka GAP 3.
                trackBuilder.appendRepeatMfmByte(0x4e, 24);
            }
            trackBuilder.fillMfmByte(0x4e);
        }
    }

    // TODO writeback
    return disc;
}

/**
 * @returns {Uint8Array}
 * @param {Disc} disc
 */
export function toSsdOrDsd(disc) {
    const numSides = disc.isDoubleSided ? 2 : 1;
    const result = new Uint8Array(
        numSides * SsdFormat.tracksPerDisc * SsdFormat.sectorsPerTrack * SsdFormat.sectorSize,
    );
    let offset = 0;
    for (let trackNum = 0; trackNum < disc.tracksUsed; ++trackNum) {
        for (let side = 0; side < numSides; ++side) {
            const trackObj = disc.getTrack(side === 1, trackNum);
            for (const sector of trackObj.findSectors()) {
                const sectorOffset = offset + sector.sectorNumber * SsdFormat.sectorSize;
                if (sector.hasDataCrcError || sector.hasHeaderCrcError) {
                    console.log(`Skipping sector ${sector.description} with bad CRC`);
                    continue;
                }
                for (let x = 0; x < SsdFormat.sectorSize; ++x) result[sectorOffset + x] = sector.sectorData[x];
            }
            offset += SsdFormat.sectorsPerTrack * SsdFormat.sectorSize;
        }
    }
    return result.slice(0, offset);
}

export class Disc {
    /**
     * @returns {Disc} a new blank disc
     */
    static createBlank() {
        return new Disc(true, new DiscConfig());
    }

    /**
     * @param {boolean} isWriteable
     * @param {DiscConfig} config
     * @param {string} name
     */
    constructor(isWriteable, config, name) {
        this.config = config;

        this.name = name;
        this.isDirty = false;
        this.dirtySide = -1;
        this.dirtyTrack = -1;
        this.tracksUsed = 0;
        this.isDoubleSided = false;

        this.writeTrackCallback = undefined;
        this.isWriteable = isWriteable;

        this.initSurface(0);
    }

    setWriteTrackCallback(callback) {
        this.writeTrackCallback = callback;
    }

    get writeProtected() {
        return !this.isWriteable;
    }

    /**
     * @param {boolean} isSideUpper
     * @param {Number} trackNum
     * @returns {Track} */
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
        // TODO a debug log flag for this
        // console.log(`wrote to ${track}:${position * 32}`);
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
        if (!this.writeTrackCallback) return;
        const trackObj = this.getTrack(dirtySide, dirtyTrack);
        this.writeTrackCallback(dirtySide, dirtyTrack, trackObj);
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
                    /// MG stuff
                    for (const sector of sectors) {
                        if (sector.hasHeaderCrcError) console.log(`${sector.description} has bad header crc`);
                        if (sector.trackNumber !== trackNum) console.log(`${sector.description} has bad track id`);
                        if (sector.hasDataCrcError) console.log(`${sector.description} has bad data crc`);
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

    /**
     * @param {boolean} isMfm
     * @returns {Number} initial CRC for type
     */
    static crcInit(isMfm) {
        // MFM starts with 3x 0xA1 sync bytes added.
        return isMfm ? 0xcdb4 : 0xffff;
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
