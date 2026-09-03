// Minimal ZIP extractor. Supports methods 0 (stored) and 8 (deflate); other
// methods (bzip2, lzma, etc.) will throw an error with the method number.

import { inflate as pakoInflate, inflateRaw as pakoInflateRaw, ungzip as pakoUngzip } from "pako";

const ZipLocalHeaderSig = 0x04034b50;
const ZipCentralDirSig = 0x02014b50;
const ZipEocdSig = 0x06054b50;
const ZipMethodStored = 0;
const ZipMethodDeflate = 8;

function readU16(buf, off) {
    return buf[off] | (buf[off + 1] << 8);
}

function readU32(buf, off) {
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function isValidEocd(buf, off) {
    const commentLen = readU16(buf, off + 20);
    if (off + 22 + commentLen !== buf.length) return false;
    const cdOff = readU32(buf, off + 16);
    const cdSize = readU32(buf, off + 12);
    return cdOff <= off && cdSize <= off - cdOff;
}

// Find the End of Central Directory record by scanning backwards.
// EOCD is in the last 65557 bytes (22-byte fixed record + up to 65535-byte comment).
function findEocd(buf) {
    const searchStart = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= searchStart; i--) {
        if (readU32(buf, i) === ZipEocdSig && isValidEocd(buf, i)) return i;
    }
    throw new Error("Not a ZIP file: EOCD not found");
}

function inflateWith(inflater, data, context) {
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    try {
        return inflater(data);
    } catch (cause) {
        throw new Error(`${context}: ${cause.message || cause}`, { cause });
    }
}

export function inflate(data) {
    return inflateWith(pakoInflate, data, "Unable to inflate");
}

// Extract all files from a ZIP archive.  Returns {filename: Uint8Array}.
export async function unzip(buf) {
    if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
    const eocdOff = findEocd(buf);
    const cdOff = readU32(buf, eocdOff + 16);
    const cdCount = readU16(buf, eocdOff + 10);
    const decoder = new TextDecoder();

    const files = Object.create(null);
    let pos = cdOff;
    for (let i = 0; i < cdCount; i++) {
        if (pos + 46 > buf.length || readU32(buf, pos) !== ZipCentralDirSig)
            throw new Error("Bad central directory entry");
        const flags = readU16(buf, pos + 8);
        if (flags & 0x0001) throw new Error("Encrypted ZIP entries are not supported");
        const method = readU16(buf, pos + 10);
        const expectedCrc = readU32(buf, pos + 16);
        const compressedSize = readU32(buf, pos + 20);
        const nameLen = readU16(buf, pos + 28);
        const extraLen = readU16(buf, pos + 30);
        const commentLen = readU16(buf, pos + 32);
        const localHeaderOff = readU32(buf, pos + 42);
        const name = decoder.decode(buf.subarray(pos + 46, pos + 46 + nameLen));
        pos += 46 + nameLen + extraLen + commentLen;

        // Read local file header to find actual data offset.
        if (readU32(buf, localHeaderOff) !== ZipLocalHeaderSig) throw new Error(`Bad local file header for ${name}`);
        const localNameLen = readU16(buf, localHeaderOff + 26);
        const localExtraLen = readU16(buf, localHeaderOff + 28);
        const dataOff = localHeaderOff + 30 + localNameLen + localExtraLen;
        const dataEnd = dataOff + compressedSize;
        if (dataEnd > buf.length) throw new Error(`Truncated ZIP entry data for ${name}`);
        const raw = buf.subarray(dataOff, dataEnd);

        if (method === ZipMethodStored) {
            files[name] = raw.slice();
        } else if (method === ZipMethodDeflate) {
            files[name] = inflateWith(pakoInflateRaw, raw, `Unable to inflate ZIP entry ${name}`);
        } else {
            throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
        }
        if (crc32(files[name]) >>> 0 !== expectedCrc) throw new Error(`Corrupt ZIP entry ${name}: CRC32 mismatch`);
    }
    return files;
}

// Standard CRC-32/ISO-HDLC.
const Crc32Table = new Uint32Array(256).map((_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; ++bit) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    return crc;
});

export function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; ++i) crc = (crc >>> 8) ^ Crc32Table[(crc ^ data[i]) & 0xff];
    return ~crc;
}

// Create a ZIP blob from an array of {name: string, data: Uint8Array} entries.
// Uses stored method (no compression) with CRC-32 for maximum compatibility.
export function createZipBlob(files) {
    const encoder = new TextEncoder();
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBytes = encoder.encode(name);
        const crc = crc32(data);
        // Local file header (30 + nameLen + data)
        const local = new Uint8Array(30 + nameBytes.length + data.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true); // signature
        lv.setUint16(4, 20, true); // version needed
        lv.setUint16(8, 0, true); // method: stored
        lv.setUint32(14, crc, true); // CRC-32
        lv.setUint32(18, data.length, true); // compressed size
        lv.setUint32(22, data.length, true); // uncompressed size
        lv.setUint16(26, nameBytes.length, true); // name length
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);
        localHeaders.push(local);

        // Central directory entry (46 + nameLen)
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true); // signature
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true); // version needed
        cv.setUint16(10, 0, true); // method: stored
        cv.setUint32(16, crc, true); // CRC-32
        cv.setUint32(20, data.length, true); // compressed size
        cv.setUint32(24, data.length, true); // uncompressed size
        cv.setUint16(28, nameBytes.length, true); // name length
        cv.setUint32(42, offset, true); // local header offset
        central.set(nameBytes, 46);
        centralHeaders.push(central);

        offset += local.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const c of centralHeaders) cdSize += c.length;

    // End of central directory (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // signature
    ev.setUint16(8, files.length, true); // entries on this disc
    ev.setUint16(10, files.length, true); // total entries
    ev.setUint32(12, cdSize, true); // central directory size
    ev.setUint32(16, cdOffset, true); // central directory offset

    return new Blob([...localHeaders, ...centralHeaders, eocd], { type: "application/zip" });
}

export function replaceOrAddExtension(name, newExt) {
    const lastDot = name.lastIndexOf(".");
    if (lastDot === -1) {
        return name + newExt;
    }
    return name.substring(0, lastDot) + newExt;
}

export async function ungzip(data) {
    return inflateWith(pakoUngzip, data, "Unable to ungzip");
}

const knownDiscExtensions = {
    uef: true,
    ssd: true,
    dsd: true,
    adf: true,
    adm: true,
    adl: true,
    hfe: true,
};

const knownRomExtensions = {
    rom: true,
};

async function unzipImage(data, knownExtensions) {
    console.log("Attempting to unzip");

    let files;
    try {
        files = await unzip(data);
    } catch (e) {
        throw new Error("Error unzipping " + e.message, { cause: e });
    }

    let uncompressed = null;
    let loadedFile;
    const ignored = [];

    for (const [filename, fileData] of Object.entries(files)) {
        const match = filename.match(/.*\.([a-z]+)/i);
        if (!match || !knownExtensions[match[1].toLowerCase()]) {
            console.log("Skipping file", filename);
            continue;
        }
        if (uncompressed) {
            console.log("Ignoring", filename, "as already found a file");
            ignored.push(filename);
            continue;
        }
        loadedFile = filename;
        uncompressed = fileData;
    }

    if (!uncompressed) {
        throw new Error("Couldn't find any compatible files in the archive");
    }

    console.log("Unzipped '" + loadedFile + "'");
    return { data: uncompressed, name: loadedFile, ignored };
}

/**
 * @param {Uint8Array|number[]} data a ZIP archive
 * @returns {Promise<{data: Uint8Array, name: string, ignored: string[]}>} the one file loaded, and the
 *     names of any other loadable files the archive held
 */
export async function unzipDiscImage(data) {
    return unzipImage(data, knownDiscExtensions);
}

export async function unzipRomImage(data) {
    return unzipImage(data, knownRomExtensions);
}
