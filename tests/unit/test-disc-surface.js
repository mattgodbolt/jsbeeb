import { afterEach, describe, it, expect, vi } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadAdf, loadSsd } from "../../src/disc.js";
import {
    DensityPalette,
    DensityRampHex,
    DiscGeometry,
    MaxDensity,
    MaxZoom,
    MinDensity,
    Region,
    pulseDensity,
    renderTracks,
    trackPulseDensity,
    trackRegions,
} from "../../src/disc-surface.js";

const densityColour = (density) => DensityPalette[density];

afterEach(() => vi.restoreAllMocks());

/** An ADF's worth of surface: MFM, where a word holds two bytes rather than one. */
function adfDisc() {
    const disc = new Disc(true, new DiscConfig(), "test.adf");
    loadAdf(disc, new Uint8Array(16 * 256 * 80), false);
    return disc;
}

/** An SSD's worth of surface, so the tests see real FM pulse data. */
function ssdDisc() {
    const disc = new Disc(true, new DiscConfig(), "test.ssd");
    loadSsd(disc, new Uint8Array(IbmDiscFormat.bytesPerTrack), false, null);
    return disc;
}

describe("pulseDensity", function () {
    it("counts the flux transitions in a word", () => {
        expect(pulseDensity(0)).toBe(0);
        expect(pulseDensity(0xffffffff)).toBe(32);
        expect(pulseDensity(0x80000001)).toBe(2);
    });

    it("counts an FM gap byte and an FM sync byte", () => {
        // Every FM byte carries eight clock pulses; the data bits add up to eight more.
        expect(pulseDensity(IbmDiscFormat.fmTo2usPulses(0xff, 0xff))).toBe(MaxDensity);
        expect(pulseDensity(IbmDiscFormat.fmTo2usPulses(0xff, 0x00))).toBe(MinDensity);
    });
});

describe("trackPulseDensity", function () {
    it("covers exactly the words the track uses", () => {
        const track = ssdDisc().getTrack(false, 0);
        expect(trackPulseDensity(track)).toHaveLength(track.length);
    });

    it("stays inside the ramp's range for a formatted track", () => {
        const density = trackPulseDensity(ssdDisc().getTrack(false, 0));
        expect(Math.min(...density)).toBeGreaterThanOrEqual(MinDensity);
        expect(Math.max(...density)).toBeLessThanOrEqual(MaxDensity);
    });

    it("reads zero across a track that was never formatted", () => {
        const density = trackPulseDensity(Disc.createBlank().getTrack(false, 0));
        expect(Math.max(...density)).toBe(0);
    });
});

describe("densityColour", function () {
    it("keeps unformatted surface off the ramp", () => {
        const ramp = new Set();
        for (let density = MinDensity; density <= MaxDensity; ++density) ramp.add(densityColour(density));
        expect(ramp.size).toBe(DensityRampHex.length);
        expect(ramp.has(densityColour(0))).toBe(false);
    });

    it("gives each pulse count in range its own step", () => {
        for (let density = MinDensity; density < MaxDensity; ++density)
            expect(densityColour(density)).not.toBe(densityColour(density + 1));
    });

    it("clamps counts outside the ramp's range", () => {
        expect(densityColour(1)).toBe(densityColour(MinDensity));
        expect(densityColour(32)).toBe(densityColour(MaxDensity));
    });
});

describe("DiscGeometry", function () {
    const geometry = new DiscGeometry(400, 80);

    it("puts track 0 outermost", () => {
        expect(geometry.radiusOf(0)).toBeGreaterThan(geometry.radiusOf(79));
        expect(geometry.trackAt(geometry.outerRadius - 0.5)).toBe(0);
        expect(geometry.trackAt(geometry.innerRadius + 0.5)).toBe(79);
    });

    it("has no track off either edge of the surface", () => {
        expect(geometry.trackAt(geometry.outerRadius + 1)).toBeNull();
        expect(geometry.trackAt(geometry.innerRadius - 1)).toBeNull();
    });

    it("finds the same track back from its own radius", () => {
        for (let track = 0; track < 80; ++track) expect(geometry.trackAt(geometry.radiusOf(track))).toBe(track);
    });

    it("starts the surface at twelve o'clock and runs it clockwise", () => {
        expect(geometry.fractionAt(0, -1)).toBeCloseTo(0);
        expect(geometry.fractionAt(1, 0)).toBeCloseTo(0.25);
        expect(geometry.fractionAt(0, 1)).toBeCloseTo(0.5);
        expect(geometry.fractionAt(-1, 0)).toBeCloseTo(0.75);
    });

    it("reads back the position it drew a point at", () => {
        const { x, y } = geometry.pointAt(17, 0.3);
        const position = geometry.positionAt(x, y);
        expect(position.track).toBe(17);
        expect(position.fraction).toBeCloseTo(0.3);
    });

    it("has nothing under a point off the surface", () => {
        expect(geometry.positionAt(0, 0)).toBeNull();
        expect(geometry.positionAt(geometry.centre, geometry.centre)).toBeNull();
    });

    describe("zoomed and panned", function () {
        it("still reads back the position it drew a point at", () => {
            const zoomed = new DiscGeometry(400, 80).setView(4, 130, 90);
            const { x, y } = zoomed.pointAt(17, 0.3);
            const position = zoomed.positionAt(x, y);
            expect(position.track).toBe(17);
            expect(position.fraction).toBeCloseTo(0.3);
        });

        it("magnifies about the canvas, leaving the disc's own dimensions alone", () => {
            const zoomed = new DiscGeometry(400, 80).setView(4, 0, 0);
            expect(zoomed.radiusOf(10)).toBe(geometry.radiusOf(10));
            expect(zoomed.screenRadiusOf(10)).toBeCloseTo(geometry.radiusOf(10) * 4);
        });

        it("keeps the window on the platter", () => {
            const zoomed = new DiscGeometry(400, 80).setView(2, -500, 9999);
            expect(zoomed.originX).toBe(0);
            expect(zoomed.originY).toBe(200);
        });

        it("refuses to zoom out past the whole disc, or in past the limit", () => {
            expect(new DiscGeometry(400, 80).setView(0.1, 0, 0).zoom).toBe(1);
            expect(new DiscGeometry(400, 80).setView(1e6, 0, 0).zoom).toBe(MaxZoom);
        });

        it("paints each pixel with the track the geometry puts under it", () => {
            const size = 120;
            const zoomed = new DiscGeometry(size, 8).setView(3, 20, 15);
            const codes = Array.from({ length: 8 }, (_, track) => new Uint8Array(64).fill(MinDensity + track));
            const pixels = new Uint32Array(size * size);
            renderTracks(pixels, zoomed, codes, DensityPalette, 0, 7);

            let checked = 0;
            for (let y = 0; y < size; y += 3) {
                for (let x = 0; x < size; x += 3) {
                    const at = zoomed.positionAt(x + 0.5, y + 0.5);
                    const pixel = pixels[y * size + x];
                    if (at === null) {
                        expect(pixel).toBe(0);
                        continue;
                    }
                    const disc = zoomed.toDisc(x + 0.5, y + 0.5);
                    const radius = Math.hypot(disc.x - zoomed.centre, disc.y - zoomed.centre);
                    // Pixels straddling a track boundary are a blend of both, so only assert on the
                    // middle half of each track.
                    const acrossTrack = ((zoomed.outerRadius - radius) / zoomed.trackPitch) % 1;
                    if (acrossTrack < 0.25 || acrossTrack > 0.75) continue;
                    expect(pixel).toBe(DensityPalette[MinDensity + at.track]);
                    checked++;
                }
            }
            expect(checked).toBeGreaterThan(100);
        });
    });
});

describe("trackRegions", function () {
    /** @returns {Set<number>} the words a region code covers */
    function wordsWith(codes, code) {
        const words = new Set();
        codes.forEach((value, word) => value === code && words.add(word));
        return words;
    }

    it("finds a header and a data field for every sector of a formatted track", () => {
        const { codes, sectorNumbers, errors } = trackRegions(ssdDisc().getTrack(false, 0), () => {});
        expect(errors).toHaveLength(0);
        expect(new Set([...sectorNumbers].filter((n) => n >= 0))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
        expect(wordsWith(codes, Region.Header).size).toBeGreaterThan(0);
        expect(wordsWith(codes, Region.Data).size).toBeGreaterThan(0);
        expect(wordsWith(codes, Region.Gap).size).toBeGreaterThan(0);
        expect(wordsWith(codes, Region.Unformatted).size).toBe(0);
    });

    it("puts each sector's header before its data", () => {
        const { codes, sectorNumbers } = trackRegions(ssdDisc().getTrack(false, 0), () => {});
        for (let sector = 0; sector < 10; ++sector) {
            const headers = [];
            const data = [];
            codes.forEach((code, word) => {
                if (sectorNumbers[word] !== sector) return;
                if (code === Region.Header) headers.push(word);
                if (code === Region.Data) data.push(word);
            });
            expect(Math.max(...headers)).toBeLessThan(Math.min(...data));
        }
    });

    it("calls a track that was never formatted exactly that", () => {
        const { codes, errors } = trackRegions(Disc.createBlank().getTrack(false, 0), () => {});
        expect(errors).toHaveLength(0);
        expect(wordsWith(codes, Region.Unformatted).size).toBe(codes.length);
    });

    it("reports a CRC error over the sector it belongs to, without touching the fills", () => {
        const disc = ssdDisc();
        const track = disc.getTrack(false, 0);
        const { codes, sectorNumbers } = trackRegions(track, () => {});
        const payload = [];
        codes.forEach((code, word) => code === Region.Data && sectorNumbers[word] === 4 && payload.push(word));
        // Not the first word: that is the address mark, and losing it costs the sector its data
        // field rather than failing its CRC.
        const damaged = payload[payload.length >> 1];
        track.pulses2Us[damaged] ^= 0xf;

        const after = trackRegions(track, () => {});
        expect(after.errors).toHaveLength(1);
        expect(after.errors[0]).toMatchObject({ kind: "data CRC", sectorNumber: 4 });
        expect(damaged).toBeGreaterThanOrEqual(after.errors[0].firstWord);
        expect(damaged).toBeLessThan(after.errors[0].lastWord);
        expect(after.codes[damaged]).toBe(Region.Data);
    });

    it("finds MFM sectors, whose bytes are half a word each", () => {
        const { codes, sectorNumbers, errors } = trackRegions(adfDisc().getTrack(false, 0), () => {});
        expect(errors).toHaveLength(0);
        // An ADF track holds 16 sectors, against an SSD's 10.
        expect(new Set([...sectorNumbers].filter((n) => n >= 0)).size).toBe(16);
        expect(wordsWith(codes, Region.Header).size).toBeGreaterThan(0);
        expect(wordsWith(codes, Region.Data).size).toBeGreaterThan(0);
    });

    it("marks a header whose own CRC fails", () => {
        const disc = ssdDisc();
        const track = disc.getTrack(false, 0);
        const { codes, sectorNumbers } = trackRegions(track, () => {});
        const header = [];
        codes.forEach((code, word) => code === Region.Header && sectorNumbers[word] === 6 && header.push(word));
        // The second word in: the first is the address mark, and losing that loses the sector.
        track.pulses2Us[header[1]] ^= 0xf;

        const after = trackRegions(track, () => {});
        expect(after.errors.map((e) => e.kind)).toContain("header CRC");
    });

    it("tells a deleted data field from a live one", () => {
        const disc = ssdDisc();
        const track = disc.getTrack(false, 0);
        const { codes, sectorNumbers } = trackRegions(track, () => {});
        const mark = codes.findIndex((code, word) => code === Region.Data && sectorNumbers[word] === 2);
        track.pulses2Us[mark] = IbmDiscFormat.fmTo2usPulses(
            IbmDiscFormat.markClockPattern,
            IbmDiscFormat.deletedDataMarkDataPattern,
        );

        const after = trackRegions(track, () => {});
        const deleted = [...after.codes].filter((code) => code === Region.Deleted);
        expect(deleted.length).toBeGreaterThan(0);
        expect(wordsWith(after.codes, Region.Data).size).toBeGreaterThan(0);
    });

    it("sends the decoder's complaints to the caller instead of the console", () => {
        const disc = ssdDisc();
        const track = disc.getTrack(false, 0);
        const { codes, sectorNumbers } = trackRegions(track, () => {});
        // Erase a whole data field, so its header is left pointing at nothing.
        codes.forEach((code, word) => {
            if (code === Region.Data && sectorNumbers[word] === 4)
                track.pulses2Us[word] = IbmDiscFormat.fmTo2usPulses(0xff, 0xff);
        });

        const console = vi.spyOn(globalThis.console, "log");
        const warnings = [];
        trackRegions(track, (message) => warnings.push(message));

        expect(warnings.length).toBeGreaterThan(0);
        expect(console).not.toHaveBeenCalled();
    });
});

describe("renderTracks", function () {
    const size = 120;
    const numTracks = 8;

    function render(densities, firstTrack, lastTrack) {
        const geometry = new DiscGeometry(size, numTracks);
        const pixels = new Uint32Array(size * size);
        renderTracks(pixels, geometry, densities, DensityPalette, firstTrack, lastTrack);
        return { geometry, pixels };
    }

    function pixelAt(geometry, pixels, track, fraction) {
        const { x, y } = geometry.pointAt(track, fraction);
        return pixels[Math.round(y) * size + Math.round(x)];
    }

    const solid = () => Array.from({ length: numTracks }, () => new Uint8Array(64).fill(MaxDensity));

    it("paints the surface and leaves the hub and the rim clear", () => {
        const { geometry, pixels } = render(solid(), 0, numTracks - 1);
        expect(pixelAt(geometry, pixels, 0, 0.5) >>> 24).toBe(0xff);
        expect(pixels[Math.round(geometry.centre) * size + Math.round(geometry.centre)]).toBe(0);
        expect(pixels[0]).toBe(0);
    });

    it("colours each word by its own pulse count", () => {
        const densities = solid();
        densities[3] = new Uint8Array(64).fill(MinDensity);
        densities[3][10] = 0;
        const { geometry, pixels } = render(densities, 0, numTracks - 1);
        expect(pixelAt(geometry, pixels, 3, 0.5)).toBe(densityColour(MinDensity));
        expect(pixelAt(geometry, pixels, 3, 10.5 / 64)).toBe(densityColour(0));
        expect(pixelAt(geometry, pixels, 4, 0.5)).toBe(densityColour(MaxDensity));
    });

    it("paints the same surface a track at a time as it does all at once", () => {
        const densities = solid();
        for (let track = 0; track < numTracks; ++track) densities[track].fill(MinDensity + track);
        const { geometry, pixels } = render(densities, 0, numTracks - 1);
        const perTrack = new Uint32Array(size * size);
        for (let track = 0; track < numTracks; ++track)
            renderTracks(perTrack, geometry, densities, DensityPalette, track, track);
        expect(perTrack).toEqual(pixels);
    });

    it("leaves a track alone when its neighbour has not been read yet", () => {
        const densities = solid();
        const { geometry, pixels } = render(densities, 0, numTracks - 1);
        const before = pixels.slice();

        // The surface fills in a track at a time, so a neighbour is briefly absent.
        densities[5] = null;
        renderTracks(pixels, geometry, densities, DensityPalette, 4, 4);

        expect(pixelAt(geometry, pixels, 5, 0.5)).toBe(pixelAt(geometry, before, 5, 0.5));
        expect(pixelAt(geometry, pixels, 4, 0.5)).toBe(densityColour(MaxDensity));
    });

    it("repaints one track without disturbing its neighbours", () => {
        const densities = solid();
        const { geometry, pixels } = render(densities, 0, numTracks - 1);
        const before = pixels.slice();

        densities[4] = new Uint8Array(64).fill(MinDensity);
        renderTracks(pixels, geometry, densities, DensityPalette, 4, 4);

        expect(pixelAt(geometry, pixels, 4, 0.5)).toBe(densityColour(MinDensity));
        for (const track of [0, 3, 5, 7])
            expect(pixelAt(geometry, pixels, track, 0.5)).toBe(pixelAt(geometry, before, track, 0.5));
    });
});
