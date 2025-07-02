import { describe, it, expect } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadSsd } from "../../src/disc.js";
import { loadHfe, toHfe, convertTrackToHfeV3 } from "../../src/disc-hfe.js";
import * as fs from "node:fs";

describe("HFE loader tests", function () {
    const data = fs.readFileSync("public/discs/elite.hfe");
    it("should load Elite", () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        loadHfe(disc, data);
        expect(disc.tracksUsed).toBe(81);
        const sectors = disc.getTrack(false, 0).findSectors();
        expect(sectors.length).toBe(10);
        for (const sector of sectors) {
            expect(sector.hasHeaderCrcError).toBe(false);
            expect(sector.hasDataCrcError).toBe(false);
        }
    });

    it("should reject invalid HFE files", () => {
        const disc = new Disc(true, new DiscConfig(), "test.hfe");

        // Test missing header
        expect(() => {
            loadHfe(disc, new Uint8Array(10));
        }).toThrow(/HFE file missing header/);

        // Test invalid header
        const invalidHeader = new Uint8Array(512);
        invalidHeader.set(new TextEncoder().encode("INVALID!"), 0);
        expect(() => {
            loadHfe(disc, invalidHeader);
        }).toThrow(/HFE file bad header/);

        // Test non-zero revision
        const nonZeroRevision = new Uint8Array(512);
        nonZeroRevision.set(new TextEncoder().encode("HXCHFEV3"), 0);
        nonZeroRevision[8] = 1; // Set revision to 1 (should be 0)
        expect(() => {
            loadHfe(disc, nonZeroRevision);
        }).toThrow(/HFE file revision not 0/);

        // Test unsupported encoding
        const unsupportedEncoding = new Uint8Array(512);
        unsupportedEncoding.set(new TextEncoder().encode("HXCHFEV3"), 0);
        unsupportedEncoding[8] = 0; // Revision 0
        unsupportedEncoding[11] = 1; // Encoding 1 (not 0 or 2)
        expect(() => {
            loadHfe(disc, unsupportedEncoding);
        }).toThrow(/HFE encoding not ISOIBM/);
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
            // Load the original HFE file
            const disc = new Disc(true, new DiscConfig(), "test.hfe");
            loadHfe(disc, data);

            // Export it back to HFE
            const hfeSaved = toHfe(disc);

            // Load the saved HFE into a new disc
            const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
            loadHfe(disc2, hfeSaved);

            // Verify that both discs have the same properties
            expect(disc.tracksUsed).toBe(disc2.tracksUsed);
            expect(disc.isDoubleSided).toBe(disc2.isDoubleSided);

            // Compare sectors in a few sample tracks
            const trackSamples = [0, 10, 20, 40]; // Sample a few tracks
            for (const trackNum of trackSamples) {
                if (trackNum >= disc.tracksUsed) continue;

                const track1 = disc.getTrack(false, trackNum);
                const track2 = disc2.getTrack(false, trackNum);

                // With our variable track length HFE implementation,
                // track lengths should be identical after roundtripping

                // Track lengths should be identical when roundtripping with the variable track length HFE implementation
                expect(track1.length).toBe(track2.length);

                // Compare sectors - this is the most important test
                // All sectors must be readable and contain the correct data
                const sectors1 = track1.findSectors();
                const sectors2 = track2.findSectors();

                // All sectors must be found
                expect(sectors1.length).toBe(sectors2.length);

                // Compare sector data for first sector as a sample
                if (sectors1.length > 0 && sectors2.length > 0) {
                    expect(sectors1[0].sectorNumber).toBe(sectors2[0].sectorNumber);
                    expect(sectors1[0].trackNumber).toBe(sectors2[0].trackNumber);

                    // Compare actual sector data if available
                    if (sectors1[0].sectorData && sectors2[0].sectorData) {
                        expect(sectors1[0].sectorData.length).toBe(sectors2[0].sectorData.length);

                        // Sample a few bytes from the sector
                        if (sectors1[0].sectorData.length > 0) {
                            expect(sectors1[0].sectorData[0]).toBe(sectors2[0].sectorData[0]);

                            const midPoint = Math.floor(sectors1[0].sectorData.length / 2);
                            expect(sectors1[0].sectorData[midPoint]).toBe(sectors2[0].sectorData[midPoint]);

                            expect(sectors1[0].sectorData[sectors1[0].sectorData.length - 1]).toBe(
                                sectors2[0].sectorData[sectors2[0].sectorData.length - 1],
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
        expect(header).toBe("HXCHFEV3");
        expect(hfeData[8]).toBe(0); // Revision
        expect(hfeData[9]).toBe(1); // Number of tracks
        expect(hfeData[10]).toBe(1); // Number of sides
        expect(hfeData[11]).toBe(2); // ISOIBM_FM_MFM_ENCODING
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

        // Reload from HFE
        const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
        loadHfe(disc2, hfeData);

        // Compare track data
        expect(disc.tracksUsed).toBe(disc2.tracksUsed);
        for (let trackNum = 0; trackNum < disc.tracksUsed; trackNum++) {
            const track1 = disc.getTrack(false, trackNum);
            const track2 = disc2.getTrack(false, trackNum);

            // With our improved implementation, track lengths should be exactly the same
            // when round-tripping through the HFE format
            expect(track1.length).toBe(track2.length);

            // Find sectors and compare
            const sectors1 = track1.findSectors();
            const sectors2 = track2.findSectors();

            // All sectors must be found - this is the critical test
            expect(sectors1.length).toBe(sectors2.length);

            expect(sectors1.length).toBe(sectors2.length);

            for (let i = 0; i < sectors1.length; i++) {
                expect(sectors1[i].sectorNumber).toBe(sectors2[i].sectorNumber);
                expect(sectors1[i].trackNumber).toBe(sectors2[i].trackNumber);
                // Compare sector data if available
                if (sectors1[i].sectorData && sectors2[i].sectorData) {
                    expect(sectors1[i].sectorData).toEqual(sectors2[i].sectorData);
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
        expect(header).toBe("HXCHFEV3");
        expect(hfeData[10]).toBe(2); // Number of sides

        // Reload and verify
        const disc2 = new Disc(true, new DiscConfig(), "test2.hfe");
        loadHfe(disc2, hfeData);

        expect(disc2.isDoubleSided).toBe(true);
        expect(disc.tracksUsed).toBe(disc2.tracksUsed);
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
        expect(sectors.length).toBe(1);
        expect(sectors[0].isMfm).toBe(true);
        expect(sectors[0].sectorData).toEqual(sectorData);
    });
});

describe("HFE track conversion tests", function () {
    it("should handle weak pulses correctly", () => {
        // Create an array with some normal pulses and some weak pulses (0)
        const pulses = [0xaabbccdd, 0, 0x11223344, 0x55667788, 0];

        // Convert to HFE v3 format
        const hfeData = convertTrackToHfeV3(pulses);

        // Check for the track header (SETINDEX, SETBITRATE, Bitrate250k)
        expect(hfeData.length).toBe(3 + pulses.length * 4);

        // Check that weak pulses (value 0) are handled specially
        // They should be encoded as the RAND opcode (0xF4) with bit flipping
        // The RAND opcode after bit flipping is 0x2F
        const randOpcodeFlipped = 0x2f;

        // Check the second pulse (index 1) which is a weak pulse
        expect(hfeData[3 + 4]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 5]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 6]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 7]).toBe(randOpcodeFlipped);

        // Also check the fifth pulse (index 4) which is also a weak pulse
        expect(hfeData[3 + 16]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 17]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 18]).toBe(randOpcodeFlipped);
        expect(hfeData[3 + 19]).toBe(randOpcodeFlipped);
    });

    it("should replace pulses with first byte 0xf0 to avoid collision", () => {
        // When bit-flipped, 0xf0 becomes 0x0f, which triggers opcode collision
        // The RAND opcode (0xf4) bit-flipped is 0x2f (47 decimal)
        const randOpcodeFlipped = 0x2f;

        // Create a pulse with 0xf0 as the first byte
        const pulseWithF0 = 0xf0aabbcc;

        // Convert to HFE v3 format
        const hfeData = convertTrackToHfeV3([pulseWithF0]);

        // When we detect this kind of collision, we replace with the bit-flipped RAND opcode
        expect(hfeData[3]).toBe(randOpcodeFlipped);
    });

    it("should handle bit flipping for pulses starting with 0x0f", () => {
        // Create a pulse with 0x0f as most significant byte
        const pulseWithF = 0x0f000000;

        // Convert to HFE v3 format
        const hfeData = convertTrackToHfeV3([pulseWithF]);

        // The flipped value (0xf0) is returned directly (no opcode collision detected)
        // because 0xf0 doesn't match the collision detection pattern
        expect(hfeData[3]).toBe(0xf0);
    });

    it("should preserve normal pulses correctly", () => {
        // Create a normal pulse that doesn't have opcode collisions
        const normalPulse = 0x12345678;

        // Convert to HFE v3 format
        const hfeData = convertTrackToHfeV3([normalPulse]);

        // Check the bytes match what we expect after bit flipping
        // 0x12 after bit flipping becomes 0x48
        // 0x34 after bit flipping becomes 0x2C
        // 0x56 after bit flipping becomes 0x6A
        // 0x78 after bit flipping becomes 0x1E
        expect(hfeData[3]).toBe(0x48);
        expect(hfeData[4]).toBe(0x2c);
        expect(hfeData[5]).toBe(0x6a);
        expect(hfeData[6]).toBe(0x1e);
    });
});
