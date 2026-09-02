import { afterEach, describe, it, expect, vi } from "vitest";

import {
    BitWindow64,
    Disc,
    DiscConfig,
    IbmDiscFormat,
    loadSsd,
    loadAdf,
    sniffDfsLayout,
    toSsdOrDsd,
} from "../../src/disc.js";
import * as fs from "node:fs";
import { ssdImage } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

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
        // TODO(#1061) either fix these or understand why beebjit doesn't use same bit posn for bits.
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
            expect(sectors[0].trackNumber).toBe(logical);
            expect([...sectors[0].sectorData.slice(0, 2)]).toEqual([logical, 0]);
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
        vi.spyOn(globalThis.console, "log").mockImplementation(() => {});
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
        const before = disc.snapshotState().tracks;

        disc.eraseTrack(false, 1);

        // Without this the track comes back at the next rewind.
        expect(disc.snapshotState().tracks["false:1"]).not.toBe(before["false:1"]);
    });
});

describe("sector decoding warnings", () => {
    it("goes to the caller rather than the console", () => {
        const disc = unobservedDisc();
        const track = disc.getTrack(false, 0);
        eraseDataField(track, 4);

        const console = vi.spyOn(globalThis.console, "log");
        const warnings = [];
        track.findSectors((message) => warnings.push(message));

        expect(warnings.length).toBeGreaterThan(0);
        expect(console).not.toHaveBeenCalled();
    });

    it("goes to the console when no caller asks for it", () => {
        const disc = unobservedDisc();
        const track = disc.getTrack(false, 0);
        eraseDataField(track, 4);

        const console = vi.spyOn(globalThis.console, "log").mockImplementation(() => {});
        track.findSectors();

        expect(console).toHaveBeenCalled();
    });
});
