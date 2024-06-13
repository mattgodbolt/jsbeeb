// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit

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

class Track {
    constructor(upper, trackNum, initialByte) {
        this.length = IbmDiscFormat.bytesPerTrack;
        this.upper = upper;
        this.trackNum = trackNum;
        this.pulses2Us = new Uint32Array(256 * 13);
        this.pulses2Us.fill(initialByte | (initialByte << 8) | (initialByte << 16) | (initialByte << 32));
    }

    get description() {
        return `Track ${this.trackNum} ${this.upper ? "upper" : "lower"}`;
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
                    .appendFmChunk(data.subarray(offset, SsdFormat.sectorSize))
                    .appendCrc(false);

                offset += SsdFormat.sectorSize;

                if (sector !== SsdFormat.sectorsPerTrack - 1) {
                    // Sync pattern between sectors, aka GAP 3.
                    trackBuilder
                        .appendRepeatFmByte(0xff, IbmDiscFormat.std10SectorGap3FFs)
                        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s);
                }
            }
            trackBuilder.setTrackLength();
        }
    }
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

        if (isMutable && !this.writeTrackCallback) {
            console.log("Cannot writeback to file type, making read only");
            isMutable = isWriteable = false; // TODO reconsider
        }

        this.isWriteable = isWriteable;
        this.isMutableRequested = isMutable;
        this.isMutable = false; // set by load

        // TODO disc surface builders for
        this.load();
    }

    /// @returns {Track}
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
