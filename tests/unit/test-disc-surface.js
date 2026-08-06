import { describe, it, expect } from "vitest";

import { Disc, DiscConfig, IbmDiscFormat, loadSsd } from "../../src/disc.js";
import {
    DensityRampHex,
    DiscGeometry,
    MaxDensity,
    MinDensity,
    densityColour,
    pulseDensity,
    renderTracks,
    trackPulseDensity,
} from "../../src/disc-surface.js";

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
});

describe("renderTracks", function () {
    const size = 120;
    const numTracks = 8;

    function render(densities, firstTrack, lastTrack) {
        const geometry = new DiscGeometry(size, numTracks);
        const pixels = new Uint32Array(size * size);
        renderTracks(pixels, geometry, densities, firstTrack, lastTrack);
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
        for (let track = 0; track < numTracks; ++track) renderTracks(perTrack, geometry, densities, track, track);
        expect(perTrack).toEqual(pixels);
    });

    it("repaints one track without disturbing its neighbours", () => {
        const densities = solid();
        const { geometry, pixels } = render(densities, 0, numTracks - 1);
        const before = pixels.slice();

        densities[4] = new Uint8Array(64).fill(MinDensity);
        renderTracks(pixels, geometry, densities, 4, 4);

        expect(pixelAt(geometry, pixels, 4, 0.5)).toBe(densityColour(MinDensity));
        for (const track of [0, 3, 5, 7])
            expect(pixelAt(geometry, pixels, track, 0.5)).toBe(pixelAt(geometry, before, track, 0.5));
    });
});
