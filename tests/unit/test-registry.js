import { describe, expect, it } from "vitest";
import { Disc, DiscConfig, IbmDiscFormat } from "../../src/disc.js";
import { discFor } from "../../src/fdc.js";
import { dfsCatalogue } from "../../tools/registry/dfs.js";
import {
    addressedSideBytes,
    fingerprint,
    fluxSideBytes,
    SectorSize,
    sectorImageSides,
    trimFill,
} from "../../tools/registry/fingerprint.js";

const DfsTrackBytes = 10 * SectorSize;
const AdfsTrackBytes = 16 * SectorSize;

// Distinct content per sector, so any reordering or loss shows up in the bytes.
function sectorBytes(sectors, seed = 1) {
    const bytes = new Uint8Array(sectors * SectorSize);
    for (let i = 0; i < bytes.length; ++i) bytes[i] = (i * 7 + seed * 31 + (i >> 8)) & 0xff;
    return bytes;
}

const withFill = (bytes, sectors, fill) => {
    const out = new Uint8Array(bytes.length + sectors * SectorSize).fill(fill);
    out.set(bytes);
    return out;
};

const CatalogueCycle = SectorSize + 4;
const CatalogueEntryBytes = SectorSize + 5;
const CatalogueBootAndSizeHigh = SectorSize + 6;
const CatalogueSizeLow = SectorSize + 7;
const FirstEntryAddresses = SectorSize + 8;
const FirstEntryDirectory = 15;
const ExecBoot = 0x30;

// A DFS catalogue for one file: `name` loaded at &1900, `length` bytes from sector 2.
function dfsDisc(name, length, totalSectors = 400) {
    const disc = new Uint8Array(totalSectors * SectorSize);
    disc.set(new TextEncoder().encode("TESTDISC"), 0);
    disc.set(new TextEncoder().encode(name.padEnd(7)), 8);
    disc[FirstEntryDirectory] = "$".charCodeAt(0);
    disc[CatalogueCycle] = 0x12;
    disc[CatalogueEntryBytes] = 8;
    disc[CatalogueBootAndSizeHigh] = ExecBoot | (totalSectors >> 8);
    disc[CatalogueSizeLow] = totalSectors & 0xff;
    // load, exec and length, little-endian, then the start sector
    disc.set([0x00, 0x19, 0x23, 0x80, length & 0xff, length >> 8, 0, 2], FirstEntryAddresses);
    disc.set(sectorBytes(Math.ceil(length / SectorSize)).subarray(0, length), 2 * SectorSize);
    return disc;
}

// Lays FM sectors onto a physical track, each with whatever header it's given.
function buildFmTrack(disc, physical, sectors) {
    const builder = disc.buildTrack(false, physical).appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs);
    for (const { track, id, data, badCrc = false } of sectors) {
        builder
            .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
            .resetCrc()
            .appendFmDataAndClocks(IbmDiscFormat.idMarkDataPattern, IbmDiscFormat.markClockPattern)
            .appendFmChunk([track, 0, id, 1])
            .appendCrc()
            .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
            .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
            .resetCrc()
            .appendFmDataAndClocks(IbmDiscFormat.dataMarkDataPattern, IbmDiscFormat.markClockPattern)
            .appendFmChunk(data);
        if (badCrc) builder.appendFmChunk([0xde, 0xad]);
        else builder.appendCrc();
        builder.appendRepeatFmByte(0xff, 16);
    }
    builder.fillFmByte(0xff);
}

const newDisc = () => new Disc(true, new DiscConfig(), "synthetic.hfe");
const sectorOf = (seed) => sectorBytes(1, seed);

// A renumbered protected track: logical track t claims to be `202 - t`, with sector IDs from 100.
const renumbered = (logical, seed) =>
    [0, 1].map((i) => ({ track: 202 - logical, id: 100 + i, data: sectorOf(seed + i) }));

const quietly = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
};

describe("Media registry fingerprint", () => {
    describe("sector image sides", () => {
        it("should split a DSD's alternating tracks into its two sides", () => {
            const side0 = sectorBytes(20, 1);
            const side1 = sectorBytes(20, 2);
            const dsd = new Uint8Array(40 * SectorSize);
            for (let track = 0; track < 2; ++track) {
                dsd.set(side0.subarray(track * DfsTrackBytes, (track + 1) * DfsTrackBytes), 2 * track * DfsTrackBytes);
                dsd.set(
                    side1.subarray(track * DfsTrackBytes, (track + 1) * DfsTrackBytes),
                    (2 * track + 1) * DfsTrackBytes,
                );
            }
            const sides = sectorImageSides("x.dsd", dsd);
            expect(Buffer.from(sides[0]).equals(Buffer.from(side0))).toBe(true);
            expect(Buffer.from(sides[1]).equals(Buffer.from(side1))).toBe(true);
        });

        it("should split an ADL by sixteen-sector tracks", () => {
            const adl = sectorBytes(64);
            const sides = sectorImageSides("x.adl", adl);
            expect(
                Buffer.from(sides[0].subarray(0, AdfsTrackBytes)).equals(Buffer.from(adl.subarray(0, AdfsTrackBytes))),
            ).toBe(true);
            expect(
                Buffer.from(sides[1].subarray(0, AdfsTrackBytes)).equals(
                    Buffer.from(adl.subarray(AdfsTrackBytes, 2 * AdfsTrackBytes)),
                ),
            ).toBe(true);
        });

        it("should read an ADF the size of an L disc as two interleaved sides", () => {
            const large = sectorBytes(2 * 80 * 16);
            const sides = sectorImageSides("x.adf", large);
            expect(sides).toHaveLength(2);
            expect(
                Buffer.from(sides[1].subarray(0, AdfsTrackBytes)).equals(
                    Buffer.from(large.subarray(AdfsTrackBytes, 2 * AdfsTrackBytes)),
                ),
            ).toBe(true);
            expect(sectorImageSides("x.adf", sectorBytes(80 * 16))).toHaveLength(1);
        });

        it("should keep a single-sided image as one side", () => {
            expect(sectorImageSides("x.ssd", sectorBytes(3))).toHaveLength(1);
        });
    });

    describe("trimming", () => {
        it("should drop trailing sectors of &E5 and &00 but nothing before them", () => {
            const data = sectorBytes(3);
            const padded = withFill(withFill(data, 2, 0xe5), 3, 0x00);
            const { data: trimmed, trimmedFill } = trimFill(padded);
            expect(Buffer.from(trimmed).equals(Buffer.from(data))).toBe(true);
            expect(Object.fromEntries(trimmedFill)).toEqual({ 0: 3, 0xe5: 2 });
        });

        it("should keep a trailing run of any other repeated byte", () => {
            const padded = withFill(sectorBytes(2), 2, 0x20);
            expect(trimFill(padded).data.length).toBe(padded.length);
        });

        it("should pad a short last sector with zeros before trimming", () => {
            const bytes = sectorBytes(2).subarray(0, SectorSize + 10);
            const { data } = trimFill(bytes);
            expect(data.length).toBe(2 * SectorSize);
            expect(data.subarray(SectorSize + 10).every((b) => b === 0)).toBe(true);
        });
    });

    describe("keys", () => {
        it("should give a truncated SSD and a padded one the same disc key but different file keys", () => {
            const disc = dfsDisc("GAME", 3000, 20);
            const padded = withFill(disc, 380, 0xe5);
            const a = fingerprint("a.ssd", disc);
            const b = fingerprint("b.ssd", padded);
            expect(a.discKey).toBe(b.discKey);
            expect(a.fileKey).not.toBe(b.fileKey);
        });

        it("should give a DSD with a blank second side the same disc key as an SSD of its first side", () => {
            const side0 = sectorBytes(20);
            const dsd = new Uint8Array(40 * SectorSize).fill(0xe5);
            for (let track = 0; track < 2; ++track)
                dsd.set(side0.subarray(track * DfsTrackBytes, (track + 1) * DfsTrackBytes), 2 * track * DfsTrackBytes);
            const fromDsd = fingerprint("x.dsd", dsd);
            expect(fromDsd.discKey).toBe(fingerprint("x.ssd", side0).discKey);
            expect(fromDsd.sideLengths).toEqual([side0.length, 0]);
        });

        it("should give each side of a double-sided disc a side key of its own", () => {
            const dsd = sectorBytes(40);
            const { sideKeys, discKey } = fingerprint("x.dsd", dsd);
            expect(new Set([...sideKeys, discKey]).size).toBe(3);
        });

        it("should make keys of 32 hex characters", () => {
            const { discKey, fileKey, sideKeys } = fingerprint("x.ssd", sectorBytes(4));
            for (const key of [discKey, fileKey, ...sideKeys]) expect(key).toMatch(/^[0-9a-f]{32}$/);
        });
    });

    describe("flux path", () => {
        const decode = (name, image, upper = false) =>
            quietly(() => fluxSideBytes(discFor(name, new Uint8Array(image)), upper));

        it("should decode an SSD loaded by jsbeeb back into its own bytes", () => {
            const image = dfsDisc("GAME", 20000, 800);
            const { data, is40Track, dropped } = decode("x.ssd", image);
            expect(is40Track).toBe(false);
            expect(dropped).toEqual({ crc: 0, wrongTrack: 0, duplicate: 0 });
            expect(Buffer.from(trimFill(data).data).equals(Buffer.from(trimFill(image).data))).toBe(true);
        });

        it("should decode a 40-track SSD spread over an 80-track surface back into its own bytes", () => {
            const image = dfsDisc("GAME", 60000, 400);
            const { data, is40Track } = decode("x.ssd", image);
            expect(is40Track).toBe(true);
            expect(Buffer.from(trimFill(data).data).equals(Buffer.from(trimFill(image).data))).toBe(true);
        });

        it("should decode each side of a DSD", () => {
            const image = sectorBytes(40);
            const [side0, side1] = sectorImageSides("x.dsd", image);
            expect(Buffer.from(trimFill(decode("x.dsd", image, false).data).data).equals(Buffer.from(side0))).toBe(
                true,
            );
            expect(Buffer.from(trimFill(decode("x.dsd", image, true).data).data).equals(Buffer.from(side1))).toBe(true);
        });
    });

    describe("flux sectors", () => {
        it("should keep sectors whose header claims another track, ordered by where they were read", () => {
            const disc = newDisc();
            buildFmTrack(disc, 0, [{ track: 0, id: 0, data: sectorOf(1) }]);
            buildFmTrack(disc, 1, [
                { track: 201, id: 101, data: sectorOf(3) },
                { track: 201, id: 100, data: sectorOf(2) },
            ]);
            const { data, dropped } = fluxSideBytes(disc, false);
            expect(dropped.wrongTrack).toBe(2);
            expect(Buffer.from(data).equals(Buffer.concat([sectorOf(1), sectorOf(2), sectorOf(3)]))).toBe(true);
        });

        it("should drop sectors whose header claims another track under the first draft's rule", () => {
            const disc = newDisc();
            buildFmTrack(disc, 0, [{ track: 0, id: 0, data: sectorOf(1) }]);
            buildFmTrack(disc, 1, [{ track: 201, id: 100, data: sectorOf(2) }]);
            const { data } = fluxSideBytes(disc, false, { trackRule: "strict" });
            expect(Buffer.from(data).equals(Buffer.from(sectorOf(1)))).toBe(true);
        });

        it("should drop sectors with bad CRCs and repeated IDs", () => {
            const disc = newDisc();
            buildFmTrack(disc, 0, [
                { track: 0, id: 0, data: sectorOf(1) },
                { track: 0, id: 1, data: sectorOf(2), badCrc: true },
                { track: 0, id: 0, data: sectorOf(3) },
            ]);
            const { data, dropped } = fluxSideBytes(disc, false);
            expect(dropped).toEqual({ crc: 1, wrongTrack: 0, duplicate: 1 });
            expect(Buffer.from(data).equals(Buffer.from(sectorOf(1)))).toBe(true);
        });
    });

    describe("track pitch", () => {
        it("should never call a capture with nothing past track 50 double-stepped", () => {
            const disc = newDisc();
            for (let physical = 0; physical <= 40; physical += 2)
                buildFmTrack(disc, physical, [{ track: physical / 2, id: 0, data: sectorOf(physical) }]);
            expect(fluxSideBytes(disc, false).is40Track).toBe(false);
        });

        it("should call a renumbered disc double-stepped when its odd tracks only hold ghosts", () => {
            const disc = newDisc();
            for (let logical = 0; logical < 40; ++logical) {
                buildFmTrack(disc, 2 * logical, renumbered(logical, 10 * logical));
                if (logical < 39) buildFmTrack(disc, 2 * logical + 1, renumbered(logical, 10 * logical));
            }
            const { data, is40Track } = fluxSideBytes(disc, false);
            expect(is40Track).toBe(true);
            const inTrackOrder = Array.from({ length: 40 }, (_, logical) =>
                renumbered(logical, 10 * logical).map(({ data: sector }) => sector),
            ).flat();
            expect(Buffer.from(data).equals(Buffer.concat(inTrackOrder))).toBe(true);
        });

        it("should keep an 80-track disc 80-track when one odd track repeats its neighbour", () => {
            const disc = newDisc();
            for (let physical = 0; physical < 80; ++physical)
                buildFmTrack(disc, physical, renumbered(physical, physical));
            buildFmTrack(disc, 11, renumbered(10, 10));
            expect(fluxSideBytes(disc, false).is40Track).toBe(false);
        });

        // Every fifth odd track holds data of its own, too much for the ghost test to pass.
        const withOwnOddTracks = (halfHeaderTracks) => {
            const disc = newDisc();
            for (let logical = 0; logical < 40; ++logical) {
                const track = logical < halfHeaderTracks ? logical : 202 - logical;
                buildFmTrack(disc, 2 * logical, [{ track, id: 0, data: sectorOf(logical) }]);
                if (logical % 5 === 0)
                    buildFmTrack(disc, 2 * logical + 1, [{ track: 150, id: 0, data: sectorOf(90 + logical) }]);
            }
            return fluxSideBytes(disc, false).is40Track;
        };

        it("should call a disc double-stepped from its headers alone", () => {
            expect(withOwnOddTracks(40)).toBe(true);
        });

        it("should want at least four tracks of header evidence, not counting track 0", () => {
            expect(withOwnOddTracks(5)).toBe(true);
            expect(withOwnOddTracks(4)).toBe(false);
        });
    });

    describe("DFS catalogue", () => {
        it("should read the title, boot option and each file's addresses", () => {
            const catalogue = dfsCatalogue(dfsDisc("GAME", 3000));
            expect(catalogue).toMatchObject({ title: "TESTDISC", cycle: 0x12, boot: 3, totalSectors: 400 });
            expect(catalogue.files).toEqual([
                expect.objectContaining({
                    name: "$.GAME",
                    load: 0x1900,
                    exec: 0x8023,
                    length: 3000,
                    start: 2,
                    complete: true,
                }),
            ]);
        });

        it("should hash a file's contents, not its position", () => {
            const disc = dfsDisc("GAME", 3000);
            const moved = new Uint8Array(disc);
            moved[SectorSize + 15] = 5;
            moved.set(disc.subarray(2 * SectorSize, 14 * SectorSize), 5 * SectorSize);
            expect(dfsCatalogue(moved).files[0].hash).toBe(dfsCatalogue(disc).files[0].hash);
        });

        it("should read a file where DFS addresses it even with a protection sector on its track", () => {
            const image = dfsDisc("GAME", 3000, 20);
            const disc = newDisc();
            const trackOf = (track) =>
                Array.from({ length: 10 }, (_, id) => ({
                    track,
                    id,
                    data: image.subarray((track * 10 + id) * SectorSize, (track * 10 + id + 1) * SectorSize),
                }));
            buildFmTrack(disc, 0, trackOf(0));
            // It claims the same sector number as one of the file's, and comes first.
            buildFmTrack(disc, 1, [{ track: 201, id: 2, data: sectorOf(77) }, ...trackOf(1)]);
            const [file] = dfsCatalogue(addressedSideBytes(disc, false)).files;
            expect(file).toMatchObject({ complete: true, hash: dfsCatalogue(image).files[0].hash });
        });

        it("should address sectors at the first track's density even if a later track is MFM", () => {
            const image = dfsDisc("GAME", 3000, 20);
            const disc = newDisc();
            const trackOf = (track) =>
                Array.from({ length: 10 }, (_, id) => ({
                    track,
                    id,
                    data: image.subarray((track * 10 + id) * SectorSize, (track * 10 + id + 1) * SectorSize),
                }));
            buildFmTrack(disc, 0, trackOf(0));
            buildFmTrack(disc, 1, trackOf(1));
            disc.buildTrack(false, 2)
                .appendRepeatMfmByte(0x4e, 60)
                .appendRepeatMfmByte(0x00, 12)
                .resetCrc()
                .appendMfm3xA1Sync()
                .appendMfmByte(IbmDiscFormat.idMarkDataPattern)
                .appendMfmChunk([2, 0, 15, 1])
                .appendCrc()
                .appendRepeatMfmByte(0x4e, 22)
                .appendRepeatMfmByte(0x00, 12)
                .resetCrc()
                .appendMfm3xA1Sync()
                .appendMfmByte(IbmDiscFormat.dataMarkDataPattern)
                .appendMfmChunk(sectorOf(33))
                .appendCrc()
                .fillMfmByte(0x4e);
            const [file] = dfsCatalogue(addressedSideBytes(disc, false)).files;
            expect(file).toMatchObject({ complete: true, hash: dfsCatalogue(image).files[0].hash });
        });

        it("should count a file lying over sectors that weren't read as incomplete", () => {
            const image = dfsDisc("GAME", 3000, 20);
            const disc = newDisc();
            const track0 = Array.from({ length: 10 }, (_, id) => ({
                track: 0,
                id,
                data: image.subarray(id * SectorSize, (id + 1) * SectorSize),
            }));
            buildFmTrack(disc, 0, track0);
            buildFmTrack(disc, 1, [{ track: 1, id: 0, data: image.subarray(10 * SectorSize, 11 * SectorSize) }]);
            const [file] = dfsCatalogue(addressedSideBytes(disc, false)).files;
            expect(file.complete).toBe(false);
        });

        it("should flag a file that is one repeated byte", () => {
            const image = dfsDisc("GAME", 3000);
            image.fill(0xe5, 2 * SectorSize, 2 * SectorSize + 3000);
            expect(dfsCatalogue(image).files[0].uniform).toBe(true);
        });

        it("should refuse bytes that aren't a catalogue", () => {
            expect(dfsCatalogue(sectorBytes(4))).toBeNull();
        });
    });
});
