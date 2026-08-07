"use strict";

// Pure geometry and colour mapping for the disc surface visualiser. Kept free of the DOM so it
// can be tested directly; disc-visualiser.js owns the canvases and the panel.

import { IbmDiscFormat } from "./disc.js";

/** Pulse slots in one word of surface data: 32 slots of 2us, so one FM byte or two MFM bytes. */
export const PulsesPerWord = 32;

/**
 * Both FM and MFM put between eight and sixteen flux transitions in a formatted word, so the ramp
 * spans exactly that and gets one step per count. A word with no transitions at all is unformatted.
 */
export const MinDensity = 8;
export const MaxDensity = 16;

/** Sequential blue, dark to light, read against the panel's dark surface. */
export const DensityRampHex = [
    "#1c5cab",
    "#256abf",
    "#2a78d6",
    "#3987e5",
    "#5598e7",
    "#6da7ec",
    "#86b6ef",
    "#9ec5f4",
    "#cde2fb",
];

/** Off the ramp entirely: no flux here at all, so nothing was ever written. */
export const UnformattedHex = "#2a2a28";

/** What a word of a track holds, once the sectors on it have been picked out. */
export const Region = {
    Unformatted: 0,
    Gap: 1,
    Header: 2,
    Data: 3,
    Deleted: 4,
};

/**
 * Gap and unformatted stay recessive neutrals; the three that carry identity are the first three
 * categorical slots, which are the set that clears every colourblindness gate for any pairing.
 * A CRC error is a state rather than an identity, so it is marked over the surface, not filled in.
 */
export const RegionHex = ["#2a2a28", "#3f3f3c", "#d95926", "#3987e5", "#199e70"];
export const RegionNames = ["unformatted", "gap", "header", "data", "deleted data"];

/** Reserved status colour, never used as a fill. */
export const ErrorHex = "#d03b3b";

/** Canvas pixel buffers are little-endian ABGR, as in bbc-palette.js. */
function hexToAbgr(hex) {
    const value = parseInt(hex.slice(1), 16);
    const r = (value >>> 16) & 0xff;
    const g = (value >>> 8) & 0xff;
    const b = value & 0xff;
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const UnformattedColour = hexToAbgr(UnformattedHex);

/** Indexed by pulse count, so the renderer can look a word's colour straight up. */
export const DensityPalette = Uint32Array.from({ length: PulsesPerWord + 1 }, (_, density) => {
    if (density === 0) return UnformattedColour;
    const step = Math.min(Math.max(density - MinDensity, 0), DensityRampHex.length - 1);
    return hexToAbgr(DensityRampHex[step]);
});

/** Indexed by {@link Region}. */
export const RegionPalette = Uint32Array.from(RegionHex, hexToAbgr);

/**
 * @param {number} pulses one word of surface data
 * @returns {number} flux transitions it holds
 */
export function pulseDensity(pulses) {
    let bits = pulses - ((pulses >>> 1) & 0x55555555);
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * @param {Track} track
 * @returns {Uint8Array} flux transitions in each word of the track
 */
export function trackPulseDensity(track) {
    const density = new Uint8Array(track.length);
    for (let word = 0; word < track.length; ++word) density[word] = pulseDensity(track.pulses2Us[word]);
    return density;
}

/** Address mark aside, a sector header is four bytes of identity and two of CRC. */
const HeaderBytes = 6;
/** A data field's CRC, likewise. */
const CrcBytes = 2;
const DefaultSectorBytes = 256;

/** Words a bit range covers, wrapped into a track of `length` words. */
function fillSpan(codes, sectorNumbers, length, startBit, endBit, code, sectorNumber) {
    for (let word = Math.floor(startBit / PulsesPerWord); word < Math.ceil(endBit / PulsesPerWord); ++word) {
        const index = ((word % length) + length) % length;
        codes[index] = code;
        sectorNumbers[index] = sectorNumber;
    }
}

/**
 * Pick the sectors out of a track and say what each word of it holds.
 *
 * @param {Track} track
 * @param {function(string): void} [warn] where to send the decoder's complaints
 * @returns {{codes: Uint8Array, sectorNumbers: Int16Array, errors: {firstWord: number, lastWord: number, kind: string, sectorNumber: number}[]}}
 */
export function trackRegions(track, warn) {
    const codes = new Uint8Array(track.length);
    const sectorNumbers = new Int16Array(track.length).fill(-1);
    const errors = [];
    for (let word = 0; word < track.length; ++word)
        codes[word] = track.pulses2Us[word] === 0 ? Region.Unformatted : Region.Gap;

    for (const sector of track.findSectors(warn)) {
        const pulsesPerByte = sector.isMfm ? PulsesPerWord / 2 : PulsesPerWord;
        const noteError = (kind, startBit, endBit) =>
            errors.push({
                firstWord: Math.floor(startBit / PulsesPerWord) % track.length,
                lastWord: Math.ceil(endBit / PulsesPerWord) % track.length,
                kind,
                sectorNumber: sector.sectorNumber,
            });

        // A region starts at its address mark, which sits one byte before the offset the reader
        // was handed.
        const idStart = sector.idPosBitOffset - pulsesPerByte;
        const idEnd = sector.idPosBitOffset + HeaderBytes * pulsesPerByte;
        fillSpan(codes, sectorNumbers, track.length, idStart, idEnd, Region.Header, sector.sectorNumber);
        if (sector.hasHeaderCrcError) noteError("header CRC", idStart, idEnd);

        if (sector.dataPosBitOffset === null) continue;
        // A failed CRC leaves no confirmed length, so fall back to what the header claimed.
        const sizeCode = sector.header ? Math.min(sector.header[3], 4) : 1;
        const bytes = sector.byteLength ?? (sector.header ? 128 << sizeCode : DefaultSectorBytes);
        const dataStart = sector.dataPosBitOffset - pulsesPerByte;
        const dataEnd = sector.dataPosBitOffset + (bytes + CrcBytes) * pulsesPerByte;
        const code = sector.isDeleted ? Region.Deleted : Region.Data;
        fillSpan(codes, sectorNumbers, track.length, dataStart, dataEnd, code, sector.sectorNumber);
        if (sector.hasDataCrcError) noteError("data CRC", dataStart, dataEnd);
    }
    return { codes, sectorNumbers, errors };
}

const OuterRadiusFraction = 0.97;
const InnerRadiusFraction = 0.36;
const HubRadiusFraction = 0.26;

/** Maps between a square canvas and the surface of a disc drawn on it. */
export class DiscGeometry {
    /**
     * @param {number} size canvas edge in device pixels
     * @param {number} numTracks
     */
    constructor(size, numTracks = IbmDiscFormat.tracksPerDisc) {
        this.size = size;
        this.numTracks = numTracks;
        this.centre = size / 2;
        this.outerRadius = this.centre * OuterRadiusFraction;
        this.innerRadius = this.centre * InnerRadiusFraction;
        this.hubRadius = this.centre * HubRadiusFraction;
        this.trackPitch = (this.outerRadius - this.innerRadius) / numTracks;
    }

    /** Track 0 is the outermost, as on the real thing. */
    trackAt(radius) {
        const track = Math.floor((this.outerRadius - radius) / this.trackPitch);
        return track >= 0 && track < this.numTracks ? track : null;
    }

    radiusOf(track) {
        return this.outerRadius - (track + 0.5) * this.trackPitch;
    }

    /** Index sits at twelve o'clock, with the surface running clockwise from there. */
    angleOf(fraction) {
        return fraction * 2 * Math.PI - Math.PI / 2;
    }

    /**
     * @param {number} dx offset from the centre
     * @param {number} dy offset from the centre
     * @returns {number} how far round from the index, in [0, 1)
     */
    fractionAt(dx, dy) {
        const fraction = (Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI);
        return fraction - Math.floor(fraction);
    }

    pointAt(track, fraction) {
        const angle = this.angleOf(fraction);
        const radius = this.radiusOf(track);
        return { x: this.centre + radius * Math.cos(angle), y: this.centre + radius * Math.sin(angle) };
    }

    /**
     * @returns {{track: number, fraction: number}|null} what the surface holds under a canvas point
     */
    positionAt(x, y) {
        const dx = x - this.centre;
        const dy = y - this.centre;
        const track = this.trackAt(Math.hypot(dx, dy));
        return track === null ? null : { track, fraction: this.fractionAt(dx, dy) };
    }
}

const Supersample = 2;
const InvTwoPi = 1 / (2 * Math.PI);

/**
 * Canvas coordinates are far too small to overflow, so the scaling Math.hypot does to stay safe is
 * all cost and no benefit in here: this is most of the work in a repaint, and it runs 1.7x faster.
 */
function distance(dx, dy) {
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Paint a range of tracks into a square ABGR pixel buffer. Only pixels whose centres fall in the
 * band those tracks occupy are written, so a single track can be repainted as the machine writes
 * it; edge pixels still sample their neighbours, so the seams stay smooth.
 *
 * @param {Uint32Array} pixels size * size ABGR pixels
 * @param {DiscGeometry} geometry
 * @param {(Uint8Array|null)[]} codes one value per word, indexed by track
 * @param {Uint32Array} palette ABGR for each code
 * @param {number} firstTrack
 * @param {number} lastTrack inclusive
 */
export function renderTracks(pixels, geometry, codes, palette, firstTrack, lastTrack) {
    // Hoisted out of the loops: this runs a few million times per repaint, and property loads and
    // method calls on the geometry are a measurable part of it.
    const { size, centre, outerRadius, trackPitch, numTracks } = geometry;
    const bandOuter = outerRadius - firstTrack * trackPitch;
    const bandInner = outerRadius - (lastTrack + 1) * trackPitch;
    const bandOuterSquared = bandOuter * bandOuter;
    const bandInnerSquared = bandInner * bandInner;
    const firstRow = Math.max(0, Math.floor(centre - bandOuter));
    const lastRow = Math.min(size, Math.ceil(centre + bandOuter) + 1);
    const samplesPerPixel = Supersample * Supersample;
    const subStep = 1 / Supersample;
    for (let y = firstRow; y < lastRow; ++y) {
        // Walking only the row's span of the band keeps a one-track repaint proportional to that
        // track's area rather than to the whole disc's bounding box.
        const dy = y + 0.5 - centre;
        const halfWidth = Math.sqrt(Math.max(0, bandOuterSquared - dy * dy));
        const low = Math.max(0, Math.floor(centre - halfWidth));
        const high = Math.min(size, Math.ceil(centre + halfWidth) + 1);
        const holeHalfWidth = Math.abs(dy) < bandInner ? Math.sqrt(bandInnerSquared - dy * dy) : 0;
        const pastHole = Math.ceil(centre + holeHalfWidth - 0.5);
        for (let x = low; x < high; ++x) {
            const dx = x + 0.5 - centre;
            if (Math.abs(dx) < holeHalfWidth) {
                x = Math.max(x, pastHole - 1);
                continue;
            }
            const radiusSquared = dx * dx + dy * dy;
            if (radiusSquared < bandInnerSquared || radiusSquared >= bandOuterSquared) continue;
            let covered = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            for (let subY = 0; subY < Supersample; ++subY) {
                const sampleY = y + (subY + 0.5) * subStep - centre;
                for (let subX = 0; subX < Supersample; ++subX) {
                    const sampleX = x + (subX + 0.5) * subStep - centre;
                    const at = (outerRadius - distance(sampleX, sampleY)) / trackPitch;
                    if (at < 0 || at >= numTracks) continue;
                    const trackCodes = codes[at | 0];
                    if (!trackCodes || trackCodes.length === 0) continue;
                    let fraction = Math.atan2(sampleY, sampleX) * InvTwoPi + 0.25;
                    if (fraction < 0) fraction += 1;
                    const word = Math.min((fraction * trackCodes.length) | 0, trackCodes.length - 1);
                    const colour = palette[trackCodes[word]];
                    red += colour & 0xff;
                    green += (colour >>> 8) & 0xff;
                    blue += (colour >>> 16) & 0xff;
                    covered++;
                }
            }
            const offset = y * size + x;
            if (covered === 0) {
                pixels[offset] = 0;
                continue;
            }
            const alpha = ((255 * covered) / samplesPerPixel) | 0;
            pixels[offset] =
                ((alpha << 24) |
                    (((blue / covered) | 0) << 16) |
                    (((green / covered) | 0) << 8) |
                    ((red / covered) | 0)) >>>
                0;
        }
    }
}
