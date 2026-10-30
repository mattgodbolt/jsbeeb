import { afterEach, describe, it, expect, vi } from "vitest";

import {
    BitWindow64,
    Disc,
    DiscConfig,
    dfsCatalogue,
    discReport,
    numberRuns,
    DiscLayout,
    loadSsd,
    loadAdf,
    sniffDfsLayout,
    toSsdOrDsd,
} from "../../src/disc.js";
import { IbmDiscFormat } from "../../src/disc-format.js";
import * as fs from "node:fs";
import { crc32 } from "../../src/archive.js";
import { ssdImage } from "./helpers.js";
import { discFor } from "../../src/fdc.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";
import { appendFmSector, corruptSectorData, fmDiscWithSector, mfmDiscWithSector } from "../helpers/disc-builders.js";

afterEach(() => vi.restoreAllMocks());

describe("BitWindow64", function () {
    /** Shift the low `count` bits of a BigInt in, most significant first. */
    function shiftIn(window, value, count = 64) {
        for (let bit = count - 1; bit >= 0; --bit) window.shiftIn(Number((value >> BigInt(bit)) & 1n));
        return window;
    }

    it.each([
        [0xaaaa448944894489n, 0xaaaa4489, 0x44894489],
        [0xffffffffffffffffn, 0xffffffff, 0xffffffff],
    ])("holds the last 64 bits shifted in, both halves unsigned: %s", (value, hi, lo) => {
        const window = shiftIn(new BitWindow64(), value);
        expect([window.hi, window.lo]).toEqual([hi, lo]);
    });

    it("matches a 64 bit value only in full", () => {
        const window = shiftIn(new BitWindow64(), 0xaaaa448944894489n);
        expect(window.equals(0xaaaa4489, 0x44894489)).toBe(true);
        expect(window.equals(0xaaaa4489, 0x44894488)).toBe(false);
        expect(window.equals(0xaaaa4488, 0x44894489)).toBe(false);
    });

    it.each([
        [0x1234567988888888n, 8],
        [0x1234567888888888n, 9],
        [0x1238888888888888n, 13],
        [0x8888888888888888n, 16],
        [0x8888888888888880n, 0],
    ])("counts the run of 8 nibbles ending at bit 0 of %s as %i", (value, expected) => {
        expect(shiftIn(new BitWindow64(), value).countTrailingNibbles(0x8)).toBe(expected);
    });
});

describe("Disc builder tests", () => {
    it.each([
        ["FM", fmDiscWithSector],
        ["MFM", mfmDiscWithSector],
    ])("builds an %s track whose CRCs check", (_, discWithSector) => {
        const sectors = discWithSector().getTrack(false, 0).findSectors();
        expect(sectors).toHaveLength(1);
        expect(sectors[0].hasHeaderCrcError).toBe(false);
        expect(sectors[0].hasDataCrcError).toBe(false);
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

    it.each([
        ["FM", false, [4, 4, 8, 8, 4, 8, 8, 8, 8, 8, 8, 8, 8]],
        ["MFM", true, [4, 4, 6, 6, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6]],
    ])("should build from %s pulses", (_, isMfm, pulses) => {
        const builder = new Disc(true, new DiscConfig(), "test.ssd").buildTrack(false, 0);
        builder.buildFromPulses(pulses, isMfm);
        expect(builder.track.length).toBe(1);
    });
});

describe("SSD loader tests", function () {
    it("should load and roundtrip Elite", { timeout: 60000 }, () => {
        const data = new Uint8Array(fs.readFileSync("public/discs/elite.ssd"));
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, data, false);
        expect(disc.tracksUsed).toBe(80);

        const ssdSaved = toSsdOrDsd(disc);
        expect(ssdSaved.slice(0, data.length)).toEqual(data);
        expect(ssdSaved.slice(data.length).every((byte) => byte === 0)).toBe(true);
    });

    it("should load an SSD whose size is not a multiple of sector size", () => {
        const oddData = new Uint8Array(SectorSize * 2 + 100).map((_, i) => i & 0xff);
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, oddData, false);

        const sectors = disc.getTrack(false, 0).findSectors();
        expect(sectors.length).toBe(10);
        for (const sector of sectors) {
            expect(sector.hasHeaderCrcError).toBe(false);
            expect(sector.hasDataCrcError).toBe(false);
        }
    });
});

const SectorSize = 256;
const SectorsPerTrack = 10;
const TrackSize = SectorSize * SectorsPerTrack;

/** An image where every sector says which logical track and sector it holds. */
function numberedImage(numTracks, numSides = 1) {
    const data = new Uint8Array(numTracks * numSides * TrackSize);
    for (let offset = 0; offset < data.length; offset += SectorSize) {
        const sector = (offset / SectorSize) % SectorsPerTrack;
        const track = Math.floor(offset / TrackSize / numSides);
        data.set([track, sector, Math.floor(offset / TrackSize) % numSides], offset);
    }
    return data;
}

function fortyTrackDisc(data, isDsd = false, onChange = null) {
    const config = new DiscConfig();
    config.expandTo80 = true;
    return loadSsd(new Disc(true, config, "test.ssd"), data, isDsd, onChange);
}

describe("SSD track skew", () => {
    const sectorOrder = (disc, isSide1, track) =>
        disc
            .getTrack(isSide1, track)
            .findSectors()
            .map((sector) => sector.sectorNumber);

    it("starts each track three sectors later than the one before, as Acorn's *FORM does", () => {
        const disc = loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), numberedImage(80), false, null);

        expect(sectorOrder(disc, false, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(sectorOrder(disc, false, 1)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6]);
        expect(sectorOrder(disc, false, 2)).toEqual([4, 5, 6, 7, 8, 9, 0, 1, 2, 3]);
        expect(sectorOrder(disc, false, 3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
        expect(sectorOrder(disc, false, 10)).toEqual(sectorOrder(disc, false, 0));
    });

    it("keeps each sector's data with its ID", () => {
        const disc = loadSsd(new Disc(true, new DiscConfig(), "test.dsd"), numberedImage(80, 2), true, null);

        for (const isSide1 of [false, true]) {
            for (const track of [0, 1, 2, 79]) {
                for (const sector of disc.getTrack(isSide1, track).findSectors()) {
                    expect([...sector.sectorData.slice(0, 3)]).toEqual([track, sector.sectorNumber, isSide1 ? 1 : 0]);
                }
            }
        }
    });

    it("skews both sides of a DSD alike", () => {
        const disc = loadSsd(new Disc(true, new DiscConfig(), "test.dsd"), numberedImage(80, 2), true, null);

        for (const track of [0, 1, 2]) expect(sectorOrder(disc, true, track)).toEqual(sectorOrder(disc, false, track));
    });

    it("skews a 40 track image by its logical track", () => {
        const disc = fortyTrackDisc(numberedImage(40));

        expect(sectorOrder(disc, false, 2)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6]);
    });
});

describe("40 track SSD images", () => {
    it("puts each logical track on every other physical track", () => {
        const disc = fortyTrackDisc(numberedImage(40));

        expect(disc.is40Track).toBe(true);
        expect(disc.tracksUsed).toBe(79);
        for (const [logical, physical] of [
            [0, 0],
            [1, 2],
            [39, 78],
        ]) {
            const sectors = disc.getTrack(false, physical).findSectors();
            expect(sectors.length).toBe(SectorsPerTrack);
            for (const sector of sectors) {
                expect(sector.trackNumber).toBe(logical);
                expect([...sector.sectorData.slice(0, 2)]).toEqual([logical, sector.sectorNumber]);
            }
        }
    });

    it("leaves the tracks in between unformatted", () => {
        const disc = fortyTrackDisc(numberedImage(40));

        for (const physical of [1, 3, 77]) expect(disc.getTrack(false, physical).findSectors()).toEqual([]);
    });

    // Whole-image round trips are slow under coverage instrumentation on CI.
    it("saves back to the image it was loaded from", { timeout: 60000 }, () => {
        for (const numSides of [1, 2]) {
            const image = numberedImage(40, numSides);
            expect(toSsdOrDsd(fortyTrackDisc(image, numSides === 2))).toEqual(image);
        }
    });

    it("ignores the padding of an image sized for 80 tracks", () => {
        const padded = new Uint8Array(80 * TrackSize);
        padded.set(numberedImage(40));

        expect(fortyTrackDisc(padded).tracksUsed).toBe(79);
    });

    it("reaches past the 40th track for an image with data there", () => {
        expect(fortyTrackDisc(numberedImage(41)).tracksUsed).toBe(81);
    });

    it("stops at the surface's outer edge however much data it is given", () => {
        expect(fortyTrackDisc(numberedImage(50)).tracksUsed).toBe(83);
    });

    it("keeps an image loader's writeback in logical order", () => {
        const image = numberedImage(40);
        let written = null;
        const disc = fortyTrackDisc(image, false, (data) => (written = data));

        // Rewriting physical track 4 rewrites logical track 2, wherever the image keeps it.
        disc.writePulses(false, 4, 0, disc.readPulses(false, 4, 0));
        disc.flushWrites();

        expect(written.slice(0, image.length)).toEqual(image);
    });
});

describe("telling a 40 track image from an 80 track one", () => {
    const is40Track = (data, isDsd = false) => sniffDfsLayout(data, isDsd).is40Track;

    it("goes by the sector count a catalogue claims", () => {
        expect(is40Track(ssdImage(400))).toBe(true);
        expect(is40Track(ssdImage(800))).toBe(false);
    });

    it("leaves a disc nobody has formatted alone", () => {
        expect(is40Track(new Uint8Array(80 * TrackSize))).toBe(false);
    });

    it("cares nothing for the size of the file", () => {
        expect(is40Track(ssdImage(400, { length: 8 * TrackSize }))).toBe(true);
        expect(is40Track(ssdImage(800, { length: 8 * TrackSize }))).toBe(false);
    });

    it("wants a catalogue at all", () => {
        expect(is40Track(ssdImage(400).slice(0, 300))).toBe(false);
        const garbage = ssdImage(400);
        garbage[0x105] = 3;
        expect(is40Track(garbage)).toBe(false);
    });

    it("does not mind a catalogue whose files are in an order DFS would not have written", () => {
        expect(is40Track(ssdImage(400, { starts: [2, 50, 100] }))).toBe(true);
    });

    it("turns down an image with data past where 40 tracks reach", () => {
        const beyond = ssdImage(400);
        beyond[43 * TrackSize] = 1;
        expect(is40Track(beyond)).toBe(false);
    });

    it("counts a double sided image's tracks across both of its sides", () => {
        const dsd = ssdImage(400, { length: 80 * TrackSize * 2 });
        dsd[80 * TrackSize] = 1;

        expect(is40Track(dsd, true)).toBe(true);
        expect(is40Track(dsd, false)).toBe(false);
    });
});

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

/** Most discs have nothing watching them: fdc.js discards onChange for ADF, ADM and ADL, and
 *  discFor is usually called without one. */
function unobservedDisc() {
    const disc = new Disc(true, new DiscConfig(), "test.ssd");
    loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, null);
    return disc;
}

/** Leaves a sector's header pointing at nothing, which the decoder complains about. */
function eraseDataField(track, sectorNumber) {
    const sector = track.findSectors(() => {})[sectorNumber];
    // dataPosBitOffset is the offset after the address mark, so back up over the mark itself.
    const start = Math.floor(sector.dataPosBitOffset / 32) - 1;
    for (let word = start; word < start + 256; ++word) track.pulses2Us[word] = IbmDiscFormat.fmTo2usPulses(0xff, 0xff);
}

describe("numbers folded into runs", () => {
    it.each([
        [[9], "9"],
        [[3, 4, 5, 9], "3-5, 9"],
        [[3, 3, 4], "3-4"],
    ])("writes %j as %s", (numbers, text) => {
        expect(numberRuns(numbers)).toBe(text);
    });
});

describe("the report on a side of a disc", () => {
    const TracksWithData = 10;
    const ssd = (sectors, layout) =>
        discFor("test.ssd", ssdImage(sectors, { length: sectors * 256 }), undefined, layout);

    it.each([
        ["an 80 track disc", DiscLayout.contiguous],
        ["a 40 track disc spread over 80, numbered as its sectors number them", DiscLayout.auto],
    ])("finds nothing odd on %s", (_, layout) => {
        expect(discReport(ssd(TracksWithData * 10, layout), false)).toEqual([]);
    });

    it("folds unformatted tracks into runs", () => {
        const disc = fmDiscWithSector();
        disc.setTrackUsed(false, 3);
        expect(discReport(disc, false)).toContainEqual({ trackNum: 1, fraction: 0, text: "tracks 1-3: unformatted" });
    });

    it("tells tracks with flux but no sector IDs from unformatted ones, a run of each", () => {
        const disc = Disc.createBlank();
        for (const trackNum of [0, 1]) disc.buildTrack(false, trackNum).fillFmByte(0xff);
        disc.setTrackUsed(false, 2);
        expect(discReport(disc, false).map(({ text }) => text)).toEqual([
            "tracks 0-1: flux, but no sector IDs",
            "track 2: unformatted",
        ]);
    });

    /** A track 0 of ten FM sectors, each as `options` says, ending where `finish` leaves it. */
    const tenSectors = (options, finish) => {
        const disc = Disc.createBlank();
        const builder = disc.buildTrack(false, 0);
        for (let sector = 0; sector < 10; ++sector) appendFmSector(builder, { sector, ...options });
        finish(builder);
        return disc;
    };
    const standard = (builder) => builder.fillFmByte(0xff);

    it.each([
        [
            "a short track",
            tenSectors({}, (builder) => builder.setTrackLength()),
            /^track 0: short, \d+% of the standard length$/,
        ],
        [
            "a long track",
            tenSectors({}, (builder) =>
                builder.appendRepeatFmByte(0xff, IbmDiscFormat.bytesPerTrack / 2).setTrackLength(),
            ),
            /^track 0: long, \d+% of the standard length$/,
        ],
        ["an unusual sector count", fmDiscWithSector(), /^track 0: 1 FM sector$/],
        [
            "sectors claiming another track",
            tenSectors({ track: 5 }, standard),
            /^track 0: sectors 0-9 with a header claiming track 5$/,
        ],
    ])("reports %s", (_, disc, finding) => {
        expect(discReport(disc, false).map(({ text }) => text)).toContainEqual(expect.stringMatching(finding));
    });

    it("reports a bad header CRC", () => {
        const disc = tenSectors({}, standard);
        const track = disc.getTrack(false, 0);
        const headerWord = Math.floor(track.findSectors()[3].idPosBitOffset / 32) + 1;
        track.pulses2Us[headerWord] = IbmDiscFormat.fmTo2usPulses(0xff, 0x55);
        expect(discReport(disc, false).map(({ text }) => text)).toContainEqual(
            expect.stringMatching(/^track 0: sector \d+ with a bad header CRC$/),
        );
    });

    it("names the sectors that share a fault together", () => {
        const disc = unobservedDisc();
        for (const sectorNumber of [2, 5]) corruptSectorData(disc.getTrack(false, 0), sectorNumber);
        expect(discReport(disc, false).map(({ text }) => text)).toEqual(["track 0: sectors 2, 5 with a bad data CRC"]);
    });

    it("says where on the track something is odd, so the surface can be shown there", () => {
        const disc = unobservedDisc();
        eraseDataField(disc.getTrack(false, 0), 4);
        const findings = discReport(disc, false);
        expect(findings.map(({ text }) => text)).toContain("track 0: sector 4's header has no data after it");
        const sector4 = disc.getTrack(false, 0).findSectors()[4];
        const finding = findings.find(({ text }) => text.includes("sector 4's header"));
        expect(finding.fraction).toBeCloseTo(sector4.idPosBitOffset / (disc.getTrack(false, 0).length * 32));
    });
});

describe("reading the sticker off a disc", () => {
    const loaded = (data, isDsd = false) => loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), data, isDsd);
    const titled = (title, cycle, { sectors = 800, side = 0, isDsd = false } = {}) => {
        const data = ssdImage(sectors, { length: 80 * TrackSize * (isDsd ? 2 : 1) });
        const base = side * TrackSize;
        data.set(new TextEncoder().encode(title.slice(0, 8)), base);
        data.set(new TextEncoder().encode(title.slice(8, 12)), base + SectorSize);
        data[base + SectorSize + 4] = cycle;
        return data;
    };

    it("reads the title and cycle number Acornsoft put on Elite", () => {
        const disc = loaded(fs.readFileSync("public/discs/elite.ssd"));
        expect(dfsCatalogue(disc)).toEqual({ title: "Elite", cycle: "05" });
    });

    it("joins the title's two halves and reads the cycle as the BCD it is", () => {
        expect(dfsCatalogue(loaded(titled("WELCOME-DISK", 0x12)))).toEqual({ title: "WELCOME-DISK", cycle: "12" });
    });

    it("drops the padding and anything unprintable", () => {
        const data = titled("GAMES", 0x01);
        data[5] = 0;
        data[6] = 0xff;
        expect(dfsCatalogue(loaded(data))).toEqual({ title: "GAMES", cycle: "01" });
    });

    it("reads each side of a double sided disc for itself", () => {
        const data = titled("SIDE 0", 0x01, { isDsd: true });
        const upper = titled("SIDE 2", 0x02, { isDsd: true, side: 1 });
        data.set(upper.subarray(TrackSize, 2 * TrackSize), TrackSize);
        const disc = loaded(data, true);
        expect(dfsCatalogue(disc, false)).toEqual({ title: "SIDE 0", cycle: "01" });
        expect(dfsCatalogue(disc, true)).toEqual({ title: "SIDE 2", cycle: "02" });
    });

    it("reads a freshly formatted disc as untitled and never written", () => {
        expect(dfsCatalogue(unobservedDisc())).toEqual({ title: "", cycle: "00" });
    });

    it("finds no catalogue on a surface nobody has formatted", () => {
        expect(dfsCatalogue(Disc.createBlank())).toBeNull();
    });

    it("finds no catalogue where the entry count is not a DFS one", () => {
        const data = titled("NOT DFS", 0x01);
        data[0x105] = 3;
        expect(dfsCatalogue(loaded(data))).toBeNull();
    });

    it("finds no catalogue when a catalogue sector cannot be read", () => {
        const disc = loaded(titled("LOST", 0x01));
        eraseDataField(disc.getTrack(false, 0), 1);
        expect(dfsCatalogue(disc)).toBeNull();
    });
});

describe("flushWrites marks the surface used", () => {
    it("notices a write to the upper side of a disc loaded as single sided", () => {
        const disc = unobservedDisc();
        expect(disc.isDoubleSided).toBe(false);

        disc.writePulses(true, 0, 0, 0xffff);
        disc.flushWrites();

        // Without this, snapshotState() saves one side and the write is lost on rewind.
        expect(disc.isDoubleSided).toBe(true);
        expect(Object.keys(disc.snapshotState().tracks).some((key) => key.startsWith("true:"))).toBe(true);
    });

    it("extends the used tracks when written past the end of the image", () => {
        const disc = unobservedDisc();
        const beyond = disc.tracksUsed;

        disc.writePulses(false, beyond, 0, 0xffff);
        disc.flushWrites();

        expect(disc.tracksUsed).toBe(beyond + 1);
    });
});

describe("track write listeners", () => {
    it("reports the flushed track to every listener", () => {
        const disc = unobservedDisc();
        const seen = [];
        for (let i = 0; i < 2; ++i)
            disc.addTrackWriteListener((isSideUpper, trackNum, track) =>
                seen.push([isSideUpper, trackNum, track.length]),
            );
        disc.writePulses(false, 3, 0, 0);
        disc.flushWrites();

        const expected = [false, 3, disc.getTrack(false, 3).length];
        expect(seen).toEqual([expected, expected]);
    });

    it("reports the side and track that were written, not the ones in progress", () => {
        const disc = unobservedDisc();
        const seen = [];
        disc.addTrackWriteListener((isSideUpper, trackNum) => seen.push([isSideUpper, trackNum, disc.isDirty]));
        disc.writePulses(true, 7, 0, 0);
        disc.flushWrites();

        // The dirty state is cleared before anyone is told, so a listener may write in turn.
        expect(seen).toEqual([[true, 7, false]]);
    });

    it("says nothing when there was nothing to flush", () => {
        const disc = unobservedDisc();
        let calls = 0;
        disc.addTrackWriteListener(() => calls++);
        disc.flushWrites();
        expect(calls).toBe(0);
    });

    it("stops reporting to a listener that has been removed", () => {
        const disc = unobservedDisc();
        let calls = 0;
        const listener = () => calls++;
        disc.addTrackWriteListener(listener);
        disc.removeTrackWriteListener(listener);
        disc.writePulses(false, 1, 0, 0);
        disc.flushWrites();
        expect(calls).toBe(0);
    });

    it("keeps an image loader's own writeback working when something else watches too", () => {
        let imageUpdates = 0;
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, () => imageUpdates++);
        let watcherCalls = 0;
        disc.addTrackWriteListener(() => watcherCalls++);

        disc.writePulses(false, 2, 0, 0);
        disc.flushWrites();

        expect(imageUpdates).toBe(1);
        expect(watcherCalls).toBe(1);
    });

    it("tells a first-write listener once, however many tracks are written", () => {
        const disc = unobservedDisc();
        let calls = 0;
        disc.notifyOnFirstTrackWrite(() => calls++);

        for (const trackNum of [0, 1, 2]) {
            disc.writePulses(false, trackNum, 0, 0);
            disc.flushWrites();
        }

        expect(calls).toBe(1);
    });

    it("counts first writes per disc, not once for all of them", () => {
        let calls = 0;
        for (const disc of [unobservedDisc(), unobservedDisc()]) {
            disc.notifyOnFirstTrackWrite(() => calls++);
            disc.writePulses(false, 0, 0, 0);
            disc.flushWrites();
        }

        expect(calls).toBe(2);
    });

    it("writes an image back for a track holding a sector it cannot read", () => {
        const sectorsPerTrack = 10;
        const sectorSize = 256;
        const data = new Uint8Array(sectorsPerTrack * sectorSize).fill(0xa5);
        let image = null;
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        loadSsd(disc, data, false, (updated) => (image = updated));
        eraseDataField(disc.getTrack(false, 0), 4);

        disc.writePulses(false, 0, 0, 0);
        disc.flushWrites();

        expect(image).not.toBeNull();
        expect(image.slice(0, sectorsPerTrack * sectorSize)).toEqual(data);
    });
});

describe("erasing a track", () => {
    it("tells the listeners which track it wiped", () => {
        const disc = unobservedDisc();
        const seen = [];
        disc.addTrackWriteListener((isSideUpper, trackNum) => seen.push([isSideUpper, trackNum]));

        disc.eraseTrack(false, 1);

        expect(seen).toEqual([[false, 1]]);
        expect(disc.getTrack(false, 1).findSectors()).toEqual([]);
    });

    it("offers the erasure to the next snapshot", () => {
        const disc = unobservedDisc();
        disc.snapshotState();

        disc.eraseTrack(false, 1);
        disc.restoreState(disc.snapshotState());

        expect(disc.getTrack(false, 1).findSectors()).toEqual([]);
    });
});

describe("sector decoding warnings", () => {
    it("goes to the caller that asks for it, and never to the console", () => {
        const disc = unobservedDisc();
        const track = disc.getTrack(false, 0);
        eraseDataField(track, 4);

        const console = vi.spyOn(globalThis.console, "log");
        const warnings = [];
        track.findSectors((message) => warnings.push(message));
        track.findSectors();

        expect(warnings.length).toBeGreaterThan(0);
        expect(console).not.toHaveBeenCalled();
    });

    it.each([
        ["warns of an FM mark after only two sync bytes", IbmDiscFormat.stdGap1FFs, 2, true],
        ["takes three sync bytes before an FM mark as enough", IbmDiscFormat.stdGap1FFs, 3, false],
        ["counts nothing before the track's start as sync", 0, 2, true],
    ])("%s", (_, gapBytes, syncBytes, isShort) => {
        const disc = Disc.createBlank();
        disc.buildTrack(false, 0)
            .appendRepeatFmByte(0xff, gapBytes)
            .appendRepeatFmByte(0x00, syncBytes)
            .resetCrc()
            .appendFmDataAndClocks(IbmDiscFormat.idMarkDataPattern, IbmDiscFormat.markClockPattern)
            .appendRepeatFmByte(0, 4)
            .appendCrc()
            .fillFmByte(0xff);
        const warnings = [];
        const sectors = disc.getTrack(false, 0).findSectors((message) => warnings.push(message));

        expect(sectors).toHaveLength(1);
        expect(warnings.some((message) => message.startsWith("short zeros sync"))).toBe(isShort);
    });
});

describe("restoring a state's written tracks", () => {
    it("tells the disc's write listeners, so a disc kept at its source takes them there", () => {
        const disc = discFor("kept.ssd", ssdImage());
        const written = [];
        disc.addTrackWriteListener((isSideUpper, trackNum) => written.push([isSideUpper, trackNum]), true);
        const track = disc.getTrack(false, 3);
        disc.restoreState({
            tracksUsed: disc.tracksUsed,
            isDoubleSided: false,
            isWriteable: true,
            name: "kept.ssd",
            tracks: {},
            dirtyTracks: { "false:3": { pulses2Us: track.pulses2Us.slice(), length: track.length } },
        });
        expect(written).toEqual([[false, 3]]);
    });
});

describe("a disc's snapshot", () => {
    const write = (disc, track, pulses) => {
        disc.writePulses(false, track, 0, pulses);
        disc.flushWrites();
    };

    it("brings back the tracks as they were when it was taken", () =>
        expectSnapshotRoundTrips(unobservedDisc, (disc) => write(disc, 0, 0x12345678)));

    it("puts back a track written since it was taken", () => {
        const disc = unobservedDisc();
        const before = disc.getTrack(false, 0).pulses2Us[0];
        const state = disc.snapshotState();

        write(disc, 0, 0xdeadbeef);
        disc.restoreState(state);

        expect(disc.getTrack(false, 0).pulses2Us[0]).toBe(before);
    });

    it("shares a clean track with the snapshot before it, and copies a written one", () => {
        const disc = loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), ssdImage(20), false);
        const track1 = disc.getTrack(false, 1).pulses2Us.slice();
        const first = disc.snapshotState();
        write(disc, 0, 0x12345678);
        const second = disc.snapshotState();
        expect(second.tracks["false:1"]).toBe(first.tracks["false:1"]);
        write(disc, 1, 0xdeadbeef);

        disc.restoreState(first);
        expect(disc.getTrack(false, 0).pulses2Us[0]).not.toBe(0x12345678);
        disc.restoreState(second);
        expect(disc.getTrack(false, 0).pulses2Us[0]).toBe(0x12345678);
        expect(disc.getTrack(false, 1).pulses2Us).toEqual(track1);
    });

    it("keeps the image it was loaded from, and that image's CRC", () => {
        const image = ssdImage();
        const disc = new Disc(true, new DiscConfig(), "test.ssd");
        disc.setOriginalImage(image);
        expect(disc.originalImageData).toBe(image);
        expect(disc.originalImageCrc32).toBe(crc32(image));
    });
});
