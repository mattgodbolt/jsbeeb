import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeTape, pulsesToRuns, tapeBlocks, tapeCrc, tapeKey, tapeRuns } from "../../tools/registry/tape.js";

const MaxBlockLength = 256;
const LastBlock = 0x80;
const Locked = 0x01;
const CswRate = 44100;

const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];

function block({ name, load = 0xffff1900, exec = 0xffff8023, number, flags = 0, data, badDataCrc = false }) {
    const header = [...name].map((c) => c.charCodeAt(0));
    header.push(0, ...le32(load), ...le32(exec), ...le16(number), ...le16(data.length), flags, 0, 0, 0, 0);
    const bytes = [0x2a, ...header, ...be16(tapeCrc(Uint8Array.from(header)))];
    if (data.length) bytes.push(...data, ...be16(tapeCrc(Uint8Array.from(data)) ^ (badDataCrc ? 1 : 0)));
    return bytes;
}

function fileBlocks(name, data, { load, exec, flags = 0 } = {}) {
    const blocks = [];
    for (let number = 0, pos = 0; number === 0 || pos < data.length; ++number, pos += MaxBlockLength) {
        const chunk = data.slice(pos, pos + MaxBlockLength);
        const last = pos + MaxBlockLength >= data.length;
        blocks.push(block({ name, load, exec, number, flags: flags | (last ? LastBlock : 0), data: chunk }));
    }
    return blocks;
}

const content = (length, seed) => Array.from({ length }, (_, i) => (i * 13 + seed * 101 + (i >> 8)) & 0xff);

function uef(chunks) {
    const out = [..."UEF File!"].map((c) => c.charCodeAt(0));
    out.push(0, 10, 0);
    for (const [id, body] of chunks) out.push(...le16(id), ...le32(body.length), ...body);
    return Uint8Array.from(out);
}

const carrier = (cycles) => [0x0110, le16(cycles)];
const data = (bytes) => [0x0100, bytes];

// One block per data chunk, each after a carrier, as most UEF writers lay a tape out.
const plainUef = (blocks) => uef(blocks.flatMap((b) => [carrier(600), data(b)]));

// Bits at 1200 baud as half-cycle lengths, with the two halves of each cycle recorded unevenly.
function cswPulses(bytes, { rate = CswRate, skew = 0.2 } = {}) {
    const pulses = [];
    const cycle = (hz) => {
        const samples = rate / hz;
        pulses.push(Math.round((samples / 2) * (1 + skew)), Math.round((samples / 2) * (1 - skew)));
    };
    const bit = (b) => (b ? [2400, 2400].forEach(cycle) : cycle(1200));
    const leader = () => {
        for (let i = 0; i < 200; ++i) bit(1);
    };
    for (const chunk of bytes) {
        leader();
        for (const byte of chunk) {
            bit(0);
            for (let i = 0; i < 8; ++i) bit((byte >> i) & 1);
            bit(1);
        }
    }
    leader();
    pulses.push(rate);
    return pulses;
}

function csw(pulses, rate = CswRate) {
    const rle = [];
    for (const p of pulses) {
        if (p < 256) rle.push(p);
        else rle.push(0, ...le32(p));
    }
    const header = [..."Compressed Square Wave\x1a"].map((c) => c.charCodeAt(0));
    header.push(2, 0, ...le32(rate), ...le32(pulses.length), 2, 0, 0, ...new Array(16).fill(0));
    return Uint8Array.from([...header, ...deflateSync(Uint8Array.from(rle))]);
}

const twoFiles = () => [
    ...fileBlocks("LOADER", content(300, 1), { load: 0xffff1900, exec: 0xffff8023 }),
    ...fileBlocks("GAME", content(1000, 2), { load: 0xffff1100, exec: 0xffff1100, flags: Locked }),
];

describe("tapeCrc", () => {
    it("is CRC-16/XMODEM", () => {
        expect(tapeCrc(new TextEncoder().encode("123456789"))).toBe(0x31c3);
    });
});

describe("tape decoding", () => {
    it("rebuilds files from their blocks", () => {
        const { files } = decodeTape(plainUef(twoFiles()));
        expect(
            files.map(({ name, length, blocks, complete, locked }) => ({ name, length, blocks, complete, locked })),
        ).toEqual([
            { name: "LOADER", length: 300, blocks: 2, complete: true, locked: false },
            { name: "GAME", length: 1000, blocks: 4, complete: true, locked: true },
        ]);
        expect([...files[1].data]).toEqual(content(1000, 2));
        expect(files[1].load).toBe(0xffff1100);
    });

    it("skips a block that repeats the one before it", () => {
        const blocks = fileBlocks("GAME", content(600, 3));
        const { files } = decodeTape(plainUef([blocks[0], blocks[1], blocks[1], blocks[2]]));
        expect(files).toHaveLength(1);
        expect(files[0].complete).toBe(true);
        expect([...files[0].data]).toEqual(content(600, 3));
    });

    it("marks a file with a bad or missing block incomplete", () => {
        const good = fileBlocks("GAME", content(600, 3));
        const bad = block({ name: "GAME", number: 1, data: content(600, 3).slice(256, 512), badDataCrc: true });
        expect(decodeTape(plainUef([good[0], bad, good[2]])).files[0]).toMatchObject({ complete: false, badBlocks: 1 });
        expect(decodeTape(plainUef([good[0], good[2]])).files.map((f) => f.complete)).toEqual([false, false]);
    });

    it("takes a good retry of a block that failed its CRC", () => {
        const good = fileBlocks("GAME", content(600, 3));
        const bad = block({ name: "GAME", number: 1, data: content(600, 3).slice(256, 512), badDataCrc: true });
        const [file] = decodeTape(plainUef([good[0], bad, good[1], good[2]])).files;
        expect(file).toMatchObject({ complete: true, badBlocks: 0 });
        expect([...file.data]).toEqual(content(600, 3));
    });

    it("takes a good retry of a last block that failed its CRC", () => {
        const good = fileBlocks("GAME", content(600, 3));
        const bad = block({
            name: "GAME",
            number: 2,
            flags: LastBlock,
            data: content(600, 3).slice(512),
            badDataCrc: true,
        });
        const { files } = decodeTape(plainUef([good[0], good[1], bad, good[2]]));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ complete: true, badBlocks: 0 });
        const one = fileBlocks("TINY", content(40, 5));
        const badOne = block({ name: "TINY", number: 0, flags: LastBlock, data: content(40, 5), badDataCrc: true });
        expect(decodeTape(plainUef([badOne, one[0]])).files).toEqual([
            expect.objectContaining({ name: "TINY", complete: true, badBlocks: 0 }),
        ]);
    });

    it("skips a bad copy of a block it already has", () => {
        const good = fileBlocks("GAME", content(600, 3));
        const worse = block({ name: "GAME", number: 1, data: content(256, 9), badDataCrc: true });
        const { files } = decodeTape(plainUef([good[0], good[1], worse, good[2]]));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ complete: true, badBlocks: 0 });
        expect([...files[0].data]).toEqual(content(600, 3));
    });

    it("takes the good copy after two bad ones", () => {
        const good = fileBlocks("GAME", content(600, 3));
        const bad = (seed) => block({ name: "GAME", number: 1, data: content(256, seed), badDataCrc: true });
        const [file] = decodeTape(plainUef([good[0], bad(7), bad(8), good[1], good[2]])).files;
        expect(file).toMatchObject({ complete: true, badBlocks: 0 });
    });

    it("takes a name of ten characters but not eleven", () => {
        const named = (name) => block({ name, number: 0, flags: LastBlock, data: content(10, 4) });
        expect(decodeTape(plainUef([named("TENCHARSXX")])).files.map((f) => f.name)).toEqual(["TENCHARSXX"]);
        expect(decodeTape(plainUef([named("ELEVENCHARS")])).files).toEqual([]);
    });

    it("keeps bytes outside blocks as stray runs", () => {
        const { stray, blocks } = tapeBlocks(
            tapeRuns(uef([data([1, 2, 3, 4]), carrier(10), data(twoFiles()[0])])).runs,
        );
        expect(blocks).toHaveLength(1);
        expect(stray.map((s) => [...s.bytes])).toEqual([[1, 2, 3, 4]]);
    });

    it("reads bytes back from pulses", () => {
        const bytes = [0x00, 0xff, 0x2a, 0x55, 0xaa, 0x81];
        const { runs } = pulsesToRuns(cswPulses([bytes]), CswRate);
        expect(runs.flatMap((r) => r.bytes)).toEqual(bytes);
    });
});

describe("tapeKey", () => {
    const key = (image) => tapeKey(decodeTape(image).files);
    const reference = key(plainUef(twoFiles()));

    it("ignores how a UEF lays the bytes out", () => {
        const everything = twoFiles().flat();
        expect(key(uef([carrier(100), data(everything)]))).toBe(reference);
        expect(
            key(
                uef(
                    twoFiles().flatMap((b) => [carrier(50), data(b.slice(0, 5)), [0x0112, le16(99)], data(b.slice(5))]),
                ),
            ),
        ).toBe(reference);
        expect(
            key(uef([[0x0111, [...le16(10), ...le16(10)]], ...twoFiles().flatMap((b) => [carrier(600), data(b)])])),
        ).toBe(reference);
    });

    it("ignores gzip and the container", () => {
        expect(key(gzipSync(plainUef(twoFiles())))).toBe(reference);
        expect(key(csw(cswPulses(twoFiles())))).toBe(reference);
    });

    it("counts a file recorded twice in a row once", () => {
        const loader = twoFiles().slice(0, 2);
        expect(key(plainUef([...loader, ...twoFiles()]))).toBe(reference);
    });

    it("changes with a file's name, addresses or contents", () => {
        const variants = [
            [...fileBlocks("LOADER2", content(300, 1)), ...twoFiles().slice(2)],
            [...fileBlocks("LOADER", content(300, 1), { load: 0xffff1a00 }), ...twoFiles().slice(2)],
            [...fileBlocks("LOADER", content(300, 9)), ...twoFiles().slice(2)],
        ];
        for (const variant of variants) expect(key(plainUef(variant))).not.toBe(reference);
    });

    it("includes blocks that don't make up a file", () => {
        const protectedBlocks = (seed) => [
            ...twoFiles().slice(0, 2),
            ...[5, 9, 2].map((number) => block({ name: "\x01X", number, data: content(256, seed + number) })),
        ];
        const decoded = decodeTape(plainUef(protectedBlocks(1)));
        expect(decoded.files.filter((f) => f.complete)).toHaveLength(1);
        expect(tapeKey(decoded.files)).not.toBe(key(plainUef(protectedBlocks(2))));
        expect(tapeKey(decoded.files, { completeFilesOnly: true })).toBe(
            tapeKey(decodeTape(plainUef(protectedBlocks(2))).files, { completeFilesOnly: true }),
        );
    });

    it("can't see bytes outside MOS blocks", () => {
        const withStray = (bytes) =>
            uef([...twoFiles().flatMap((b) => [carrier(600), data(b)]), carrier(600), data(bytes)]);
        expect(key(withStray(content(2000, 4)))).toBe(key(withStray(content(2000, 5))));
    });

    it("is null for a tape with no blocks", () => {
        expect(key(uef([carrier(100), data([1, 2, 3])]))).toBeNull();
    });
});
