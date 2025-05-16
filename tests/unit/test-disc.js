import { describe, it } from "vitest";
import assert from "assert";

import { Disc, DiscConfig, IbmDiscFormat, loadHfe, loadSsd, loadAdf, toSsdOrDsd, toHfe } from "../../src/disc.js";
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
            assert.equal(disc.tracksUsed, 80);
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
    },
);

describe("HFE loader tests", function () {
    const data = fs.readFileSync("public/discs/elite.hfe");
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

    it("should reject invalid HFE files", () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");

        // Test missing header
        assert.throws(() => {
            loadHfe(disc, new Uint8Array(10));
        }, /HFE file missing header/);

        // Test invalid header
        const invalidHeader = new Uint8Array(512);
        invalidHeader.set(new TextEncoder().encode("INVALID!"), 0);
        assert.throws(() => {
            loadHfe(disc, invalidHeader);
        }, /HFE file bad header/);

        // Test non-zero revision
        const nonZeroRevision = new Uint8Array(512);
        nonZeroRevision.set(new TextEncoder().encode("HXCHFEV3"), 0);
        nonZeroRevision[8] = 1; // Set revision to 1 (should be 0)
        assert.throws(() => {
            loadHfe(disc, nonZeroRevision);
        }, /HFE file revision not 0/);

        // Test unsupported encoding
        const unsupportedEncoding = new Uint8Array(512);
        unsupportedEncoding.set(new TextEncoder().encode("HXCHFEV3"), 0);
        unsupportedEncoding[8] = 0; // Revision 0
        unsupportedEncoding[11] = 1; // Encoding 1 (not 0 or 2)
        assert.throws(() => {
            loadHfe(disc, unsupportedEncoding);
        }, /HFE encoding not ISOIBM/);
    });
});

describe(
    "HFE round-trip tests",
    {
        timeout: 120000, // HFE processing can be slow
    },
    function () {
        const data = fs.readFileSync("public/discs/elite.hfe");
        it("should round-trip elite.hfe", () => {
            // We already imported toHfe at the top of the file

            // Load the original HFE file
            const disc = new Disc(true, new DiscConfig(), "test.hfe");
            loadHfe(disc, data);

            // Export it back to HFE
            const hfeSaved = toHfe(disc);

            // Load the saved HFE into a new disc
            const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
            loadHfe(disc2, hfeSaved);

            // Verify that both discs have the same properties
            assert.equal(disc.tracksUsed, disc2.tracksUsed);
            assert.equal(disc.isDoubleSided, disc2.isDoubleSided);

            // Compare sectors in a few sample tracks
            const trackSamples = [0, 10, 20, 40]; // Sample a few tracks
            for (const trackNum of trackSamples) {
                if (trackNum >= disc.tracksUsed) continue;

                const track1 = disc.getTrack(false, trackNum);
                const track2 = disc2.getTrack(false, trackNum);

                // With our variable track length HFE implementation,
                // track lengths should be identical after roundtripping

                // Track lengths should be identical when roundtripping with the variable track length HFE implementation
                assert.equal(
                    track1.length,
                    track2.length,
                    `Track ${trackNum} length mismatch: original ${track1.length}, round-tripped ${track2.length}`,
                );

                // Compare sectors - this is the most important test
                // All sectors must be readable and contain the correct data
                const sectors1 = track1.findSectors();
                const sectors2 = track2.findSectors();

                // All sectors must be found
                assert.equal(
                    sectors1.length,
                    sectors2.length,
                    `Track ${trackNum} sector count mismatch: ${sectors1.length} vs ${sectors2.length}`,
                );

                // Compare sector data for first sector as a sample
                if (sectors1.length > 0 && sectors2.length > 0) {
                    assert.equal(sectors1[0].sectorNumber, sectors2[0].sectorNumber);
                    assert.equal(sectors1[0].trackNumber, sectors2[0].trackNumber);

                    // Compare actual sector data if available
                    if (sectors1[0].sectorData && sectors2[0].sectorData) {
                        assert.equal(
                            sectors1[0].sectorData.length,
                            sectors2[0].sectorData.length,
                            `Track ${trackNum} sector data length mismatch`,
                        );

                        // Sample a few bytes from the sector
                        if (sectors1[0].sectorData.length > 0) {
                            assert.equal(
                                sectors1[0].sectorData[0],
                                sectors2[0].sectorData[0],
                                `Track ${trackNum} first byte mismatch`,
                            );

                            const midPoint = Math.floor(sectors1[0].sectorData.length / 2);
                            assert.equal(
                                sectors1[0].sectorData[midPoint],
                                sectors2[0].sectorData[midPoint],
                                `Track ${trackNum} middle byte mismatch`,
                            );

                            assert.equal(
                                sectors1[0].sectorData[sectors1[0].sectorData.length - 1],
                                sectors2[0].sectorData[sectors2[0].sectorData.length - 1],
                                `Track ${trackNum} last byte mismatch`,
                            );
                        }
                    }
                }
            }
        });
    },
);

describe("HFE export tests", function () {
    it("should export a simple single-sided disc", { timeout: 10000 }, () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        const sectorData = new Uint8Array(256);
        sectorData.fill(0xa5);

        // Create a simple FM track
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
            .appendFmChunk(sectorData)
            .appendCrc(false)
            .fillFmByte(0xff);

        const hfeData = toHfe(disc);

        // Verify HFE header
        const header = new TextDecoder("ascii").decode(hfeData.slice(0, 8));
        assert.equal(header, "HXCHFEV3");
        assert.equal(hfeData[8], 0); // Revision
        assert.equal(hfeData[9], 1); // Number of tracks
        assert.equal(hfeData[10], 1); // Number of sides
        assert.equal(hfeData[11], 2); // ISOIBM_FM_MFM_ENCODING
    });

    it("should export and reload the same disc", { timeout: 30000 }, () => {
        // Create a disc with FM data
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        const data = new Uint8Array(10240); // 10 sectors worth
        for (let i = 0; i < data.length; i++) {
            data[i] = i & 0xff;
        }
        loadSsd(disc, data, false);

        // Export to HFE
        const hfeData = toHfe(disc);

        // Access the data structure to verify tracks

        // Reload from HFE
        const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
        loadHfe(disc2, hfeData);

        // Compare track data
        assert.equal(disc.tracksUsed, disc2.tracksUsed);
        for (let trackNum = 0; trackNum < disc.tracksUsed; trackNum++) {
            const track1 = disc.getTrack(false, trackNum);
            const track2 = disc2.getTrack(false, trackNum);

            // With our improved implementation, track lengths should be exactly the same
            // when round-tripping through the HFE format
            assert.equal(
                track1.length,
                track2.length,
                `Track ${trackNum} length mismatch: original ${track1.length}, round-tripped ${track2.length}`,
            );

            // Find sectors and compare
            const sectors1 = track1.findSectors();
            const sectors2 = track2.findSectors();

            // All sectors must be found - this is the critical test
            assert.equal(
                sectors1.length,
                sectors2.length,
                `Track ${trackNum} has ${sectors1.length} original sectors but ${sectors2.length} after round-trip`,
            );

            assert.equal(sectors1.length, sectors2.length);

            for (let i = 0; i < sectors1.length; i++) {
                assert.equal(sectors1[i].sectorNumber, sectors2[i].sectorNumber);
                assert.equal(sectors1[i].trackNumber, sectors2[i].trackNumber);
                // Compare sector data if available
                if (sectors1[i].sectorData && sectors2[i].sectorData) {
                    assert.deepEqual(sectors1[i].sectorData, sectors2[i].sectorData);
                }
            }
        }
    });

    it("should export a double-sided disc", { timeout: 10000 }, () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        const data = new Uint8Array(10240); // 10 sectors worth
        data.fill(0xbb);
        loadSsd(disc, data, true); // Load as DSD (double-sided)

        const hfeData = toHfe(disc);

        // Verify HFE header
        const header = new TextDecoder("ascii").decode(hfeData.slice(0, 8));
        assert.equal(header, "HXCHFEV3");
        assert.equal(hfeData[10], 2); // Number of sides

        // Reload and verify
        const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
        loadHfe(disc2, hfeData);

        assert(disc2.isDoubleSided);
        assert.equal(disc.tracksUsed, disc2.tracksUsed);
    });

    it("should properly handle MFM data", { timeout: 10000 }, () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        const sectorData = new Uint8Array(256);
        for (let i = 0; i < sectorData.length; i++) {
            sectorData[i] = (i * 0x11) & 0xff;
        }

        // Create an MFM track
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
            .appendMfmChunk(sectorData)
            .appendCrc(true)
            .appendRepeatMfmByte(0x4e, 24)
            .fillMfmByte(0x4e);

        const hfeData = toHfe(disc);

        // Reload and verify
        const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
        loadHfe(disc2, hfeData);

        const sectors = disc2.getTrack(false, 0).findSectors();
        assert.equal(sectors.length, 1);
        assert(sectors[0].isMfm);
        assert.deepEqual(sectors[0].sectorData, sectorData);
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
