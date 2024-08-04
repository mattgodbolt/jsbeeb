import { describe, it } from "mocha";
import assert from "assert";

import { Disc, DiscConfig, IbmDiscFormat, loadHfe, loadSsd, loadAdf, toSsdOrDsd } from "../../disc.js";
import * as fs from "node:fs";

describe("IBM disc format tests", function () {
    it("calculates FM crcs", () => {
        let crc = IbmDiscFormat.crcInit(false);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        assert.equal(crc, 0xb1e4);
    });
    it("calculates MFM crcs", () => {
        let crc = IbmDiscFormat.crcInit(true);
        crc = IbmDiscFormat.crcAddByte(crc, 0x12);
        crc = IbmDiscFormat.crcAddByte(crc, 0x34);
        crc = IbmDiscFormat.crcAddByte(crc, 0x56);
        crc = IbmDiscFormat.crcAddByte(crc, 0x70);
        assert.equal(crc, 0x9d39);
    });
    it("converts to FM pulses", () => {
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xff, 0x00), 0x44444444);
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xff, 0xff), 0x55555555);
        assert.equal(IbmDiscFormat.fmTo2usPulses(0xc7, 0xfe), 0x55111554);
    });
    it("converts from FM pulses", () => {
        // TODO either fix these or understand why beebjit doesn't use same bit posn for bits.
        const deliberateFudge = 1;
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x44444444 << deliberateFudge), {
            clocks: 0xff,
            data: 0x00,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x55555555 << deliberateFudge), {
            clocks: 0xff,
            data: 0xff,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm(0x55111554 << deliberateFudge), {
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: false,
        });
        assert.deepEqual(IbmDiscFormat._2usPulsesToFm((0x55111554 << deliberateFudge) | 0x05), {
            clocks: 0xc7,
            data: 0xfe,
            iffyPulses: true,
        });
    });
    it("converts to MFM pulses", () => {
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0x00), { lastBit: false, pulses: 0xaaaa });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0x00), { lastBit: false, pulses: 0x2aaa });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0xff), { lastBit: true, pulses: 0x5555 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0xff), { lastBit: true, pulses: 0x5555 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(false, 0x37), { lastBit: true, pulses: 0xa515 });
        assert.deepEqual(IbmDiscFormat.mfmTo2usPulses(true, 0x37), { lastBit: true, pulses: 0x2515 });
    });
    it("Converts from MFM pulses", () => {
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0xaaaa), 0);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x2aaa), 0);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x5555), 0xff);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0xa515), 0x37);
        assert.equal(IbmDiscFormat._2usPulsesToMfm(0x2515), 0x37);
    });
    it("checks gaps between MFM pulses", () => {
        assert(!IbmDiscFormat.checkPulse(0.0, true));
        assert(!IbmDiscFormat.checkPulse(3.49, true));
        assert(!IbmDiscFormat.checkPulse(4.51, true));
        assert(!IbmDiscFormat.checkPulse(7.49, true));
        assert(!IbmDiscFormat.checkPulse(8.51, true));

        assert(IbmDiscFormat.checkPulse(4.0, true));
        assert(IbmDiscFormat.checkPulse(5.51, true));
        assert(IbmDiscFormat.checkPulse(6.0, true));
        assert(IbmDiscFormat.checkPulse(6.49, true));
        assert(IbmDiscFormat.checkPulse(8.0, true));
    });
    it("checks gaps between FM pulses", () => {
        assert(!IbmDiscFormat.checkPulse(0.0, false));
        assert(!IbmDiscFormat.checkPulse(3.49, false));
        assert(!IbmDiscFormat.checkPulse(4.51, false));
        assert(!IbmDiscFormat.checkPulse(5.51, false));
        assert(!IbmDiscFormat.checkPulse(6.0, false));
        assert(!IbmDiscFormat.checkPulse(6.49, false));
        assert(!IbmDiscFormat.checkPulse(7.49, false));
        assert(!IbmDiscFormat.checkPulse(8.51, false));

        assert(IbmDiscFormat.checkPulse(4.0, false));
        assert(IbmDiscFormat.checkPulse(8.0, false));
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
        assert.equal(disc.tracksUsed, 0);
        assert(!disc.isDoubleSided);
        disc.buildTrack(false, 0);
        assert.equal(disc.tracksUsed, 1);
        assert(!disc.isDoubleSided);
        disc.buildTrack(false, 3);
        assert.equal(disc.tracksUsed, 4);
        assert(!disc.isDoubleSided);
        disc.buildTrack(true, 1);
        assert.equal(disc.tracksUsed, 4);
        assert(disc.isDoubleSided);
    });

    it("should build from FM pulses", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        const builder = disc.buildTrack(false, 0);
        const pulses = [4, 4, 8, 8, 4, 8, 8, 8, 8, 8, 8, 8, 8];
        builder.buildFromPulses(pulses, false);
        assert.equal(builder.track.length, 1);
    });

    it("should build from MFM pulses", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        const builder = disc.buildTrack(false, 0);
        const pulses = [4, 4, 6, 6, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6];
        builder.buildFromPulses(pulses, true);
        assert.equal(builder.track.length, 1);
    });
});

describe("SSD loader tests", function () {
    const data = fs.readFileSync("discs/elite.ssd");
    this.timeout(5000); // roundtripping elite can be slow
    it("should load Elite", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, data, false);
        assert.equal(disc.tracksUsed, 46);
    });
    it("should roundtrip Elite", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, data, false);
        const ssdSaved = toSsdOrDsd(disc);
        // // Check the first few bytes, else a diff blows things up
        const maxDiff = 50;
        assert.deepEqual(ssdSaved.slice(0, maxDiff), Uint8Array.prototype.slice.call(data, 0, maxDiff));

        // But also check everything else; and the padding should be all zeros.
        assert(ssdSaved.length >= data.length);
        for (let i = 0; i < data.length; ++i) {
            assert.equal(ssdSaved[i], data[i]);
        }
        for (let i = data.length; i < ssdSaved.length; ++i) {
            assert.equal(ssdSaved[i], 0);
        }
    });
    it("should have sane tracks", () => {
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, data, false);
        const sectors = disc.getTrack(false, 0).findSectors();
        assert.equal(sectors.length, 10);
        for (const sector of sectors) {
            assert(!sector.hasHeaderCrcError);
            assert(!sector.hasDataCrcError);
        }
    });
});

describe("HFE loader tests", function () {
    const data = fs.readFileSync("discs/elite.hfe");
    it("should load Elite", () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        loadHfe(disc, data);
        assert.equal(disc.tracksUsed, 81);
        const sectors = disc.getTrack(false, 0).findSectors();
        assert.equal(sectors.length, 10);
        for (const sector of sectors) {
            assert(!sector.hasHeaderCrcError);
            assert(!sector.hasDataCrcError);
        }
    });
});

describe("ADF loader tests", function () {
    it("should load a somewhat blank ADFS disc", () => {
        const data = new Uint8Array(327680);
        const disc = new Disc(true, new DiscConfig(), "test.adf");
        loadAdf(disc, data, true);
        assert.equal(disc.tracksUsed, 40);
        const sectors = disc.getTrack(false, 0).findSectors();
        assert.equal(sectors.length, 16);
        for (const sector of sectors) {
            assert(!sector.hasHeaderCrcError);
            assert(!sector.hasDataCrcError);
        }
    });
});
