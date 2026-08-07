import { describe, it, expect } from "vitest";

import { BitWindow64, Disc, DiscConfig, IbmDiscFormat, loadSsd, loadAdf, toSsdOrDsd } from "../../src/disc.js";
import * as fs from "node:fs";

describe("BitWindow64", function () {
    /** Shift the low `count` bits of a BigInt in, most significant first. */
    function shiftIn(window, value, count = 64) {
        for (let bit = count - 1; bit >= 0; --bit) window.shiftIn(Number((value >> BigInt(bit)) & 1n));
        return window;
    }

    it("holds the last 64 bits shifted in", () => {
        const window = shiftIn(new BitWindow64(), 0xaaaa448944894489n);
        expect(window.hi).toBe(0xaaaa4489);
        expect(window.lo).toBe(0x44894489);
    });

    it("keeps both halves unsigned as bits cross bit 31 and bit 63", () => {
        const window = shiftIn(new BitWindow64(), 0xffffffffffffffffn);
        expect(window.hi).toBe(0xffffffff);
        expect(window.lo).toBe(0xffffffff);
    });

    it("returns the bit leaving bit 63", () => {
        const window = shiftIn(new BitWindow64(), 0x8000000000000000n);
        expect(window.shiftIn(0)).toBe(1);
        expect(window.shiftIn(0)).toBe(0);
    });

    it("matches a 64 bit value only in full", () => {
        const window = shiftIn(new BitWindow64(), 0xaaaa448944894489n);
        expect(window.equals(0xaaaa4489, 0x44894489)).toBe(true);
        expect(window.equals(0xaaaa4489, 0x44894488)).toBe(false);
        expect(window.equals(0xaaaa4488, 0x44894489)).toBe(false);
    });

    it("counts a run of nibbles ending at bit 0", () => {
        expect(shiftIn(new BitWindow64(), 0x1234567988888888n).countTrailingNibbles(0x8)).toBe(8);
    });

    it("counts a run continuing into the high half", () => {
        expect(shiftIn(new BitWindow64(), 0x1234567888888888n).countTrailingNibbles(0x8)).toBe(9);
        expect(shiftIn(new BitWindow64(), 0x1238888888888888n).countTrailingNibbles(0x8)).toBe(13);
        expect(shiftIn(new BitWindow64(), 0x8888888888888888n).countTrailingNibbles(0x8)).toBe(16);
    });

    it("counts nothing when the lowest nibble differs", () => {
        expect(shiftIn(new BitWindow64(), 0x8888888888888880n).countTrailingNibbles(0x8)).toBe(0);
    });
});

describe("IBM disc format tests", function () {
    it("calculates FM crcs", () => {
        let crc = IbmDiscFormat.crcInit(false);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        expect(crc).toBe(0xb1e4);
    });
    it("calculates MFM crcs", () => {
        let crc = IbmDiscFormat.crcInit(true);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        expect(crc).toBe(0x9d39);
    });
    it("converts to FM pulses", () => {
        expect(IbmDiscFormat.fmTo2usPulses(0xff, 0x00)).toBe(0x44444444);
        expect(IbmDiscFormat.fmTo2usPulses(0xff, 0xff)).toBe(0x55555555);
        expect(IbmDiscFormat.fmTo2usPulses(0xc7, 0xfe)).toBe(0x55111554);
    });
    it("converts from FM pulses", () => {
        // TODO either fix these or understand why beebjit doesn't use same bit posn for bits.
        const deliberateFudge = 1;
        expect(IbmDiscFormat._2usPulsesToFm(0x44444444 << deliberateFudge)).toEqual({
            clocks: 0xff,
            data: 0x00,
            iffyPulses: false,
        });
        expect(IbmDiscFormat._2usPulsesToFm(0x55555555 << deliberateFudge)).toEqual({
            clocks: 0xff,
            data: 0xff,
            iffyPulses: false,
        });
        expect(IbmDiscFormat._2usPulsesToFm(0x55111554 << deliberateFudge)).toEqual({
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: false,
        });
        expect(IbmDiscFormat._2usPulsesToFm((0x55111554 << deliberateFudge) | 0x05)).toEqual({
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: true,
        });
    });
    it("converts to MFM pulses", () => {
        expect(IbmDiscFormat.mfmTo2usPulses(false, 0x00)).toEqual({ lastBit: false, pulses: 0xaaaa });
        expect(IbmDiscFormat.mfmTo2usPulses(true, 0x00)).toEqual({ lastBit: false, pulses: 0x2aaa });
        expect(IbmDiscFormat.mfmTo2usPulses(false, 0xff)).toEqual({ lastBit: true, pulses: 0x5555 });
        expect(IbmDiscFormat.mfmTo2usPulses(true, 0xff)).toEqual({ lastBit: true, pulses: 0x5555 });
        expect(IbmDiscFormat.mfmTo2usPulses(false, 0x37)).toEqual({ lastBit: true, pulses: 0xa515 });
        expect(IbmDiscFormat.mfmTo2usPulses(true, 0x37)).toEqual({ lastBit: true, pulses: 0x2515 });
    });
    it("Converts from MFM pulses", () => {
        expect(IbmDiscFormat._2usPulsesToMfm(0xaaaa)).toBe(0);
        expect(IbmDiscFormat._2usPulsesToMfm(0x2aaa)).toBe(0);
        expect(IbmDiscFormat._2usPulsesToMfm(0x5555)).toBe(0xff);
        expect(IbmDiscFormat._2usPulsesToMfm(0xa515)).toBe(0x37);
        expect(IbmDiscFormat._2usPulsesToMfm(0x2515)).toBe(0x37);
    });
    it("checks gaps between MFM pulses", () => {
        expect(IbmDiscFormat.checkPulse(0.0, true)).toBe(false);
        expect(IbmDiscFormat.checkPulse(3.49, true)).toBe(false);
        expect(IbmDiscFormat.checkPulse(4.51, true)).toBe(false);
        expect(IbmDiscFormat.checkPulse(7.49, true)).toBe(false);
        expect(IbmDiscFormat.checkPulse(8.51, true)).toBe(false);

        expect(IbmDiscFormat.checkPulse(4.0, true)).toBe(true);
        expect(IbmDiscFormat.checkPulse(5.51, true)).toBe(true);
        expect(IbmDiscFormat.checkPulse(6.0, true)).toBe(true);
        expect(IbmDiscFormat.checkPulse(6.49, true)).toBe(true);
        expect(IbmDiscFormat.checkPulse(8.0, true)).toBe(true);
    });
    it("checks gaps between FM pulses", () => {
        expect(IbmDiscFormat.checkPulse(0.0, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(3.49, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(4.51, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(5.51, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(6.0, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(6.49, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(7.49, false)).toBe(false);
        expect(IbmDiscFormat.checkPulse(8.51, false)).toBe(false);

        expect(IbmDiscFormat.checkPulse(4.0, false)).toBe(true);
        expect(IbmDiscFormat.checkPulse(8.0, false)).toBe(true);
    });
});

describe("Disc builder tests", () => {
    const someData = new Uint8Array(256);
    someData.fill(0x33);
    it("should write a simple FM track without blowing up", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        const builder = disc.buildTrack(false, 0);
        builder
            .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
            .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
            .resetCrc()
            .appendFmDataAndClocks(IbmDiscFormat.idMarkDataPattern, IbmDiscFormat.markClockPattern)
            .appendFmByte(0) // track
            .appendFmByte(0)
            .appendFmByte(0) // sector
            .appendFmByte(1)
            .appendCrc(false)
            .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
            .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
            .resetCrc()
            .appendFmDataAndClocks(IbmDiscFormat.dataMarkDataPattern, IbmDiscFormat.markClockPattern)
            .appendFmChunk(someData)
            .appendCrc(false)
            .fillFmByte(0xff);
    });

    it("should write a simple MFM track without blowing up", () => {
        const disc = new Disc(true, new DiscConfig());
        const builder = disc.buildTrack(false, 0);
        builder
            .appendRepeatMfmByte(0x4e, 60)
            .appendRepeatMfmByte(0x00, 12)
            .resetCrc()
            .appendMfm3xA1Sync()
            .appendMfmByte(IbmDiscFormat.idMarkDataPattern)
            .appendMfmByte(0) // track
            .appendMfmByte(0)
            .appendMfmByte(0) // sector
            .appendMfmByte(1)
            .appendCrc(true)
            .appendRepeatMfmByte(0x4e, 22)
            .appendRepeatMfmByte(0x00, 12)
            .resetCrc()
            .appendMfm3xA1Sync()
            .appendMfmByte(IbmDiscFormat.dataMarkDataPattern)
            .appendMfmChunk(someData)
            .appendCrc(true)
            .appendRepeatMfmByte(0x4e, 24)
            .fillMfmByte(0x4e);
    });

    it("should note how much disc is being used", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        expect(disc.tracksUsed).toBe(0);
        expect(disc.isDoubleSided).toBe(false);
        disc.buildTrack(false, 0);
        expect(disc.tracksUsed).toBe(1);
        expect(disc.isDoubleSided).toBe(false);
        disc.buildTrack(false, 3);
        expect(disc.tracksUsed).toBe(4);
        expect(disc.isDoubleSided).toBe(false);
        disc.buildTrack(true, 1);
        expect(disc.tracksUsed).toBe(4);
        expect(disc.isDoubleSided).toBe(true);
    });

    it("should build from FM pulses", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        const builder = disc.buildTrack(false, 0);
        const pulses = [4, 4, 8, 8, 4, 8, 8, 8, 8, 8, 8, 8, 8];
        builder.buildFromPulses(pulses, false);
        expect(builder.track.length).toBe(1);
    });

    it("should build from MFM pulses", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        const builder = disc.buildTrack(false, 0);
        const pulses = [4, 4, 6, 6, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6];
        builder.buildFromPulses(pulses, true);
        expect(builder.track.length).toBe(1);
    });
});

describe(
    "SSD loader tests",
    {
        timeout: 60000, // roundtripping elite can be slow
    },
    function () {
        const data = fs.readFileSync("public/discs/elite.ssd");
        it("should load Elite", () => {
            const disc = new Disc(true, new DiscConfig(), "test.ssd");
            loadSsd(disc, data, false);
            expect(disc.tracksUsed).toBe(80);
        });
        it("should roundtrip Elite", () => {
            const disc = new Disc(true, new DiscConfig(), "test.ssd");
            loadSsd(disc, data, false);
            const ssdSaved = toSsdOrDsd(disc);
            // // Check the first few bytes, else a diff blows things up
            const maxDiff = 50;
            expect(ssdSaved.slice(0, maxDiff)).toEqual(new Uint8Array(data.slice(0, maxDiff)));

            // But also check everything else; and the padding should be all zeros.
            expect(ssdSaved.length >= data.length).toBe(true);
            for (let i = 0; i < data.length; ++i) {
                expect(ssdSaved[i]).toBe(data[i]);
            }
            for (let i = data.length; i < ssdSaved.length; ++i) {
                expect(ssdSaved[i]).toBe(0);
            }
        });
        it("should load an SSD whose size is not a multiple of sector size", () => {
            // Create data that's not a multiple of 256 bytes (e.g., 2.5 sectors worth)
            const sectorSize = 256;
            const oddSize = sectorSize * 2 + 100;
            const oddData = new Uint8Array(oddSize);
            for (let i = 0; i < oddSize; i++) oddData[i] = i & 0xff;

            const disc = new Disc(true, new DiscConfig(), "test.ssd");
            loadSsd(disc, oddData, false);

            const sectors = disc.getTrack(false, 0).findSectors();
            expect(sectors.length).toBe(10);
            for (const sector of sectors) {
                expect(sector.hasHeaderCrcError).toBe(false);
                expect(sector.hasDataCrcError).toBe(false);
            }
        });
        it("should have sane tracks", () => {
            const disc = new Disc(true, new DiscConfig(), "test.ssd");
            loadSsd(disc, data, false);
            const sectors = disc.getTrack(false, 0).findSectors();
            expect(sectors.length).toBe(10);
            for (const sector of sectors) {
                expect(sector.hasHeaderCrcError).toBe(false);
                expect(sector.hasDataCrcError).toBe(false);
            }
        });
    },
);

describe("ADF loader tests", function () {
    it("should load a somewhat blank ADFS disc", () => {
        const data = new Uint8Array(327680);
        const disc = new Disc(true, new DiscConfig(), "test.adf");
        loadAdf(disc, data, true);
        expect(disc.tracksUsed).toBe(40);
        const sectors = disc.getTrack(false, 0).findSectors();
        expect(sectors.length).toBe(16);
        for (const sector of sectors) {
            expect(sector.hasHeaderCrcError).toBe(false);
            expect(sector.hasDataCrcError).toBe(false);
        }
    });
});

describe("track write listeners", () => {
    /** @returns {Disc} a disc with one formatted track, ready to be written to */
    function writeableDisc() {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, null);
        return disc;
    }

    it("reports each flushed track to every listener", () => {
        const disc = writeableDisc();
        const seen = [];
        disc.addTrackWriteListener((isSideUpper, trackNum, track) => seen.push([isSideUpper, trackNum, track.length]));
        disc.writePulses(false, 3, 0, 0);
        disc.flushWrites();

        expect(seen).toEqual([[false, 3, disc.getTrack(false, 3).length]]);
    });

    it("reports writes even with no write-track callback set", () => {
        // The callback belongs to whichever loader owns writing the image back out, and a disc
        // loaded from a URL has none; observers still need telling.
        const disc = new Disc(true, new DiscConfig(), "blank");
        loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, null);
        expect(disc.writeTrackCallback).toBeUndefined();

        let calls = 0;
        disc.addTrackWriteListener(() => calls++);
        disc.writePulses(false, 0, 0, 0);
        disc.flushWrites();

        expect(calls).toBe(1);
    });

    it("says nothing when there was nothing to flush", () => {
        const disc = writeableDisc();
        let calls = 0;
        disc.addTrackWriteListener(() => calls++);
        disc.flushWrites();
        expect(calls).toBe(0);
    });

    it("stops reporting to a listener that has been removed", () => {
        const disc = writeableDisc();
        let calls = 0;
        const listener = () => calls++;
        disc.addTrackWriteListener(listener);
        disc.removeTrackWriteListener(listener);
        disc.writePulses(false, 1, 0, 0);
        disc.flushWrites();
        expect(calls).toBe(0);
    });

    it("leaves the loader's own write-track callback working alongside them", () => {
        let imageUpdates = 0;
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, () => imageUpdates++);
        let listenerCalls = 0;
        disc.addTrackWriteListener(() => listenerCalls++);

        disc.writePulses(false, 2, 0, 0);
        disc.flushWrites();

        expect(listenerCalls).toBe(1);
        expect(imageUpdates).toBe(1);
    });
});
