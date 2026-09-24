// The media registry's disc fingerprint (docs/media-registry-proposal.md), as a
// prototype: sector images are hashed from their bytes, flux images are decoded
// with jsbeeb's own disc code and turned back into the same bytes first.

import { createHash } from "node:crypto";
import { IbmDiscFormat } from "../../src/disc.js";
import { discFor } from "../../src/fdc.js";

export const SectorSize = 256;
const MaxPhysicalTracks = IbmDiscFormat.tracksPerDisc;
// Tracks with data needed before a side can be judged 40-track, as in jsbeeb's own sniffing.
const MinFortyTrackEvidence = 4;
// The last physical track a 40-track drive can reach, with a few to spare.
const FortyTrackDriveLimit = 50;
const KeyBytes = 16;

// How each sector image stores its sides: bytes per track on one side, and
// whether the sides alternate track by track.
const SectorImages = {
    ".ssd": { trackBytes: 10 * SectorSize, interleaved: false },
    ".dsd": { trackBytes: 10 * SectorSize, interleaved: true },
    ".adf": { trackBytes: 16 * SectorSize, interleaved: false },
    ".adm": { trackBytes: 16 * SectorSize, interleaved: false },
    ".adl": { trackBytes: 16 * SectorSize, interleaved: true },
};
const FluxImages = [".hfe"];

export const extensionOf = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
export const isSectorImage = (name) => extensionOf(name) in SectorImages;
export const isFluxImage = (name) => FluxImages.includes(extensionOf(name));
export const isDiscImage = (name) => isSectorImage(name) || isFluxImage(name);

const sha256 = (...parts) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
};
const toKey = (digest) => digest.subarray(0, KeyBytes).toString("hex");

/** The bytes of each side of a sector image, untrimmed. */
export function sectorImageSides(name, bytes) {
    const { trackBytes, interleaved } = SectorImages[extensionOf(name)];
    if (!interleaved) return [bytes];
    const sides = [[], []];
    for (let offset = 0, side = 0; offset < bytes.length; offset += trackBytes, side ^= 1)
        sides[side].push(bytes.subarray(offset, offset + trackBytes));
    return sides.map((parts) => Buffer.concat(parts));
}

function isFill(block) {
    return block.every((byte) => byte === block[0]);
}

/**
 * Pads to whole sectors, then drops trailing sectors that are one repeated byte.
 * @param {Uint8Array} bytes
 * @param {{fillBytes?: number[]|null}} [options] which repeated bytes count as fill; null for any
 * @returns {{data: Buffer, trimmedFill: Map<number, number>}} the trimmed bytes, and how many sectors of each fill byte went
 */
export function trimFill(bytes, { fillBytes = [0x00, 0xe5] } = {}) {
    const padded = Buffer.alloc(Math.ceil(bytes.length / SectorSize) * SectorSize);
    padded.set(bytes);
    let end = padded.length;
    const trimmedFill = new Map();
    while (end > 0) {
        const block = padded.subarray(end - SectorSize, end);
        if (!isFill(block) || (fillBytes && !fillBytes.includes(block[0]))) break;
        trimmedFill.set(block[0], (trimmedFill.get(block[0]) ?? 0) + 1);
        end -= SectorSize;
    }
    return { data: padded.subarray(0, end), trimmedFill };
}

function quietly(fn) {
    const log = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

const sectorIdentity = (sector) =>
    `${Buffer.from(sector.header.subarray(0, 4)).toString("hex")}:${
        sector.sectorData ? createHash("sha256").update(sector.sectorData).digest("hex") : "-"
    }`;

/**
 * Whether a side is a 40-track disc read in an 80-track drive. A capture with nothing past
 * physical track 50 came from a 40-track drive, so every track is real. Otherwise either
 * of two signs will do: the headers on the even tracks give half their number, or the odd
 * tracks hold nothing but ghosts of their even neighbours. Protected discs renumber their
 * tracks, which defeats the first; some discs legitimately repeat a track, which is why
 * the second isn't enough on its own.
 */
function sideIs40Track(disc, upper) {
    const goodSectors = (physical) =>
        physical < 0 || physical >= MaxPhysicalTracks
            ? []
            : disc
                  .getTrack(upper, physical)
                  .findSectors(() => {})
                  .filter((sector) => !sector.hasHeaderCrcError && !sector.hasDataCrcError && sector.sectorData);
    const tracks = Array.from({ length: MaxPhysicalTracks }, (_, physical) => goodSectors(physical));
    const lastWithData = tracks.findLastIndex((sectors) => sectors.length > 0);
    if (lastWithData <= FortyTrackDriveLimit) return false;

    let evenTracks = 0;
    let headersSayHalf = 0;
    let headersSayOwn = 0;
    let oddTracksOfTheirOwn = 0;
    tracks.forEach((sectors, physical) => {
        if (sectors.length === 0) return;
        if (!(physical & 1)) {
            evenTracks++;
            if (physical === 0) return;
            for (const sector of sectors) {
                if (sector.trackNumber === physical / 2) headersSayHalf++;
                else if (sector.trackNumber === physical) headersSayOwn++;
            }
            return;
        }
        const neighbours = new Set(
            [...(tracks[physical - 1] ?? []), ...(tracks[physical + 1] ?? [])].map(sectorIdentity),
        );
        if (sectors.some((sector) => !neighbours.has(sectorIdentity(sector)))) oddTracksOfTheirOwn++;
    });
    if (headersSayHalf > headersSayOwn) return true;
    return evenTracks >= MinFortyTrackEvidence && oddTracksOfTheirOwn * 10 < evenTracks;
}

/**
 * Decodes one side of a flux image back into the bytes a sector image would hold.
 *
 * `trackRule` picks what happens to sectors whose header names a different track
 * from the one they were read on: "strict" drops them (the first draft of the
 * proposal), "physical" keeps them and orders sectors by where they were found,
 * which is what protected discs with renumbered tracks need.
 * @param {{trackRule?: "strict"|"physical"}} [options]
 * @returns {{data: Buffer, is40Track: boolean, dropped: {crc: number, wrongTrack: number, duplicate: number}, sizes: Map<number, number>}}
 */
export function fluxSideBytes(disc, upper, { trackRule = "physical" } = {}) {
    const is40Track = sideIs40Track(disc, upper);
    const dropped = { crc: 0, wrongTrack: 0, duplicate: 0 };
    const sizes = new Map();
    const kept = new Map();
    const step = is40Track ? 2 : 1;
    for (let physical = 0; physical < MaxPhysicalTracks; physical += step) {
        const logical = physical / step;
        for (const sector of disc.getTrack(upper, physical).findSectors(() => {})) {
            if (sector.hasHeaderCrcError || sector.hasDataCrcError || !sector.sectorData) {
                dropped.crc++;
                continue;
            }
            if (sector.trackNumber !== logical) {
                dropped.wrongTrack++;
                if (trackRule === "strict") continue;
            }
            const id = (logical << 16) | (sector.trackNumber << 8) | sector.sectorNumber;
            if (kept.has(id)) {
                dropped.duplicate++;
                continue;
            }
            kept.set(id, sector.sectorData);
            sizes.set(sector.sectorData.length, (sizes.get(sector.sectorData.length) ?? 0) + 1);
        }
    }
    const ordered = [...kept.entries()].sort(([a], [b]) => a - b).map(([, data]) => data);
    return { data: Buffer.concat(ordered), is40Track, dropped, sizes };
}

export function loadFlux(name, bytes) {
    return quietly(() => discFor(name, new Uint8Array(bytes)));
}

/**
 * The untrimmed bytes of every side of an image, whichever kind it is.
 * @returns {{sides: Buffer[], flux?: object[]}}
 */
export function imageSides(name, bytes, options) {
    if (isSectorImage(name)) return { sides: sectorImageSides(name, bytes) };
    const disc = loadFlux(name, bytes);
    const flux = [false, true]
        .filter((upper) => !upper || disc.isDoubleSided)
        .map((upper) => fluxSideBytes(disc, upper, options));
    return { sides: flux.map((side) => side.data), flux };
}

/**
 * Every key the registry would compute for an image, and the untrimmed sides they came from.
 * @param {{fillBytes?: number[]|null, trackRule?: "strict"|"physical"}} [options] for trimFill and fluxSideBytes
 */
export function fingerprint(name, bytes, options) {
    const { sides, flux } = imageSides(name, bytes, options);
    const trimmed = sides.map((side) => trimFill(side, options));
    const sideDigests = trimmed.map(({ data }) => sha256(data));
    let lastNonEmpty = trimmed.length - 1;
    while (lastNonEmpty > 0 && trimmed[lastNonEmpty].data.length === 0) lastNonEmpty--;
    const discKey = toKey(sha256(...sideDigests.slice(0, lastNonEmpty + 1)));
    return {
        fileKey: toKey(sha256(bytes)),
        discKey,
        sideKeys: sideDigests.map(toKey),
        sides,
        sideLengths: trimmed.map(({ data }) => data.length),
        trimmedFill: trimmed.map(({ trimmedFill }) => trimmedFill),
        flux,
    };
}
