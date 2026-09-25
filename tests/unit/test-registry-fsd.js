import { describe, expect, it } from "vitest";
import { IbmDiscFormat } from "../../src/disc.js";
import { declaredLength, fsdSideBytes, FsdError, parseFsd, recoverableLength } from "../../tools/registry/fsd.js";

const Header = [..."FSD"].map((c) => c.charCodeAt(0)).concat([0x10, 0xdc, 0x11, 0x02, 0x00]);
const DataMark = 0xfb;

const filled = (length, value) => new Array(length).fill(value);
const withCrc = (data) => {
    const crc = IbmDiscFormat.crcAddBytes(IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), DataMark), data);
    return [...data, crc >> 8, crc & 0xff];
};

/** An FSD from tracks of {readable, sectors: [{track, sector, sizeCode, realSizeCode, error, data}]}. */
function makeFsd(tracks, title = "TEST") {
    const bytes = [...Header, ...[...title].map((c) => c.charCodeAt(0)), 0, tracks.length - 1];
    tracks.forEach(({ readable = true, sectors }, track) => {
        bytes.push(track, sectors.length);
        if (sectors.length === 0) return;
        bytes.push(readable ? 0xff : 0x00);
        for (const s of sectors) {
            bytes.push(s.track ?? track, 0, s.sector, s.sizeCode ?? 1);
            if (readable) bytes.push(s.realSizeCode ?? 1, s.error ?? FsdError.none, ...s.data);
        }
    });
    return new Uint8Array(bytes);
}

describe("FSD reader", () => {
    it("reads the header, title and each sector", () => {
        const fsd = parseFsd(makeFsd([{ sectors: [{ sector: 0, data: filled(256, 1) }] }], "HOPPER"));
        expect(fsd.title).toBe("HOPPER");
        expect(fsd.date).toBe("2/1/220");
        expect(fsd.tracks).toHaveLength(1);
        expect(fsd.tracks[0].sectors[0]).toMatchObject({ track: 0, sector: 0, sizeCode: 1, error: 0 });
        expect(fsd.tracks[0].sectors[0].data).toHaveLength(256);
    });

    it("keeps IDs but no data for an unreadable track", () => {
        const fsd = parseFsd(makeFsd([{ readable: false, sectors: [{ sector: 0 }, { sector: 1 }] }]));
        expect(fsd.tracks[0].readable).toBe(false);
        expect(fsd.tracks[0].sectors.map((s) => s.data)).toEqual([undefined, undefined]);
    });

    it("rejects a track numbered out of order", () => {
        const bytes = makeFsd([{ sectors: [] }, { sectors: [] }]);
        bytes[bytes.length - 2] = 5;
        expect(() => parseFsd(bytes)).toThrow("FSD track 1 is numbered 5");
    });

    it("stops cleanly when the dump ends on a track boundary", () => {
        const bytes = makeFsd([{ sectors: [] }, { sectors: [] }]);
        const fsd = parseFsd(bytes.subarray(0, bytes.length - 2));
        expect(fsd.truncated).toBe(true);
        expect(fsd.tracks).toHaveLength(1);
    });
});

describe("FSD side bytes", () => {
    it("orders by dumped track, then ID track and sector, keeping the first copy", () => {
        const fsd = parseFsd(
            makeFsd([
                {
                    sectors: [
                        { sector: 1, data: filled(256, 0x11) },
                        { sector: 0, data: filled(256, 0x10) },
                        { sector: 1, data: filled(256, 0x99) },
                    ],
                },
                { sectors: [{ track: 7, sector: 0, data: filled(256, 0x20) }] },
            ]),
        );
        const side = fsdSideBytes(fsd);
        expect([...side.data].filter((_, i) => i % 256 === 0)).toEqual([0x10, 0x11, 0x20]);
        expect(side.dropped.duplicate).toBe(1);
    });

    it("drops sectors with CRC errors and unreadable tracks", () => {
        const fsd = parseFsd(
            makeFsd([
                { sectors: [{ sector: 0, error: FsdError.dataCrc, data: filled(256, 1) }] },
                { readable: false, sectors: [{ sector: 0 }] },
                { sectors: [{ sector: 0, error: FsdError.deleted, data: filled(256, 2) }] },
            ]),
        );
        const side = fsdSideBytes(fsd);
        expect(side.data).toEqual(Buffer.from(filled(256, 2)));
        expect(side.dropped).toMatchObject({ error: 1, unreadable: 1 });
    });

    it("recovers a CRC error sector whose overread carries a good CRC at a shorter length", () => {
        const good = filled(256, 0x42);
        const overread = [...withCrc(good), ...filled(254, 0xff)];
        const sector = { sector: 0, sizeCode: 1, realSizeCode: 2, error: FsdError.dataCrc, data: overread };
        const fsd = parseFsd(makeFsd([{ sectors: [sector] }]));
        expect(recoverableLength(fsd.tracks[0].sectors[0])).toBe(256);
        expect(fsdSideBytes(fsd).data).toEqual(Buffer.from(good));
        expect(fsdSideBytes(fsd, { recoverCrc: false }).data).toHaveLength(0);
    });

    it("can cut an overlong read to the size its ID declares", () => {
        const sector = { sector: 0, sizeCode: 1, realSizeCode: 2, data: filled(512, 3) };
        const fsd = parseFsd(makeFsd([{ sectors: [sector] }]));
        expect(fsdSideBytes(fsd).data).toHaveLength(512);
        expect(fsdSideBytes(fsd, { dataSize: "declared" }).data).toHaveLength(256);
    });
});

describe("declared sector length", () => {
    it.each([
        [0, 128],
        [1, 256],
        [2, 512],
        [3, 1024],
    ])("size code %i declares %i bytes", (sizeCode, length) => {
        expect(declaredLength({ sizeCode })).toBe(length);
    });

    it.each([
        [4, 128],
        [0xfe, 512],
        [0xff, 1024],
    ])("protected size code %i uses only its low two bits, as the 1770 does: %i bytes", (sizeCode, length) => {
        expect(declaredLength({ sizeCode })).toBe(length);
    });
});
