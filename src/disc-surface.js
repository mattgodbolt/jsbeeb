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

/** Canvas pixel buffers are little-endian ABGR, as in bbc-palette.js. */
function hexToAbgr(hex) {
    const value = parseInt(hex.slice(1), 16);
    const r = (value >>> 16) & 0xff;
    const g = (value >>> 8) & 0xff;
    const b = value & 0xff;
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const DensityRamp = DensityRampHex.map(hexToAbgr);
const UnformattedColour = hexToAbgr(UnformattedHex);

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

/**
 * @param {number} density flux transitions in a word
 * @returns {number} the ABGR it paints as
 */
export function densityColour(density) {
    if (density === 0) return UnformattedColour;
    return DensityRamp[Math.min(Math.max(density - MinDensity, 0), DensityRamp.length - 1)];
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

/**
 * Paint a range of tracks into a square ABGR pixel buffer. Only pixels whose centres fall in the
 * band those tracks occupy are written, so a single track can be repainted as the machine writes
 * it; edge pixels still sample their neighbours, so the seams stay smooth.
 *
 * @param {Uint32Array} pixels size * size ABGR pixels
 * @param {DiscGeometry} geometry
 * @param {(Uint8Array|null)[]} densities flux transitions per word, indexed by track
 * @param {number} firstTrack
 * @param {number} lastTrack inclusive
 */
export function renderTracks(pixels, geometry, densities, firstTrack, lastTrack) {
    const bandOuter = geometry.outerRadius - firstTrack * geometry.trackPitch;
    const bandInner = geometry.outerRadius - (lastTrack + 1) * geometry.trackPitch;
    const firstRow = Math.max(0, Math.floor(geometry.centre - bandOuter));
    const lastRow = Math.min(geometry.size, Math.ceil(geometry.centre + bandOuter) + 1);
    const samplesPerPixel = Supersample * Supersample;
    for (let y = firstRow; y < lastRow; ++y) {
        // Walking only the row's span of the band keeps a one-track repaint proportional to that
        // track's area rather than to the whole disc's bounding box.
        const dy = y + 0.5 - geometry.centre;
        const halfWidth = Math.sqrt(Math.max(0, bandOuter * bandOuter - dy * dy));
        const low = Math.max(0, Math.floor(geometry.centre - halfWidth));
        const high = Math.min(geometry.size, Math.ceil(geometry.centre + halfWidth) + 1);
        const holeHalfWidth = Math.abs(dy) < bandInner ? Math.sqrt(bandInner * bandInner - dy * dy) : 0;
        const pastHole = Math.ceil(geometry.centre + holeHalfWidth - 0.5);
        for (let x = low; x < high; ++x) {
            const dx = x + 0.5 - geometry.centre;
            if (Math.abs(dx) < holeHalfWidth) {
                x = Math.max(x, pastHole - 1);
                continue;
            }
            const radius = Math.hypot(dx, dy);
            if (radius < bandInner || radius >= bandOuter) continue;
            let covered = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            for (let subY = 0; subY < Supersample; ++subY) {
                const sampleY = y + (subY + 0.5) / Supersample - geometry.centre;
                for (let subX = 0; subX < Supersample; ++subX) {
                    const sampleX = x + (subX + 0.5) / Supersample - geometry.centre;
                    const track = geometry.trackAt(Math.hypot(sampleX, sampleY));
                    const density = track === null ? null : densities[track];
                    if (!density || density.length === 0) continue;
                    const word = Math.min(
                        (geometry.fractionAt(sampleX, sampleY) * density.length) | 0,
                        density.length - 1,
                    );
                    const colour = densityColour(density[word]);
                    red += colour & 0xff;
                    green += (colour >>> 8) & 0xff;
                    blue += (colour >>> 16) & 0xff;
                    covered++;
                }
            }
            const offset = y * geometry.size + x;
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
