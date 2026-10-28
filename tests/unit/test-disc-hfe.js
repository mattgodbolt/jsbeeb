import { describe, it, expect } from "vitest";

import { Disc, DiscConfig, loadAdf, loadSsd, sniffSurfaceLayout, toSsdOrDsd } from "../../src/disc.js";
import { loadHfe, sniffHfeLayout, toHfe, convertTrackToHfeV3 } from "../../src/disc-hfe.js";
import { SectorBytes, fmDiscWithSector, mfmDiscWithSector } from "../helpers/disc-builders.js";
import * as fs from "node:fs";

const TrackBytes = 10 * SectorBytes;

const EliteHfe = fs.readFileSync("public/discs/elite.hfe");
let sharedElite = null;
/** One parse for the whole file; no test writes to the disc it shares. */
function elite() {
    sharedElite ??= loadHfe(new Disc(true, new DiscConfig(), "elite.hfe"), EliteHfe);
    return sharedElite;
}

function reloaded(disc) {
    return loadHfe(new Disc(true, new DiscConfig(), "reloaded.hfe"), toHfe(disc));
}

const sectorsOf = (track) =>
    track
        .findSectors(() => {})
        .map((sector) => ({
            header: [...sector.header],
            isMfm: sector.isMfm,
            isDeleted: sector.isDeleted,
            hasHeaderCrcError: sector.hasHeaderCrcError,
            hasDataCrcError: sector.hasDataCrcError,
            sectorData: sector.sectorData && Buffer.from(sector.sectorData).toString("hex"),
        }));

function expectSameSectors(original, copy) {
    let sectorsCompared = 0;
    expect(copy.tracksUsed).toBe(original.tracksUsed);
    expect(copy.isDoubleSided).toBe(original.isDoubleSided);
    for (const isSideUpper of original.isDoubleSided ? [false, true] : [false]) {
        for (let trackNum = 0; trackNum < original.tracksUsed; ++trackNum) {
            const where = `side ${isSideUpper ? 1 : 0} track ${trackNum}`;
            const before = original.getTrack(isSideUpper, trackNum);
            const after = copy.getTrack(isSideUpper, trackNum);
            expect(after.length, where).toBe(before.length);
            const sectors = sectorsOf(before);
            expect(sectorsOf(after), where).toEqual(sectors);
            sectorsCompared += sectors.length;
        }
    }
    expect(sectorsCompared).toBeGreaterThan(0);
}

function countingImage(length, isDsd) {
    return loadSsd(
        new Disc(true, new DiscConfig(), "test.ssd"),
        new Uint8Array(length).map((_, i) => i & 0xff),
        isDsd,
    );
}

describe("HFE loader tests", function () {
    it("should load Elite", { timeout: 30000 }, () => {
        expect(elite().tracksUsed).toBe(81);
        const sectors = elite().getTrack(false, 0).findSectors();
        expect(sectors.length).toBe(10);
        for (const sector of sectors) {
            expect(sector.hasHeaderCrcError).toBe(false);
            expect(sector.hasDataCrcError).toBe(false);
        }
    });

    it("should refuse to save a protected disc as SSD or DSD", { timeout: 30000 }, () => {
        // Elite's protection puts sectors numbered 246 to 255 on track 2 and an unreadable one on
        // track 80, none of which a sector image can hold.
        expect(() => toSsdOrDsd(elite())).toThrow(
            "cannot be saved as SSD or DSD: it has 50 sectors numbered past the 10 a track holds, 1 sector with a CRC error.",
        );
    });

    it("should save what fits when forced", { timeout: 30000 }, () => {
        const saved = toSsdOrDsd(elite(), { force: true });

        // Elite is a 40 track disc captured in an 80 track drive, so its tracks sit on every other one.
        expect(saved.length).toBe(40 * 2 * TrackBytes);
        expect(new TextDecoder().decode(saved.slice(0, 8))).toBe("E L I T ");
    });

    const v3Header = (revision, encoding) => {
        const data = new Uint8Array(512);
        data.set(new TextEncoder().encode("HXCHFEV3"), 0);
        data[8] = revision;
        data[11] = encoding;
        return data;
    };

    it.each([
        ["missing header", new Uint8Array(10), /HFE file missing header/],
        ["bad header", new Uint8Array(512).fill(0x41), /HFE file bad header/],
        ["non-zero revision", v3Header(1, 0), /HFE file revision not 0/],
        ["unsupported encoding", v3Header(0, 1), /HFE encoding not ISOIBM/],
    ])("should reject an HFE file with a %s", (_, data, error) => {
        expect(() => loadHfe(new Disc(true, new DiscConfig(), "test.hfe"), data)).toThrow(error);
    });
});

describe("telling a 40 track HFE from an 80 track one", () => {
    const withTracks = (numTracks) => {
        const data = new Uint8Array(512);
        data.set(new TextEncoder().encode("HXCHFEV3"), 0);
        data[9] = numTracks;
        return data;
    };

    it("goes by the tracks the header declares", () => {
        expect(sniffHfeLayout(withTracks(40)).is40Track).toBe(true);
        expect(sniffHfeLayout(withTracks(42)).is40Track).toBe(true);
        expect(sniffHfeLayout(withTracks(43)).is40Track).toBe(false);
        expect(sniffHfeLayout(withTracks(80)).is40Track).toBe(false);
    });

    it("says nothing of a file with no header to read", () => {
        expect(sniffHfeLayout(new Uint8Array(4)).is40Track).toBe(false);
        expect(sniffHfeLayout(withTracks(0)).is40Track).toBe(false);
    });

    it("reads a capture that already holds one spread across the surface", { timeout: 30000 }, () => {
        // Elite is a 40 track disc as an 80 track drive sees it, so its header cannot say so.
        expect(sniffHfeLayout(EliteHfe).is40Track).toBe(false);
        expect(sniffSurfaceLayout(elite()).is40Track).toBe(true);
    });

    it("takes an 80 track disc at its word", () => {
        expect(sniffSurfaceLayout(reloaded(countingImage(80 * TrackBytes, false))).is40Track).toBe(false);
    });

    it("judges a disc whose sides disagree on the one that boots", { timeout: 30000 }, () => {
        // Elite is a dual format disc: side 0 written for a 40 track drive, side 1 for an 80 track
        // one, the same game on both. A drive's 40/80 switch is not per side, so the side DFS boots
        // from decides, and reaching the other one means setting the switch by hand.
        const lower = elite()
            .getTrack(false, 78)
            .findSectors(() => {});
        const upper = elite()
            .getTrack(true, 39)
            .findSectors(() => {});
        expect(lower[0].trackNumber).toBe(39);
        expect(upper[0].trackNumber).toBe(39);

        expect(sniffSurfaceLayout(elite()).is40Track).toBe(true);
    });

    it("wants more than a track or two before it believes", () => {
        const config = new DiscConfig();
        config.expandTo80 = true;
        const disc = loadSsd(new Disc(true, config, "test.ssd"), new Uint8Array(40 * TrackBytes), false, null);
        // A capture holding only the first couple of tracks cannot say which pitch it was at.
        for (let trackNum = 4; trackNum < disc.tracksUsed; ++trackNum) disc.eraseTrack(false, trackNum);

        expect(sniffSurfaceLayout(disc).is40Track).toBe(false);
    });

    it("expands a 40 track capture across the surface", () => {
        const source = new Disc(true, new DiscConfig(), "source.adf");
        loadAdf(source, new Uint8Array(40 * 16 * 256), false);

        const disc = new Disc(true, new DiscConfig(), "test.hfe");
        const hfe = toHfe(source);
        disc.config.expandTo80 = sniffHfeLayout(hfe).is40Track;
        loadHfe(disc, hfe);

        expect(disc.is40Track).toBe(true);
        expect(disc.tracksUsed).toBe(79);
        expect(disc.getTrack(false, 2).findSectors()[0].trackNumber).toBe(1);
        expect(disc.getTrack(false, 3).findSectors()).toEqual([]);
    });
});

describe("HFE export", function () {
    it.each([
        ["Elite, protection and all", elite],
        ["a single sided SSD", () => countingImage(TrackBytes, false)],
        ["a double sided DSD", () => countingImage(3 * 2 * TrackBytes, true)],
        ["an MFM track", () => mfmDiscWithSector()],
    ])(
        "reloads the sectors of %s as they were",
        (_, makeDisc) => {
            const disc = makeDisc();
            expectSameSectors(disc, reloaded(disc));
        },
        // Every track of every side is decoded twice, which coverage instrumentation slows a lot.
        60000,
    );

    it.each([
        ["single", () => fmDiscWithSector(), 1, 1],
        ["double", () => countingImage(TrackBytes, true), 80, 2],
    ])("writes a v3 header for a %s sided disc", (_, makeDisc, tracks, sides) => {
        const hfeData = toHfe(makeDisc());
        expect(new TextDecoder("ascii").decode(hfeData.slice(0, 8))).toBe("HXCHFEV3");
        expect([...hfeData.slice(8, 12)]).toEqual([0, tracks, sides, 2]);
    });
});

describe("HFE track conversion", function () {
    const RandFlipped = 0x2f;

    it.each([
        [
            "weak pulses as RAND",
            [0xaabbccdd, 0, 0x11223344],
            [0x55, 0xdd, 0x33, 0xbb, ...Array(4).fill(RandFlipped), 0x88, 0x44, 0xcc, 0x22],
        ],
        ["a leading 0xf0, which flips to an opcode, as RAND", [0xf0aabbcc], [RandFlipped, 0x55, 0xdd, 0x33]],
        ["a leading 0x0f, which flips to no opcode, as itself", [0x0f000000], [0xf0, 0x00, 0x00, 0x00]],
        ["ordinary pulses bit-flipped", [0x12345678], [0x48, 0x2c, 0x6a, 0x1e]],
    ])("encodes %s", (_, pulses, encoded) => {
        expect([...convertTrackToHfeV3(pulses).slice(3)]).toEqual(encoded);
    });
});
