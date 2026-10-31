// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit

import { crc32 } from "./archive.js";
import { IbmDiscFormat } from "./disc-format.js";
import { hexbyte } from "./hex.js";

export const PulsesPerWord = 32;

// The 1770 datasheet's recommended MFM gaps, in bytes.
const MfmGap1_4Es = 60;
const MfmSync00s = 12;
const MfmGap2_4Es = 22;
const MfmGap3_4Es = 24;

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
        this._isMfm = false;
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
        this._isMfm = false;
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

    appendFmChunk(bytes) {
        for (const byte of bytes) this.appendFmByte(byte);
        return this;
    }

    appendCrc() {
        const firstByte = (this._crc >>> 8) & 0xff;
        const secondByte = this._crc & 0xff;
        if (this._isMfm) {
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
        this._isMfm = true;
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
     * An FM sector: its ID record, gap 2 and data record.
     * @param {{idMark: number, dataMark: number, track: number, head: number, sector: number, lengthCode: number,
     *     data: Uint8Array}} sector
     */
    appendFmSector({ idMark, dataMark, track, head, sector, lengthCode, data }) {
        return this.resetCrc()
            .appendFmDataAndClocks(idMark, IbmDiscFormat.markClockPattern)
            .appendFmChunk([track, head, sector, lengthCode])
            .appendCrc()
            .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
            .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
            .resetCrc()
            .appendFmDataAndClocks(dataMark, IbmDiscFormat.markClockPattern)
            .appendFmChunk(data)
            .appendCrc();
    }

    /**
     * An MFM sector as the 1770 datasheet lays it out: the sync before its ID record, the ID record, gap 2 and the
     * data record.
     * @param {{idMark: number, dataMark: number, track: number, head: number, sector: number, lengthCode: number,
     *     data: Uint8Array}} sector
     */
    appendMfmSector({ idMark, dataMark, track, head, sector, lengthCode, data }) {
        return this.appendRepeatMfmByte(0x00, MfmSync00s)
            .resetCrc()
            .appendMfm3xA1Sync()
            .appendMfmChunk([idMark, track, head, sector, lengthCode])
            .appendCrc()
            .appendRepeatMfmByte(0x4e, MfmGap2_4Es)
            .appendRepeatMfmByte(0x00, MfmSync00s)
            .resetCrc()
            .appendMfm3xA1Sync()
            .appendMfmByte(dataMark)
            .appendMfmChunk(data)
            .appendCrc();
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

    static pulsesPerByte = 16;

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
        return { data, iffyPulses: false };
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

    static pulsesPerByte = 32;

    read(numBytes) {
        const data = new Uint8Array(numBytes);
        let iffyPulses = false;
        for (let offset = 0; offset < numBytes; ++offset) {
            const pulses = this._rawReader.readPulses();
            const { data: dataByte, iffyPulses: iffy } = IbmDiscFormat._2usPulsesToFm(pulses);
            data[offset] = dataByte;
            iffyPulses |= iffy;
        }
        return { data, iffyPulses };
    }

    get initialCrc() {
        return IbmDiscFormat.crcInit(false);
    }
}

/**
 * Where the sector decoder reports something odd on a track: what, and how far round the track, in
 * pulses from the index.
 * @typedef {function(string, number): void} DecoderWarning
 */

const ignoreWarnings = () => {};

class Sector {
    /**
     * @param {Track} track
     * @param {boolean} isMfm
     * @param {Number} idPosBitOffset
     * @param {DecoderWarning} warn
     */
    constructor(track, isMfm, idPosBitOffset, warn) {
        this.track = track;
        this.isMfm = isMfm;
        this._readerType = isMfm ? MfmReader : FmReader;
        this._warn = warn;
        this.idPosBitOffset = idPosBitOffset;
        this.dataPosBitOffset = null;
        this.isDeleted = false;
        this.sectorData = null;
        this.hasDataCrcError = false;
        this.byteLength = null;

        const idReader = this._readerAt(this.idPosBitOffset);
        const { data: headerData, iffyPulses } = idReader.read(6);
        if (iffyPulses) {
            this._warn(`iffy pulse in sector ${this.sectorNumber}'s header`, this.idPosBitOffset);
        }
        this.header = headerData;
        let crc = idReader.initialCrc;
        crc = IbmDiscFormat.crcAddByte(crc, IbmDiscFormat.idMarkDataPattern);
        crc = IbmDiscFormat.crcAddBytes(crc, this.header.slice(0, 4));
        const discCrc = (this.header[4] << 8) | this.header[5];
        this.hasHeaderCrcError = crc !== discCrc;
    }

    _readerAt(bitOffset) {
        return new this._readerType(new RawDiscReader(this.track, bitOffset));
    }

    get pulsesPerByte() {
        return this._readerType.pulsesPerByte;
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
        if (this.dataPosBitOffset === null) {
            this._warn(`sector ${this.sectorNumber}'s header has no data after it`, this.idPosBitOffset);
            return;
        }

        const { pulsesPerByte } = this;
        const dataMarker = this.isDeleted
            ? IbmDiscFormat.deletedDataMarkDataPattern
            : IbmDiscFormat.dataMarkDataPattern;
        const sectorStartByte = (this.dataPosBitOffset / pulsesPerByte) | 0;
        const sectorEndByte =
            (nextSector
                ? nextSector.idPosBitOffset / pulsesPerByte
                : (this.track.length * PulsesPerWord) / pulsesPerByte) | 0;
        // Account for CRC and sync bytes.
        let sectorSize = Sector.toSectorSize(sectorEndByte - sectorStartByte - 5);

        this.hasDataCrcError = true;
        let seenIffyData;
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
            this._warn(`iffy pulse in sector ${this.sectorNumber}'s data`, this.dataPosBitOffset);
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

/**
 * A 64 bit shift register, held as a pair of unsigned 32 bit halves. BigInt would say this more
 * directly but costs an order of magnitude more per bit shifted.
 */
export class BitWindow64 {
    constructor() {
        this.hi = 0;
        this.lo = 0;
    }

    /**
     * @param {Number} bit 0 or 1, shifted into bit 0
     */
    shiftIn(bit) {
        this.hi = ((this.hi << 1) | (this.lo >>> 31)) >>> 0;
        this.lo = ((this.lo << 1) | bit) >>> 0;
    }

    /**
     * @returns {boolean} whether all 64 bits match the halves given
     */
    equals(hi, lo) {
        return this.hi === hi && this.lo === lo;
    }

    /**
     * @param {Number} nibble
     * @returns {Number} the length of the run of `nibble` ending at bit 0
     */
    countTrailingNibbles(nibble) {
        const nibblesPerHalf = 8;
        let count = 0;
        for (let bits = this.lo; (bits & 0xf) === nibble; bits >>>= 4) count++;
        // Only a low half that matched all the way up can have a run continuing into the high half.
        if (count === nibblesPerHalf) for (let bits = this.hi; (bits & 0xf) === nibble; bits >>>= 4) count++;
        return count;
    }

    /** @returns {string} the 64 bits as an unsigned decimal, the form snapshots store */
    snapshotState() {
        return ((BigInt(this.hi) << 32n) | BigInt(this.lo)).toString();
    }

    /** @param {string} decimal from snapshotState */
    restoreState(decimal) {
        const value = BigInt(decimal);
        this.hi = Number(value >> 32n);
        this.lo = Number(value & 0xffffffffn);
    }
}

const BitWindowBits = 64;
// What the mark detector holds at an address mark. The FM case only pins down the high half,
// the tail of the zero sync run; the low half is the marker byte itself, decoded separately.
const FmSyncHi = 0x88888888;
const MfmMarkerHi = 0xaaaa4489;
const MfmMarkerLo = 0x44894489;
// FM puts each data bit's clock pulse in the top bit of its nibble.
const FmClockPulses = 0x88888888;
const FmMarkClockPulses = IbmDiscFormat.fmTo2usPulses(IbmDiscFormat.markClockPattern, 0);
// One data bit of zero, FM encoded with its clock, is the pulse nibble 0x8.
const FmZeroBitPulses = 0x8;
// FmSyncHi is eight of those, so a match has already seen this much of the sync run.
const FmSyncHiZeroBits = 8;
// Sync is counted in zero data bits, so a run no longer than two bytes' worth is short enough
// to be worth logging.
const ShortSyncZeros = 16;

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
     * @param {DecoderWarning} [warn] where to report anomalies; nowhere by default
     * @returns {Sector[]}
     */
    findSectors(warn = ignoreWarnings) {
        const sectors = this.findSectorIds(warn);
        for (let sectorIndex = 0; sectorIndex !== sectors.length; ++sectorIndex) {
            const nextSector = sectors[sectorIndex + 1]; // Will be unset for last
            sectors[sectorIndex].read(nextSector);
        }
        return sectors;
    }

    /**
     * @param {Number} bitIndex
     * @returns {Number} the pulse at `bitIndex`, 0 or 1; the first word's top bit is bit 0
     */
    _pulseAt(bitIndex) {
        const word = this.pulses2Us[Math.floor(bitIndex / PulsesPerWord)];
        const bitFromTop = bitIndex % PulsesPerWord;
        return (word >>> (PulsesPerWord - 1 - bitFromTop)) & 1;
    }

    /**
     * @param {Number} lastBit
     * @returns {BitWindow64} the pulses up to and including `lastBit`; bits before the track's start
     *     read as zero
     */
    _pulseWindowEndingAt(lastBit) {
        const window = new BitWindow64();
        const firstBit = Math.max(0, lastBit - BitWindowBits + 1);
        for (let bit = firstBit; bit <= lastBit; ++bit) window.shiftIn(this._pulseAt(bit));
        return window;
    }

    /**
     * @param {DecoderWarning} [warn] where to report anomalies; nowhere by default
     * @returns {Sector[]}
     */
    findSectorIds(warn = ignoreWarnings) {
        const sectors = [];
        // Pass 1: walk the track and find header and data markers.
        const bitLength = this.length * 32;
        let shiftRegister = 0;
        let numShifts = 0;
        let doMfmMarkerByte = false;
        let isMfm = false;
        let pulses = 0;
        const markDetector = new BitWindow64();
        let dataByte;
        let sector = null;
        for (let pulseIndex = 0; pulseIndex < bitLength; ++pulseIndex) {
            if ((pulseIndex & 31) === 0) pulses = this.pulses2Us[pulseIndex >>> 5];
            const pulseBit = pulses >>> 31;
            markDetector.shiftIn(pulseBit);
            shiftRegister = ((shiftRegister << 1) | pulseBit) & 0xffffffff;
            numShifts++;
            pulses = (pulses << 1) & 0xffffffff;
            if (markDetector.hi === FmSyncHi && (markDetector.lo & FmClockPulses) >>> 0 === FmMarkClockPulses) {
                const { clocks, data, iffyPulses } = IbmDiscFormat._2usPulsesToFm(markDetector.lo);
                if (iffyPulses || clocks !== IbmDiscFormat.markClockPattern) continue;
                isMfm = false;
                doMfmMarkerByte = false;
                const syncBefore = this._pulseWindowEndingAt(pulseIndex - BitWindowBits);
                const num0s = FmSyncHiZeroBits + syncBefore.countTrailingNibbles(FmZeroBitPulses);
                if (num0s <= ShortSyncZeros) {
                    warn("short zeros sync before an address mark", pulseIndex);
                }
                dataByte = data;
            } else if (markDetector.equals(MfmMarkerHi, MfmMarkerLo)) {
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
                    sector = new Sector(this, isMfm, pulseIndex + 1, warn);
                    sectors.push(sector);
                    shiftRegister = 0;
                    numShifts = 0;
                    break;
                }
                case IbmDiscFormat.dataMarkDataPattern:
                case IbmDiscFormat.deletedDataMarkDataPattern:
                    if (!sector || sector.dataPosBitOffset) {
                        warn("sector data without a header", pulseIndex);
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
                    warn(`unknown marker byte &${hexbyte(dataByte)}`, pulseIndex);
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

/** How an image's tracks are laid out on the surface, and whether that is for the loader to decide. */
export const DiscLayout = Object.freeze({
    auto: "auto",
    contiguous: "contiguous",
    expanded40: "expanded40",
});

export class DiscConfig {
    constructor() {
        this.expandTo80 = false;
        this.isSkipOddTracks = false;
        this.isSkipUpperSide = false;
    }
}

// Acorn's *FORM puts each track's sector 0 three slots later than the track before, as do Greaseweazle and FlashFloppy
// for SSDs, which leaves room to step and settle before it comes round.
const SsdTrackSkew = 3;

// Both formats' sectors are 256 bytes, which an ID record's length code gives as 128 << 1.
const SectorLengthCode = 1;
const SsdSectorSize = 256;
const SsdSectorsPerTrack = 10;
const SsdTracksPerDisc = 80;
const SsdTrackSize = SsdSectorSize * SsdSectorsPerTrack;

/** @returns {Number} how many logical tracks of `data` hold anything, ignoring a run of trailing zeros */
function tracksWithData(data, numSides) {
    let lastUsed = data.length - 1;
    while (lastUsed >= 0 && data[lastUsed] === 0) lastUsed--;
    return Math.floor(lastUsed / (SsdTrackSize * numSides)) + 1;
}

// The DFS catalogue is the first two sectors of a side. Sector 1 holds how many files there are and
// how many sectors the disc has.
const DfsEntryCountOffset = 0x105;
const DfsSectorCountOffset = 0x106;
const DfsEntrySize = 8;
const DfsMaxEntries = 31;

/**
 * Whether an SSD or DSD image was written by a 40 track drive. Only its catalogue can say: images
 * are routinely padded out or cut short, so their size means nothing.
 *
 * @param {Uint8Array} data
 * @param {boolean} isDsd
 * @returns {{is40Track: boolean, reason: string}}
 */
export function sniffDfsLayout(data, isDsd) {
    const contiguous = (reason) => ({ is40Track: false, reason });
    if (data.length < 2 * SsdSectorSize) return contiguous("it is smaller than a catalogue");
    const entryBytes = data[DfsEntryCountOffset];
    if (entryBytes % DfsEntrySize !== 0 || entryBytes > DfsMaxEntries * DfsEntrySize)
        return contiguous(`its catalogue claims ${entryBytes} bytes of file entries`);
    const sectors = ((data[DfsSectorCountOffset] & 3) << 8) | data[DfsSectorCountOffset + 1];
    const reason = `its catalogue claims ${sectors} sectors`;
    const fortyTrackSectors = (SsdTracksPerDisc / 2) * SsdSectorsPerTrack;
    if (sectors === 0 || sectors > fortyTrackSectors) return contiguous(reason);
    const tracks = tracksWithData(data, isDsd ? 2 : 1);
    if (tracks > IbmDiscFormat.tracksPerDisc / 2) return contiguous(`it holds data as far as track ${tracks - 1}`);
    return { is40Track: true, reason };
}

// The title is split across the two catalogue sectors, and the cycle number follows its second half.
const DfsTitleFirstHalf = 8;
const DfsTitleSecondHalf = 4;
const DfsCycleOffset = 4;
const DfsEntryCountInSector1 = DfsEntryCountOffset - SsdSectorSize;

const isPrintableAscii = (byte) => byte >= 0x20 && byte < 0x7f;

/**
 * What the DFS catalogue on one side of a loaded disc says it is called, and how many times it
 * has been written to, which between them are what was on the sticker.
 *
 * @param {Disc} disc
 * @param {boolean} [isSideUpper]
 * @returns {{title: string, cycle: string}|null} null when the side holds no DFS catalogue
 */
export function dfsCatalogue(disc, isSideUpper = false) {
    const sectors = new Map();
    for (const sector of disc.getTrack(isSideUpper, 0).findSectors()) {
        const usable =
            !sector.hasHeaderCrcError && !sector.hasDataCrcError && sector.sectorData?.length === SsdSectorSize;
        if (usable && !sectors.has(sector.sectorNumber)) sectors.set(sector.sectorNumber, sector.sectorData);
    }
    const sector0 = sectors.get(0);
    const sector1 = sectors.get(1);
    if (!sector0 || !sector1) return null;
    const entryBytes = sector1[DfsEntryCountInSector1];
    if (entryBytes % DfsEntrySize !== 0 || entryBytes > DfsMaxEntries * DfsEntrySize) return null;
    const titleBytes = [...sector0.subarray(0, DfsTitleFirstHalf), ...sector1.subarray(0, DfsTitleSecondHalf)];
    const title = String.fromCharCode(...titleBytes.filter(isPrintableAscii)).trimEnd();
    return { title, cycle: hexbyte(sector1[DfsCycleOffset]) };
}

// One track could match by luck; a disc's worth of them could not.
const MinDoubleSteppedTracks = 4;

/**
 * Whether a surface holds a 40 track format, going by where its sectors say they are: a track
 * written by a 48 tpi head sits at twice the number its own headers claim, with nothing readable
 * on the tracks between. Only a flux image can be asked this, since for any other format the
 * layout is the loader's own doing.
 *
 * @param {Disc} disc
 * @param {boolean} isSideUpper - the side to ask; a dual format disc's sides can differ
 * @returns {{is40Track: boolean, reason: string}}
 */
export function sniffSurfaceLayout(disc, isSideUpper) {
    let doubleStepped = 0;
    // Track 0 is where it claims to be at either pitch, so it says nothing.
    for (let trackNum = 1; trackNum < disc.tracksUsed; ++trackNum) {
        const sectors = disc.getTrack(isSideUpper, trackNum).findSectorIds();
        if (!sectors.length) continue;
        if (trackNum & 1) return { is40Track: false, reason: `track ${trackNum} holds sectors of its own` };
        if (sectors.some((sector) => sector.trackNumber === trackNum / 2)) doubleStepped++;
    }
    if (!doubleStepped) return { is40Track: false, reason: "no track sits at twice the number its sectors claim" };
    if (doubleStepped < MinDoubleSteppedTracks) {
        const sit = doubleStepped === 1 ? "track sits" : "tracks sit";
        return { is40Track: false, reason: `only ${doubleStepped} ${sit} at twice the number their sectors claim` };
    }
    return { is40Track: true, reason: `${doubleStepped} tracks sit at twice the number their sectors claim` };
}

/**
 * Load a disc image in SSD (Single Sided Disc) or DSD (Double Sided Disc) format
 * @param {Disc} disc - The disc object to load into
 * @param {Uint8Array} data - The disc image data
 * @param {boolean} isDsd - True if loading a double-sided disc
 * @param {function(Uint8Array): void} onChange - Optional callback when disc content changes
 */
export function loadSsd(disc, data, isDsd, onChange) {
    const blankSector = new Uint8Array(SsdSectorSize);
    const numSides = isDsd ? 2 : 1;
    if (data.length % SsdSectorSize !== 0) {
        const paddedLength = Math.ceil(data.length / SsdSectorSize) * SsdSectorSize;
        const padded = new Uint8Array(paddedLength);
        padded.set(data);
        data = padded;
    }
    const maxSize = SsdSectorSize * SsdSectorsPerTrack * SsdTracksPerDisc * numSides;
    if (data.length > maxSize) {
        throw new Error("SSD file is too large");
    }

    disc.is40Track = disc.config.expandTo80;
    const trackStep = disc.is40Track ? 2 : 1;
    // Tracks twice as far apart are half as many, and an image can run past the last of them as
    // far as the surface has room for.
    const numTracks = Math.min(
        IbmDiscFormat.tracksPerDisc / trackStep,
        Math.max(SsdTracksPerDisc / trackStep, tracksWithData(data, numSides)),
    );

    for (let track = 0; track < numTracks; ++track) {
        const firstSector = (SsdSectorsPerTrack - ((SsdTrackSkew * track) % SsdSectorsPerTrack)) % SsdSectorsPerTrack;
        for (let side = 0; side < numSides; ++side) {
            const trackOffset = (track * numSides + side) * SsdTrackSize;
            const trackBuilder = disc.buildTrack(side === 1, track * trackStep);
            // Sync pattern at start of track, as the index pulse starts, aka GAP 5.
            trackBuilder
                .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
                .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s);

            for (let slot = 0; slot < SsdSectorsPerTrack; ++slot) {
                const sector = (firstSector + slot) % SsdSectorsPerTrack;
                const offset = trackOffset + sector * SsdSectorSize;
                trackBuilder.appendFmSector({
                    idMark: IbmDiscFormat.idMarkDataPattern,
                    dataMark: IbmDiscFormat.dataMarkDataPattern,
                    track,
                    head: 0,
                    sector,
                    lengthCode: SectorLengthCode,
                    data: offset < data.length ? data.subarray(offset, offset + SsdSectorSize) : blankSector,
                });

                if (slot !== SsdSectorsPerTrack - 1) {
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
        // TODO(#822) maybe construct the disc directly with this stuff?
        // TODO(#822) maybe change this entirely and make it lazy; and have the onChange "pull" the disc as the format it wants
        // instead of doing this here. Most stuff doesn't care about changes and only needs the image on save.
        // Create a dataCopy large enough for all the sectors and tracks.
        const dataCopy = new Uint8Array(maxSize);
        dataCopy.set(data);
        disc.addTrackWriteListener(
            /** @param {Track} trackObj  */
            (side, _trackNum, trackObj) => {
                for (const sector of trackObj.findSectors())
                    if (!sectorShortfall(sector)) dataCopy.set(sector.sectorData, ssdOffsetOf(sector, side, numSides));
                onChange(dataCopy);
            },
            true,
        );
    }
    return disc;
}

const AdfSectorSize = 256;
const AdfSectorsPerTrack = 16;
const AdfTracksPerDisc = 80;

/**
 * @param {Disc} disc
 * @param {Uint8Array} data
 * @param {boolean} isDsd
 */
export function loadAdf(disc, data, isDsd) {
    const blankSector = new Uint8Array(AdfSectorSize);
    const numSides = isDsd ? 2 : 1;
    if (data.length % AdfSectorSize !== 0) {
        throw new Error("ADF file size is not a multiple of sector size");
    }
    const maxSize = AdfSectorSize * AdfSectorsPerTrack * AdfTracksPerDisc * numSides;
    if (data.length > maxSize) {
        throw new Error("ADF file is too large");
    }

    let offset = 0;
    for (let track = 0; track < AdfTracksPerDisc; ++track) {
        if (offset >= data.length) break;

        for (let side = 0; side < numSides; ++side) {
            // Using recommended values from the 177x datasheet.
            const trackBuilder = disc.buildTrack(side === 1, track);
            trackBuilder.appendRepeatMfmByte(0x4e, MfmGap1_4Es);
            for (let sector = 0; sector < AdfSectorsPerTrack; ++sector) {
                trackBuilder.appendMfmSector({
                    idMark: IbmDiscFormat.idMarkDataPattern,
                    dataMark: IbmDiscFormat.dataMarkDataPattern,
                    track,
                    head: 0,
                    sector,
                    lengthCode: SectorLengthCode,
                    data: offset < data.length ? data.subarray(offset, offset + AdfSectorSize) : blankSector,
                });
                offset += AdfSectorSize;

                // Sync pattern between sectors, aka GAP 3.
                trackBuilder.appendRepeatMfmByte(0x4e, MfmGap3_4Es);
            }
            trackBuilder.fillMfmByte(0x4e);
        }
    }

    // TODO(#822) writeback
    return disc;
}

/** Why a sector will not fit in an SSD or DSD image, or null if it will. */
function sectorShortfall(sector) {
    if (sector.hasDataCrcError || sector.hasHeaderCrcError) return "with a CRC error";
    // A header whose data mark never arrives leaves the sector with nothing to write.
    if (!sector.sectorData) return "with no data";
    if (sector.sectorNumber >= SsdSectorsPerTrack) return `numbered past the ${SsdSectorsPerTrack} a track holds`;
    if (sector.sectorData.length !== SsdSectorSize) return `not ${SsdSectorSize} bytes`;
    if (sector.trackNumber >= SsdTracksPerDisc) return `past track ${SsdTracksPerDisc}`;
    return null;
}

/**
 * Where a sector belongs in an SSD or DSD image, which is the track its own header claims rather
 * than the one it sits on.
 *
 * @param {Sector} sector
 * @param {boolean} isSideUpper
 * @param {Number} numSides
 */
function ssdOffsetOf(sector, isSideUpper, numSides) {
    const track = sector.trackNumber * numSides + (isSideUpper ? 1 : 0);
    return track * SsdTrackSize + sector.sectorNumber * SsdSectorSize;
}

/**
 * @param {Disc} disc
 * @returns {{sector: Sector, isSideUpper: boolean}[]} every sector on `disc`, track by track
 */
function sectorsOnSurface(disc) {
    const found = [];
    for (let trackNum = 0; trackNum < disc.tracksUsed; ++trackNum) {
        for (const isSideUpper of disc.isDoubleSided ? [false, true] : [false]) {
            for (const sector of disc.getTrack(isSideUpper, trackNum).findSectors())
                found.push({ sector, isSideUpper });
        }
    }
    return found;
}

/**
 * SSD and DSD images hold sector contents and nothing else, so anything a DFS sector could not
 * have held is lost. Copy protection usually shows up as one of these.
 *
 * @param {{sector: Sector}[]} sectors
 * @returns {string[]} what `sectors` hold that an SSD or DSD cannot, worst first
 */
function describeShortfalls(sectors) {
    const counts = new Map();
    for (const { sector } of sectors) {
        const shortfall = sectorShortfall(sector);
        if (shortfall) counts.set(shortfall, (counts.get(shortfall) ?? 0) + 1);
    }
    return [...counts]
        .sort(([, a], [, b]) => b - a)
        .map(([shortfall, count]) => `${count} sector${count === 1 ? "" : "s"} ${shortfall}`);
}

/**
 * @returns {Uint8Array}
 * @param {Disc} disc
 * @param {object} [options]
 * @param {boolean} [options.force] save what fits instead of refusing a disc that will not fit
 * @throws if the disc holds anything an SSD or DSD cannot, and `force` is not set
 */
export function toSsdOrDsd(disc, { force = false } = {}) {
    const sectors = sectorsOnSurface(disc);
    if (!force) {
        const shortfalls = describeShortfalls(sectors);
        if (shortfalls.length)
            throw new Error(
                `This disc cannot be saved as SSD or DSD: it has ${shortfalls.join(", ")}. ` +
                    `Save it as HFE to keep everything.`,
            );
    }
    const numSides = disc.isDoubleSided ? 2 : 1;
    const result = new Uint8Array(numSides * SsdTracksPerDisc * SsdTrackSize);
    let numTracks = 0;
    for (const { sector, isSideUpper } of sectors) {
        if (sectorShortfall(sector)) continue;
        result.set(sector.sectorData, ssdOffsetOf(sector, isSideUpper, numSides));
        numTracks = Math.max(numTracks, sector.trackNumber + 1);
    }
    return result.slice(0, numTracks * numSides * SsdTrackSize);
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
        // Whether the surface holds a 48 tpi layout, which a drive reads by double stepping.
        this.is40Track = false;
        /** @type {{text: string, isOdd: boolean}[]} what loading the image found out, for the media window */
        this.loadNotes = [];

        this._trackWriteListeners = new Set();
        this._savingListeners = new Set();
        this.isWriteable = isWriteable;

        // Track which tracks have been written since the last snapshot.
        // Keys are numeric: (track | (isSideUpper ? 0x100 : 0)).
        this._snapshotDirtyTracks = new Set();
        // Cumulative set of all tracks ever written since disc load (never cleared by snapshots).
        // Same key encoding as _snapshotDirtyTracks.
        this._everDirtyTracks = new Set();
        // Cache of the previous snapshot's track data for structural sharing.
        // Keys are "side:trackNum" strings, values are {pulses2Us, length} objects.
        this._lastTrackSnapshots = Object.create(null);

        // Original disc image data, stored for embedding in save-to-file snapshots
        // and CRC32 verification on restore. _originalImageData is only set for
        // local-file discs (not URL-sourced ones). _originalImageCrc32 is the CRC
        // of the image bytes at load time — it is not updated if an onChange handler
        // mutates the backing store. This is fine because the CRC is compared against
        // the same source that would be reloaded (the original image or URL), not the
        // mutated copy. If a mutable source URL were added in future, CRC verification
        // should be skipped or the CRC updated accordingly.
        this._originalImageData = null;
        this._originalImageCrc32 = null;

        this.initSurface(0);
    }

    /**
     * @param {function(boolean, Number, Track): void} listener called once per flushed track
     * @param {boolean} [savesChanges] whether the listener puts the image somewhere it is read back from
     */
    addTrackWriteListener(listener, savesChanges = false) {
        this._trackWriteListeners.add(listener);
        if (savesChanges) this._savingListeners.add(listener);
    }

    get savesChanges() {
        return this._savingListeners.size > 0;
    }

    /** @param {function(boolean, Number, Track): void} listener */
    removeTrackWriteListener(listener) {
        this._trackWriteListeners.delete(listener);
        this._savingListeners.delete(listener);
    }

    /** @param {function(): void} listener called once, when a track is first written to this disc */
    notifyOnFirstTrackWrite(listener) {
        const onFirstWrite = () => {
            this.removeTrackWriteListener(onFirstWrite);
            listener();
        };
        this.addTrackWriteListener(onFirstWrite);
    }

    /**
     * Record the CRC32 of the original disc image for verification on restore.
     * Called by discFor() after loading. Does not retain the image bytes.
     * @param {Uint8Array} data - the raw disc image bytes (used only to compute CRC32)
     */
    setOriginalImageCrc32(data) {
        this._originalImageCrc32 = crc32(data);
    }

    /**
     * Store the original disc image bytes for embedding in snapshots.
     * Only call this for local-file discs — URL-sourced discs should use
     * setOriginalImageCrc32() instead to avoid retaining the full image.
     * Computes CRC32 only if not already set (e.g. by discFor).
     * @param {Uint8Array} data - the raw disc image bytes
     */
    setOriginalImage(data) {
        this._originalImageData = data;
        if (this._originalImageCrc32 == null) {
            this._originalImageCrc32 = crc32(data);
        }
    }

    /** @returns {Uint8Array|null} the original disc image bytes, or null if not set */
    get originalImageData() {
        return this._originalImageData;
    }

    /** @returns {number|null} CRC32 of the original disc image, or null if not set */
    get originalImageCrc32() {
        return this._originalImageCrc32;
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
            throw new Error(
                `Attempt to write off end of track ${track}: position ${position} >= length ${trackObj.length}`,
            );
        if (this.isDirty) {
            if (isSideUpper !== this.dirtySide || track !== this.dirtyTrack)
                throw new Error("Switched dirty track or side");
        }
        this.isDirty = true;
        this.dirtySide = isSideUpper;
        this.dirtyTrack = track;
        // Numeric key avoids string allocation on every pulse write.
        // Upper bit encodes side, lower 8 bits encode track number.
        const dirtyKey = track | (isSideUpper ? 0x100 : 0);
        this._snapshotDirtyTracks.add(dirtyKey);
        this._everDirtyTracks.add(dirtyKey);
        trackObj.pulses2Us[position] = pulses;
    }

    /** @returns {?{isSideUpper: boolean, trackNum: Number}} the track written, if there was one */
    flushWrites() {
        if (!this.isDirty) {
            if (this.dirtySide !== -1 || this.dirtyTrack !== -1) throw new Error("Bad state in disc dirty tracking");
            return null;
        }

        const dirtySide = this.dirtySide;
        const dirtyTrack = this.dirtyTrack;
        this.isDirty = false;
        this.dirtySide = -1;
        this.dirtyTrack = -1;
        const trackObj = this.getTrack(dirtySide, dirtyTrack);
        this.setTrackUsed(dirtySide, dirtyTrack);
        for (const listener of this._trackWriteListeners) listener(dirtySide, dirtyTrack, trackObj);
        return { isSideUpper: dirtySide, trackNum: dirtyTrack };
    }

    /**
     * Leave a track with no flux on it at all, as an erase head does.
     *
     * @param {boolean} isSideUpper
     * @param {Number} trackNum
     */
    eraseTrack(isSideUpper, trackNum) {
        const trackObj = this.getTrack(isSideUpper, trackNum);
        trackObj.pulses2Us.fill(0);
        trackObj.length = IbmDiscFormat.bytesPerTrack;
        const dirtyKey = trackNum | (isSideUpper ? 0x100 : 0);
        this._snapshotDirtyTracks.add(dirtyKey);
        this._everDirtyTracks.add(dirtyKey);
        this.setTrackUsed(isSideUpper, trackNum);
        for (const listener of this._trackWriteListeners) listener(isSideUpper, trackNum, trackObj);
    }

    /**
     * Create a snapshot of all track data with structural sharing.
     * Clean tracks reuse references from the previous snapshot;
     * dirty tracks get fresh copies.
     */
    snapshotState() {
        const numSides = this.isDoubleSided ? 2 : 1;
        // Use a plain object for JSON serialization compatibility.
        // Keys are "side:trackNum" strings.
        const tracks = Object.create(null);
        for (let side = 0; side < numSides; ++side) {
            for (let trackNum = 0; trackNum < this.tracksUsed; ++trackNum) {
                const key = `${side === 1}:${trackNum}`;
                const dirtyKey = trackNum | (side === 1 ? 0x100 : 0);
                const trackObj = this.getTrack(side === 1, trackNum);
                if (this._snapshotDirtyTracks.has(dirtyKey) || !this._lastTrackSnapshots[key]) {
                    // Dirty or first snapshot: copy the track data
                    tracks[key] = {
                        pulses2Us: trackObj.pulses2Us.slice(),
                        length: trackObj.length,
                    };
                } else {
                    // Clean: reuse the previous snapshot's reference
                    tracks[key] = this._lastTrackSnapshots[key];
                }
            }
        }

        this._snapshotDirtyTracks.clear();
        this._lastTrackSnapshots = tracks;

        return {
            tracksUsed: this.tracksUsed,
            isDoubleSided: this.isDoubleSided,
            isWriteable: this.isWriteable,
            name: this.name,
            tracks,
            // Expose for save-to-file snapshots to identify dirty tracks.
            // This is a Set and won't survive JSON serialization — it's only
            // used by createSnapshot() before the snapshot is serialized.
            _everDirtyTracks: new Set(this._everDirtyTracks),
            _originalImageData: this._originalImageData,
            _originalImageCrc32: this._originalImageCrc32,
        };
    }

    /**
     * Restore disc track data from a snapshot.
     * For save-to-file snapshots, `state.tracks` is empty and `state.dirtyTracks`
     * contains only the tracks modified since disc load. The base disc data must
     * already be loaded before calling this method.
     */
    restoreState(state) {
        this.tracksUsed = state.tracksUsed;
        this.isDoubleSided = state.isDoubleSided;
        this.isWriteable = state.isWriteable;
        this.name = state.name;

        // Reset write-in-progress state
        this.isDirty = false;
        this.dirtySide = -1;
        this.dirtyTrack = -1;
        this._snapshotDirtyTracks.clear();
        // Restore _everDirtyTracks from the snapshot if present (rewind path —
        // the Set is carried in-memory but won't survive JSON serialization).
        // For the save-to-file path, _everDirtyTracks is rebuilt from dirtyTracks below.
        if (state._everDirtyTracks instanceof Set) {
            this._everDirtyTracks = new Set(state._everDirtyTracks);
        } else {
            this._everDirtyTracks.clear();
        }

        // Restore full track data (rewind path — tracks contains all data)
        this._lastTrackSnapshots = state.tracks;
        for (const key of Object.keys(state.tracks)) {
            const trackData = state.tracks[key];
            const [sideStr, trackNumStr] = key.split(":");
            const isSideUpper = sideStr === "true";
            const trackNum = parseInt(trackNumStr, 10);
            const trackObj = this.getTrack(isSideUpper, trackNum);
            trackObj.pulses2Us.set(trackData.pulses2Us);
            trackObj.length = trackData.length;
        }

        // Apply dirty track overlays (save-to-file path — base disc already loaded,
        // overlay only the tracks that were written since disc load)
        if (state.dirtyTracks) {
            for (const key of Object.keys(state.dirtyTracks)) {
                const trackData = state.dirtyTracks[key];
                const [sideStr, trackNumStr] = key.split(":");
                const isSideUpper = sideStr === "true";
                const trackNum = parseInt(trackNumStr, 10);
                const trackObj = this.getTrack(isSideUpper, trackNum);
                trackObj.pulses2Us.set(trackData.pulses2Us);
                trackObj.length = trackData.length;
                this._everDirtyTracks.add(trackNum | (isSideUpper ? 0x100 : 0));
                // A disc that keeps its changes at its source takes the overlay there too.
                for (const listener of this._trackWriteListeners) listener(isSideUpper, trackNum, trackObj);
            }
        }
    }
}

/** @returns {string} the numbers in order, each once, with runs of consecutive ones folded, as "3-5, 9" */
export function numberRuns(numbers) {
    const runs = [];
    for (const number of new Set(numbers.toSorted((a, b) => a - b))) {
        const last = runs.at(-1);
        if (last && last.to === number - 1) last.to = number;
        else runs.push({ from: number, to: number });
    }
    return runs.map(({ from, to }) => (from === to ? `${from}` : `${from}-${to}`)).join(", ");
}

// A track within this of the standard length is not worth remarking on.
const TrackLengthTolerance = 0.015;
const StandardFmSectors = [10];
const StandardMfmSectors = [16, 18];

/**
 * What is odd about one side of a disc, track by track: long or short tracks, unusual sector
 * counts, CRC errors, sectors that claim another track, anything the decoder warns of, and runs of
 * tracks with no sectors. A double stepped side's tracks are numbered as its sectors number them.
 *
 * @param {Disc} disc
 * @param {boolean} isSideUpper
 * @returns {{trackNum: number, fraction: number, text: string}[]} each finding, with the physical
 *     track it is on and how far round that track
 */
export function discReport(disc, isSideUpper) {
    const findings = [];
    const step = sniffSurfaceLayout(disc, isSideUpper).is40Track ? 2 : 1;
    // Tracks with no sectors and nothing else to say come in runs, each told in one line.
    let run = null;
    const endRun = () => {
        if (!run) return;
        const { from, to, what } = run;
        const tracks = from === to ? `track ${from / step}` : `tracks ${from / step}-${to / step}`;
        findings.push({ trackNum: from, fraction: 0, text: `${tracks}: ${what}` });
        run = null;
    };
    for (let trackNum = 0; trackNum < disc.tracksUsed; trackNum += step) {
        const track = disc.getTrack(isSideUpper, trackNum);
        const claimed = trackNum / step;
        const pulsesRound = track.length * PulsesPerWord;
        const onTrack = [];
        const note = (text, pulse) =>
            onTrack.push({ trackNum, fraction: pulse / pulsesRound, text: `track ${claimed}: ${text}` });
        const sectors = track.findSectors(note);
        if (!sectors.length && !onTrack.length) {
            // Unformatted as the surface shows it: no flux at all.
            const isBlank = track.pulses2Us.subarray(0, track.length).every((pulses) => pulses === 0);
            const what = isBlank ? "unformatted" : "flux, but no sector IDs";
            if (run?.what !== what) endRun();
            run = { from: run?.from ?? trackNum, to: trackNum, what };
            continue;
        }
        endRun();
        if (!sectors.length) {
            note("flux, but no sector IDs", 0);
            findings.push(...onTrack);
            continue;
        }
        const lengthRatio = track.length / IbmDiscFormat.bytesPerTrack;
        if (Math.abs(lengthRatio - 1) >= TrackLengthTolerance)
            note(`${lengthRatio > 1 ? "long" : "short"}, ${Math.round(lengthRatio * 100)}% of the standard length`, 0);
        const isMfm = sectors[0].isMfm;
        if (!(isMfm ? StandardMfmSectors : StandardFmSectors).includes(sectors.length))
            note(`${sectors.length} ${isMfm ? "MFM" : "FM"} ${sectors.length === 1 ? "sector" : "sectors"}`, 0);
        // Sectors that share a fault are named together, at the first of them.
        const faults = new Map();
        const fault = (what, sector) => {
            const found = faults.get(what) ?? { at: sector.idPosBitOffset, sectorNums: [] };
            found.sectorNums.push(sector.sectorNumber);
            faults.set(what, found);
        };
        for (const sector of sectors) {
            if (sector.hasHeaderCrcError) fault("a bad header CRC", sector);
            if (sector.trackNumber !== claimed) fault(`a header claiming track ${sector.trackNumber}`, sector);
            if (sector.hasDataCrcError) fault("a bad data CRC", sector);
        }
        for (const [what, { at, sectorNums }] of faults)
            note(`${sectorNums.length === 1 ? "sector" : "sectors"} ${numberRuns(sectorNums)} with ${what}`, at);
        findings.push(...onTrack);
    }
    endRun();
    return findings;
}
