import { Disc, DiscConfig } from "../../src/disc.js";
import { IbmDiscFormat } from "../../src/disc-format.js";

export const SectorLengthCode = 1;
export const SectorBytes = 256;
export const MfmSectorGap = 22;

export function blankDisc() {
    return new Disc(true, new DiscConfig(), "test.ssd");
}

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
        .resetCrc()
        .appendFmDataAndClocks(idMark, IbmDiscFormat.markClockPattern)
        .appendFmByte(track)
        .appendFmByte(0)
        .appendFmByte(sector)
        .appendFmByte(SectorLengthCode)
        .appendCrc()
        .appendRepeatFmByte(0xff, IbmDiscFormat.stdGap2FFs)
        .appendRepeatFmByte(0x00, IbmDiscFormat.stdSync00s)
        .resetCrc()
        .appendFmDataAndClocks(dataMark, IbmDiscFormat.markClockPattern)
        .appendFmChunk(data)
        .appendCrc();
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
        .appendRepeatMfmByte(0x00, 12)
        .resetCrc()
        .appendMfm3xA1Sync()
        .appendMfmByte(idMark)
        .appendMfmByte(0)
        .appendMfmByte(0)
        .appendMfmByte(sector)
        .appendMfmByte(lengthCode)
        .appendCrc()
        .appendRepeatMfmByte(0x4e, MfmSectorGap)
        .appendRepeatMfmByte(0x00, 12)
        .resetCrc()
        .appendMfm3xA1Sync()
        .appendMfmByte(dataMark)
        .appendMfmChunk(data)
        .appendCrc();
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
