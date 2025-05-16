import { describe, it } from "vitest";
import assert from "assert";

import { Disc, DiscConfig, IbmDiscFormat, loadHfe, loadSsd, toHfe } from "../../src/disc.js";

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
