// Reads FSD sector dumps, and computes the registry fingerprint's side bytes straight from
// one, without going through a flux image. The format has no specification; this follows
// beebjit's disc_fsd.c and the BBC BASIC tools (dFSD, FSDreportV2) that sit next to the
// dumps. After "FSD", five bytes of date, creator and release, then a NUL-terminated
// title, then the highest track number. Each track is its number and a sector count, and
// if that is non-zero a readable flag (&FF, or 0 when only the IDs could be read); each
// sector is its ID (track, head, sector, size code) and, on a readable track, the size
// code of what was actually read, an error code, and that many bytes.

import { IbmDiscFormat } from "../../src/disc.js";

export const FsdError = {
    none: 0x00,
    sectorNotFound: 0x18,
    deleted: 0x20,
    dataCrc: 0x0e,
    deletedDataCrc: 0x2e,
};

// &E0 to &E2: a data CRC error at the declared size, with an overread of 128 << (code & 3)
// bytes kept. beebjit treats all of these as CRC errors.
const isOverreadCrcError = (error) => error >= 0xe0 && error <= 0xe2;

/** Whether the dump records this sector's data as read with a good CRC. */
export function fsdSectorIsGood(sector) {
    if (!sector.data) return false;
    const { error } = sector;
    return error === FsdError.none || error === FsdError.deleted || error === FsdError.sectorNotFound;
}

export function describeFsdError(error) {
    if (error === undefined) return "unreadable track";
    if (isOverreadCrcError(error)) return `data CRC error, overread (&${error.toString(16)})`;
    return (
        {
            [FsdError.none]: "ok",
            [FsdError.sectorNotFound]: "sector not found (&18)",
            [FsdError.deleted]: "deleted data",
            [FsdError.dataCrc]: "data CRC error (&0E)",
            [FsdError.deletedDataCrc]: "deleted data with CRC error (&2E)",
        }[error] ?? `unknown error &${error.toString(16)}`
    );
}

const FormatByte = 0xe5;
const DeletedDataMark = 0xf8;
const DataMark = 0xfb;
const isDeleted = (error) => (error & FsdError.deleted) !== 0 && !isOverreadCrcError(error);

/**
 * The longest power-of-two prefix, shorter than what the dump holds, whose data CRC sits in
 * the bytes the dump read past it: what a flux decoder finds when the full-length read fails.
 */
export function recoverableLength(sector) {
    const mark = isDeleted(sector.error) ? DeletedDataMark : DataMark;
    for (let size = sector.data.length >> 1; size >= 128; size >>= 1) {
        const crc = IbmDiscFormat.crcAddBytes(
            IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), mark),
            sector.data.subarray(0, size),
        );
        if (((sector.data[size] << 8) | sector.data[size + 1]) === crc) return size;
    }
    return null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{date: string, creator: number, release: number, title: string, tracks: {track: number,
 *     readable: boolean, sectors: {track: number, head: number, sector: number, sizeCode: number,
 *     realSizeCode?: number, error?: number, data?: Uint8Array}[]}[], truncated: boolean}}
 */
export function parseFsd(bytes) {
    let pos = 0;
    const need = (count, what) => {
        if (pos + count > bytes.length) throw new Error(`FSD ends inside ${what} at offset ${pos}`);
    };
    const byte = (what) => {
        need(1, what);
        return bytes[pos++];
    };
    if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "FSD")
        throw new Error("Not an FSD file: no FSD signature");
    const [b1, b2, b3, b4, b5] = bytes.subarray(3, 8);
    pos = 8;
    const date = `${b1 >> 3}/${b3 & 0x0f}/${(b1 & 7) * 256 + b2}`;
    const creator = b3 >> 4;
    const release = ((b5 & 0xc0) >> 6) * 256 + b4;
    let title = "";
    for (let c = byte("title"); c !== 0; c = byte("title")) title += String.fromCharCode(c);
    const maxTrack = byte("track count");
    const tracks = [];
    let truncated = false;
    for (let expected = 0; expected <= maxTrack; ++expected) {
        // Some dumps end cleanly on a track boundary; beebjit leaves the rest unformatted.
        if (pos === bytes.length) {
            truncated = true;
            break;
        }
        const track = byte("track header");
        if (track !== expected) throw new Error(`FSD track ${expected} is numbered ${track}`);
        const count = byte("track header");
        if (count === 0) {
            tracks.push({ track, readable: false, sectors: [] });
            continue;
        }
        const flag = byte("readable flag");
        if (flag !== 0 && flag !== 0xff) throw new Error(`FSD track ${track} has readable flag &${flag.toString(16)}`);
        const readable = flag === 0xff;
        const sectors = [];
        for (let i = 0; i < count; ++i) {
            need(4, "sector ID");
            const [idTrack, head, sector, sizeCode] = bytes.subarray(pos, pos + 4);
            pos += 4;
            const entry = { track: idTrack, head, sector, sizeCode };
            if (readable) {
                entry.realSizeCode = byte("sector size");
                entry.error = byte("sector error");
                if (entry.realSizeCode > 4)
                    throw new Error(`FSD track ${track} sector size code ${entry.realSizeCode}`);
                const length = 128 << entry.realSizeCode;
                need(length, "sector data");
                entry.data = bytes.subarray(pos, pos + length);
                pos += length;
            }
            sectors.push(entry);
        }
        tracks.push({ track, readable, sectors });
    }
    return { date, creator, release, title, tracks, truncated, trailing: bytes.length - pos };
}

/**
 * The bytes the fingerprint would take from an FSD's one side: every sector the dump read
 * with a good CRC, ordered by the track it was dumped from, then the track and sector its
 * ID names, first copy kept. `dataSize` picks how much of each sector: "real" (all the
 * bytes the dump holds, which is what a flux image rebuilt from it decodes to) or
 * "declared" (the size its ID gives). With `recoverCrc`, a sector the dump marks as a CRC
 * error still counts when a shorter read of it carries a good CRC in the overread bytes.
 * @param {ReturnType<typeof parseFsd>} fsd
 * `unreadable` picks what a track the dump could only read IDs from contributes: nothing
 * ("drop"), or format bytes (&E5) for each ID, either at the size the ID declares
 * ("fill-declared") or at beebjit's guess of 256 bytes, or 128 on tracks of more than ten
 * sectors ("fill-beebjit").
 * @param {{dataSize?: "real"|"declared", recoverCrc?: boolean,
 *     unreadable?: "drop"|"fill-declared"|"fill-beebjit"}} [options]
 */
export function fsdSideBytes(fsd, { dataSize = "real", recoverCrc = true, unreadable = "drop" } = {}) {
    const kept = new Map();
    const dropped = { error: 0, unreadable: 0, duplicate: 0, recovered: 0 };
    for (const { track: logical, sectors } of fsd.tracks) {
        for (const sector of sectors) {
            let data = sector.data;
            if (!data) {
                if (unreadable === "drop") {
                    dropped.unreadable++;
                    continue;
                }
                const length =
                    unreadable === "fill-declared" ? 128 << (sector.sizeCode & 3) : sectors.length > 10 ? 128 : 256;
                data = new Uint8Array(length).fill(FormatByte);
                const id = (logical << 16) | (sector.track << 8) | sector.sector;
                if (!kept.has(id)) kept.set(id, { logical, sector, data });
                continue;
            }
            if (!fsdSectorIsGood(sector)) {
                const length = recoverCrc ? recoverableLength(sector) : null;
                if (length === null) {
                    dropped.error++;
                    continue;
                }
                dropped.recovered++;
                data = data.subarray(0, length);
            }
            const id = (logical << 16) | (sector.track << 8) | sector.sector;
            if (kept.has(id)) {
                dropped.duplicate++;
                continue;
            }
            const declared = 128 << (sector.sizeCode & 7);
            if (dataSize === "declared" && declared < data.length) data = data.subarray(0, declared);
            kept.set(id, { logical, sector, data });
        }
    }
    const ordered = [...kept.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
    return { data: Buffer.concat(ordered.map(({ data }) => data)), sectors: ordered, dropped };
}
