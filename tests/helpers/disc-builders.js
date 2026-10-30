import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { IbmDiscFormat } from "../../src/disc-format.js";

export const SectorLengthCode = 1;
export const SectorBytes = 256;
export const MfmSectorGap = 22;

export function blankDisc() {
    return new Disc(true, new DiscConfig(), "test.ssd");
}

/** `data` loaded as an SSD, or as a DSD with `isDsd`, its 40 tracks spread across 80 with `expandTo80`. */
export function ssdDisc(data, { expandTo80 = false, isDsd = false, onChange = null } = {}) {
    const config = new DiscConfig();
    config.expandTo80 = expandTo80;
    return loadSsd(new Disc(true, config, "test.ssd"), data, isDsd, onChange);
}

/** Cycles in `n` milliseconds at the BBC's 2MHz. */
export const ms = (n) => n * 2000;

export function sectorData() {
    return new Uint8Array(SectorBytes).map((_, i) => i & 0xff);
}

export function appendFmSector(
    builder,
    {
        idMark = IbmDiscFormat.idMarkDataPattern,
        dataMark = IbmDiscFormat.dataMarkDataPattern,
        track = 0,
        sector = 0,
        data = sectorData(),
    } = {},
) {
    return builder
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap1FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .appendFmSector({ idMark, dataMark, track, head: 0, sector, lengthCode: SectorLengthCode, data });
}

export function appendMfmSector(
    builder,
    {
        idMark = IbmDiscFormat.idMarkDataPattern,
        dataMark = IbmDiscFormat.dataMarkDataPattern,
        sector = 0,
        lengthCode = SectorLengthCode,
        data = sectorData(),
    } = {},
) {
    return builder
        .appendRepeatMfmByte(0x4e, MfmSectorGap)
        .appendMfmSector({ idMark, dataMark, track: 0, head: 0, sector, lengthCode, data });
}

/** A disc whose track 0 holds the one sector `options` describe and nothing else. */
export function fmDiscWithSector(options) {
    const disc = blankDisc();
    appendFmSector(disc.buildTrack(false, 0), options).fillFmByte(0xff);
    return disc;
}

export function mfmDiscWithSector(options) {
    const disc = blankDisc();
    appendMfmSector(disc.buildTrack(false, 0).appendRepeatMfmByte(0x4e, 60), options).fillMfmByte(0x4e);
    return disc;
}

/** Changes a byte in a sector's data on a track, so its data CRC no longer matches. */
export function corruptSectorData(track, sectorNumber) {
    // Past the address mark, so the sector is still found.
    const dataWord = Math.floor(track.findSectors()[sectorNumber].dataPosBitOffset / 32) + 2;
    track.pulses2Us[dataWord] = IbmDiscFormat.fmTo2usPulses(0xff, 0x55);
}
