import { describe, expect, it } from "vitest";
import { discFor } from "../../src/fdc.js";
import { dfsCatalogue } from "../../tools/registry/dfs.js";
import {
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

// A DFS catalogue for one file: `name` loaded at &1900, `length` bytes from sector 2.
function dfsDisc(name, length, totalSectors = 400) {
    const disc = new Uint8Array(totalSectors * SectorSize);
    disc.set(new TextEncoder().encode("TESTDISC"), 0);
    disc.set(new TextEncoder().encode(name.padEnd(7)), 8);
    disc[15] = "$".charCodeAt(0);
    const s1 = SectorSize;
    disc[s1 + 4] = 0x12; // cycle
    disc[s1 + 5] = 8; // one entry
    disc[s1 + 6] = 0x30 | (totalSectors >> 8); // *EXEC !BOOT
    disc[s1 + 7] = totalSectors & 0xff;
    disc[s1 + 8] = 0x00; // load &1900
    disc[s1 + 9] = 0x19;
    disc[s1 + 10] = 0x23; // exec &8023
    disc[s1 + 11] = 0x80;
    disc[s1 + 12] = length & 0xff;
    disc[s1 + 13] = length >> 8;
    disc[s1 + 14] = 0;
    disc[s1 + 15] = 2; // start sector
    disc.set(sectorBytes(Math.ceil(length / SectorSize)).subarray(0, length), 2 * SectorSize);
    return disc;
}

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

        it("should refuse bytes that aren't a catalogue", () => {
            expect(dfsCatalogue(sectorBytes(4))).toBeNull();
        });
    });
});
