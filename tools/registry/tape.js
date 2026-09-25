// Decodes Acorn cassette images (UEF, CSW, either gzipped) into the bytes on the tape, the MOS blocks
// among them and the files those blocks make up, and computes the tape fingerprint.

import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";

const UefMagic = "UEF File!";
const CswMagic = "Compressed Square Wave\x1a";
const SyncByte = 0x2a;
const MaxNameLength = 10;
const LastBlockFlag = 0x80;

const UefOrigin = 0x0000;
const UefData = 0x0100;
const UefDefinedData = 0x0104;
const UefCarrier = 0x0110;
const UefCarrierWithDummy = 0x0111;
const UefIntegerGap = 0x0112;
const UefBaseFrequency = 0x0113;
const UefSecurityCycles = 0x0114;
const UefPhase = 0x0115;
const UefFloatGap = 0x0116;
const UefBaud = 0x0117;

const CswRle = 1;
const CswZRle = 2;
const CswV1DataStart = 0x20;
const CswV2HeaderLength = 0x34;

export const shortHash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** CRC-16/XMODEM, which the MOS uses for block headers and data. */
export function tapeCrc(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; ++i) {
        crc ^= bytes[i] << 8;
        for (let bit = 0; bit < 8; ++bit) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const startsWith = (b, text) => b.length >= text.length && [...text].every((c, i) => b[i] === c.charCodeAt(0));

/**
 * The bytes on a tape, as runs separated by carrier or gaps. Each run has its serial framing
 * ("8N1" unless a UEF says otherwise); `notes` counts the things the byte stream leaves out.
 */
export function tapeRuns(raw) {
    const bytes = isGzip(raw) ? new Uint8Array(gunzipSync(raw)) : raw;
    if (startsWith(bytes, UefMagic)) return { format: "uef", gzip: bytes !== raw, ...uefRuns(bytes) };
    if (startsWith(bytes, CswMagic)) return { format: "csw", gzip: bytes !== raw, ...cswRuns(bytes) };
    throw new Error("Not a UEF or CSW tape image");
}

function uefRuns(b) {
    const runs = [];
    const notes = { chunks: {} };
    let current = null;
    const append = (framing, data) => {
        if (!current || current.framing !== framing) {
            current = { framing, bytes: [] };
            runs.push(current);
        }
        for (const byte of data) current.bytes.push(byte);
    };
    const breakRun = () => (current = null);
    let pos = 12;
    while (pos + 6 <= b.length) {
        const id = u16(b, pos);
        const length = u32(b, pos + 2);
        const body = b.subarray(pos + 6, pos + 6 + length);
        pos += 6 + length;
        const hex = id.toString(16).padStart(4, "0");
        notes.chunks[hex] = (notes.chunks[hex] ?? 0) + 1;
        switch (id) {
            case UefData:
                append("8N1", body);
                break;
            case UefDefinedData: {
                const framing = `${body[0]}${String.fromCharCode(body[1])}${body[2] & 0x80 ? -(256 - body[2]) : body[2]}`;
                const mask = (1 << body[0]) - 1;
                append(
                    framing,
                    [...body.subarray(3)].map((byte) => byte & mask),
                );
                break;
            }
            case UefCarrier:
            case UefCarrierWithDummy:
            case UefIntegerGap:
            case UefFloatGap:
            case UefBaseFrequency:
            case UefBaud:
            case UefSecurityCycles:
            case UefPhase:
                breakRun();
                break;
            default:
                if (id !== UefOrigin && id >> 8 !== 0) notes.unknown = (notes.unknown ?? 0) + 1;
        }
    }
    if (pos !== b.length) notes.truncated = true;
    return { runs, notes };
}

function cswPulses(b) {
    const major = b[0x17];
    let rate, compression, dataStart;
    if (major === 1) {
        rate = u16(b, 0x19);
        compression = b[0x1b];
        dataStart = CswV1DataStart;
    } else if (major === 2) {
        rate = u32(b, 0x19);
        compression = b[0x21];
        dataStart = CswV2HeaderLength + b[0x23];
    } else {
        throw new Error(`Unsupported CSW version ${major}`);
    }
    let data = b.subarray(dataStart);
    if (compression === CswZRle) data = new Uint8Array(inflateSync(data));
    else if (compression !== CswRle) throw new Error(`Unsupported CSW compression ${compression}`);
    const pulses = [];
    for (let i = 0; i < data.length;) {
        const n = data[i++];
        if (n) pulses.push(n);
        else {
            pulses.push(u32(data, i));
            i += 4;
        }
    }
    return { rate, pulses };
}

/**
 * Turns half-cycle lengths into bytes at 1200 baud, breaking runs at gaps and long carrier. Pulses are
 * paired into cycles, as the two halves of a cycle are often recorded at quite different lengths; a pair
 * that is neither a short nor a long cycle is a half-cycle out of phase, so the pairing slips by one.
 */
export function pulsesToRuns(pulses, rate) {
    const { short, long } = cycleLengths(pulses, rate);
    const tolerance = (long - short) / 3;
    const gapAbove = long * 1.5;
    const isShort = (c) => Math.abs(c - short) < tolerance;
    const isLong = (c) => Math.abs(c - long) < tolerance;

    const bits = [];
    for (let i = 0; i + 1 < pulses.length;) {
        if (pulses[i] > gapAbove) {
            bits.push(null);
            i++;
            continue;
        }
        const cycle = pulses[i] + pulses[i + 1];
        if (isLong(cycle)) {
            bits.push(0);
            i += 2;
        } else if (isShort(cycle) && i + 3 < pulses.length && isShort(pulses[i + 2] + pulses[i + 3])) {
            bits.push(1);
            i += 4;
        } else i++;
    }
    const runs = [];
    const notes = { framingErrors: 0, elevenBitFrames: 0, shortCycle: short, longCycle: long };
    let current = null;
    let idle = 0;
    for (let i = 0; i < bits.length;) {
        if (bits[i] !== 0) {
            if (bits[i] === null || ++idle > 20) current = null;
            i++;
            continue;
        }
        // A parity bit, or a second stop bit, leaves the byte where it is: a 1 reads as carrier after the
        // stop bit, and a 0 is caught here.
        const frame = bits.slice(i + 1, i + 11);
        let frameBits = 10;
        if (frame[8] === 0 && frame[9] === 1) {
            frameBits = 11;
            notes.elevenBitFrames++;
        } else if (frame.length < 9 || frame.slice(0, 9).includes(null) || frame[8] !== 1) {
            notes.framingErrors++;
            i++;
            continue;
        }
        let byte = 0;
        for (let bit = 0; bit < 8; ++bit) byte |= frame[bit] << bit;
        if (!current) {
            current = { framing: "8N1", bytes: [] };
            runs.push(current);
        }
        current.bytes.push(byte);
        idle = 0;
        i += frameBits;
    }
    return { runs, notes };
}

/**
 * The short and long cycle lengths in samples: twice the centres of a two-means over the half-cycles, which
 * unlike pairs of pulses can't include a pair that straddles a change of frequency.
 */
function cycleLengths(pulses, rate) {
    let short = rate / 4800;
    let long = rate / 2400;
    const halves = pulses.filter((p) => p < long * 2);
    for (let iteration = 0; iteration < 10; ++iteration) {
        let sumShort = 0;
        let nShort = 0;
        let sumLong = 0;
        let nLong = 0;
        const mid = (short + long) / 2;
        for (const p of halves) {
            if (p < mid) {
                sumShort += p;
                nShort++;
            } else {
                sumLong += p;
                nLong++;
            }
        }
        if (!nShort || !nLong) break;
        short = sumShort / nShort;
        long = sumLong / nLong;
    }
    return { short: short * 2, long: long * 2 };
}

function cswRuns(b) {
    const { rate, pulses } = cswPulses(b);
    return pulsesToRuns(pulses, rate);
}

/** Parses one MOS block header at `pos` (the sync byte), or returns null if there isn't a good one. */
function parseHeader(stream, pos) {
    if (stream[pos] !== SyncByte) return null;
    let end = pos + 1;
    while (end < stream.length && end - pos - 1 <= MaxNameLength && stream[end] !== 0) end++;
    if (end >= stream.length || stream[end] !== 0) return null;
    const nameBytes = stream.subarray(pos + 1, end);
    const h = end + 1;
    const headerEnd = h + 17;
    if (headerEnd + 2 > stream.length) return null;
    const crc = (stream[headerEnd] << 8) | stream[headerEnd + 1];
    if (tapeCrc(stream, pos + 1, headerEnd) !== crc) return null;
    return {
        name: String.fromCharCode(...nameBytes),
        load: u32(stream, h),
        exec: u32(stream, h + 4),
        number: u16(stream, h + 8),
        length: u16(stream, h + 10),
        flags: stream[h + 12],
        next: u32(stream, h + 13),
        dataStart: headerEnd + 2,
    };
}

/**
 * Finds the MOS blocks in a tape's runs. The runs are searched as one stream, whatever their framing, as
 * a loader can read standard blocks however they are framed and a block can straddle a break between
 * runs. Bytes that aren't part of a block with good CRCs are returned as `stray` runs. After a block whose
 * data is bad, the search carries on from its header, so a block cut short doesn't swallow the next one.
 */
export function tapeBlocks(runs) {
    const stream = Uint8Array.from(runs.flatMap((run) => run.bytes));
    const runOf = new Uint32Array(stream.length);
    for (let i = 0, pos = 0; i < runs.length; pos += runs[i].bytes.length, ++i)
        runOf.fill(i, pos, pos + runs[i].bytes.length);
    const blocks = [];
    const stray = [];
    let strayStart = 0;
    const flushStray = (end) => {
        for (let start = strayStart; start < end;) {
            let stop = start;
            while (stop < end && runOf[stop] === runOf[start]) stop++;
            stray.push({ run: runOf[start], framing: runs[runOf[start]].framing, bytes: stream.slice(start, stop) });
            start = stop;
        }
    };
    for (let pos = 0; pos < stream.length;) {
        const header = parseHeader(stream, pos);
        if (!header) {
            pos++;
            continue;
        }
        const { dataStart, length } = header;
        const data = stream.slice(dataStart, dataStart + length);
        const hasData = length > 0;
        const dataEnd = dataStart + length + (hasData ? 2 : 0);
        const complete = dataEnd <= stream.length;
        const dataCrcGood =
            !hasData ||
            (complete && tapeCrc(data) === ((stream[dataStart + length] << 8) | stream[dataStart + length + 1]));
        blocks.push({ ...header, run: runOf[pos], framing: runs[runOf[pos]].framing, data, complete, dataCrcGood });
        const resume = complete && dataCrcGood ? dataEnd : dataStart;
        flushStray(pos);
        pos = resume;
        strayStart = pos;
    }
    flushStray(stream.length);
    return { blocks, stray };
}

/**
 * Assembles blocks into files. A file starts at block 0 and takes each following block of the same name
 * with the next number, until the last-block flag. A repeated block (the same header and data again) is
 * skipped. Anything else that doesn't fit ends the file, which is then incomplete.
 */
export function tapeFiles(blocks) {
    const files = [];
    let file = null;
    const finish = () => {
        if (file) files.push(file);
        file = null;
    };
    for (const block of blocks) {
        const good = block.complete && block.dataCrcGood;
        if (
            file &&
            block.name === file.name &&
            block.number === file.nextNumber - 1 &&
            sameBlock(block, file.lastBlock)
        )
            continue;
        if (!file || block.name !== file.name || block.number !== file.nextNumber) {
            finish();
            file = {
                name: block.name,
                load: block.load,
                exec: block.exec,
                chunks: [],
                goodBlocks: [],
                nextNumber: block.number,
                firstNumber: block.number,
                bad: 0,
                locked: false,
                complete: false,
            };
        }
        file.chunks.push(block.data);
        file.lastBlock = block;
        file.nextNumber = block.number + 1;
        if (good) file.goodBlocks.push(block);
        else file.bad++;
        if (block.flags & 1) file.locked = true;
        if (block.flags & LastBlockFlag) {
            file.complete = file.firstNumber === 0 && file.bad === 0;
            finish();
        }
    }
    finish();
    return files.map(({ name, load, exec, chunks, goodBlocks, firstNumber, nextNumber, bad, locked, complete }) => {
        const data = concat(chunks);
        return {
            name,
            load,
            exec,
            length: data.length,
            blocks: nextNumber - firstNumber,
            firstBlock: firstNumber,
            badBlocks: bad,
            locked,
            complete,
            data,
            goodBlocks: complete ? [] : goodBlocks,
        };
    });
}

function sameBlock(a, b) {
    return (
        a.load === b.load &&
        a.exec === b.exec &&
        a.flags === b.flags &&
        a.data.length === b.data.length &&
        a.data.every((byte, i) => byte === b.data[i])
    );
}

function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let pos = 0;
    for (const chunk of chunks) {
        out.set(chunk, pos);
        pos += chunk.length;
    }
    return out;
}

const u32le = (value) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    return b;
};

const FileRecord = 0x46;
const BlockRecord = 0x42;

/**
 * The tape key: SHA-256 over the tape's records in order, cut to 128 bits. Each complete file is a record,
 * and so is each good block that isn't part of one, so blocks that a loader reads by number, whatever
 * their names, still count. A record that repeats the one before it is dropped, as tapes often carry
 * files twice. Null if there are no records. With `completeFilesOnly`, only complete files count.
 */
export function tapeKey(files, { completeFilesOnly = false } = {}) {
    const hash = createHash("sha256");
    let previous = null;
    let any = false;
    const add = (record) => {
        if (previous && Buffer.compare(previous, record) === 0) return;
        hash.update(record);
        previous = record;
        any = true;
    };
    for (const file of files) {
        if (file.complete) add(fileRecord(file));
        else if (!completeFilesOnly) for (const block of file.goodBlocks) add(blockRecord(block));
    }
    return any ? hash.digest("hex").slice(0, 32) : null;
}

const u16le = (value) => Uint8Array.of(value & 0xff, value >> 8);

const nameBytes = (name) => Buffer.concat([Buffer.from(name, "latin1"), Buffer.from([0])]);

function fileRecord(file) {
    return Buffer.concat([
        Buffer.from([FileRecord]),
        nameBytes(file.name),
        u32le(file.load),
        u32le(file.exec),
        u32le(file.data.length),
        file.data,
    ]);
}

function blockRecord(block) {
    return Buffer.concat([
        Buffer.from([BlockRecord]),
        nameBytes(block.name),
        u32le(block.load),
        u32le(block.exec),
        u16le(block.number),
        Buffer.from([block.flags]),
        u32le(block.data.length),
        block.data,
    ]);
}

/** Decodes a tape image all the way to files. */
export function decodeTape(raw) {
    const { runs, notes, format, gzip } = tapeRuns(raw);
    const { blocks, stray } = tapeBlocks(runs);
    const files = tapeFiles(blocks);
    return { format, gzip, notes, runs, blocks, stray, files };
}
