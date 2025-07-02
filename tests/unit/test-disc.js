import { describe, it, expect } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadSsd, loadAdf, toSsdOrDsd } from "../../src/disc.js";
import * as fs from "node:fs";

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
