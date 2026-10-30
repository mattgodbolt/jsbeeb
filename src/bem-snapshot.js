// B-em snapshot format parser (versions 1 and 3).
// v1 (BEMSNAP1): Fixed-size 327,885 byte packed struct. Reference: beebjit state.c
// v3 (BEMSNAP3): Section-based with key+size headers, zlib-compressed memory. Reference: b-em savestate.c

import { buildSnapshot, buildVideoState, importedSoundState, importedViaState } from "./snapshot-helpers.js";
import { volumeTable } from "./soundchip.js";
import { inflate } from "./archive.js";
import { BaseRamBytes } from "./6502.js";

const BemV1Size = 327885;

// Indexed by b-em's model number; jsbeeb has no Model A, so the A w/OS 0.1 becomes the B w/OS 0.1.
const BemV1Models = {
    0: "B-MOS0.10",
    1: "B-MOS0.10",
    3: "B",
    4: "B",
};

// v1 struct offsets
const V1Off = {
    signature: 0,
    model: 8,
    a: 9,
    x: 10,
    y: 11,
    flags: 12,
    s: 13,
    pc: 14,
    nmi: 16,
    interrupt: 17,
    cycles: 18,
    fe30: 22,
    fe34: 23,
    ram: 24,
    rom: 24 + 65536,
    sysvia: 24 + 65536 + 262144,
};

/**
 * Check if an ArrayBuffer looks like a b-em snapshot (any version).
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isBemSnapshot(buffer) {
    if (buffer.byteLength < 8) return false;
    const sig = String.fromCharCode(...new Uint8Array(buffer, 0, 7));
    return sig === "BEMSNAP";
}

/**
 * Parse a b-em snapshot (v1 or v3) into a jsbeeb snapshot object.
 * @param {ArrayBuffer} buffer
 * @returns {object} jsbeeb snapshot
 */
export async function parseBemSnapshot(buffer) {
    if (buffer.byteLength < 8) throw new Error("File too small to be a b-em snapshot");
    const bytes = new Uint8Array(buffer);
    const sig = String.fromCharCode(...bytes.slice(0, 8));

    if (sig === "BEMSNAP1") return parseBemV1(buffer);
    if (sig === "BEMSNAP3") return parseBemV3(buffer);
    throw new Error(`Unsupported b-em snapshot version: "${sig}"`);
}

// ── Shared helpers ──────────────────────────────────────────────────

function readViaFromBytes(data, offset) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    return {
        ora: data[offset],
        orb: data[offset + 1],
        ira: data[offset + 2],
        irb: data[offset + 3],
        // +4, +5 are port read values (ignored on load, matching b-em via_loadstate)
        ddra: data[offset + 6],
        ddrb: data[offset + 7],
        sr: data[offset + 8],
        acr: data[offset + 9],
        pcr: data[offset + 10],
        ifr: data[offset + 11],
        ier: data[offset + 12],
        t1l: view.getInt32(13, true),
        t2l: view.getInt32(17, true),
        t1c: view.getInt32(21, true),
        t2c: view.getInt32(25, true),
        t1hit: data[offset + 29],
        t2hit: data[offset + 30],
        ca1: data[offset + 31],
        ca2: data[offset + 32],
    };
}

const ViaDataSize = 33; // 13 bytes + 4*4 timer ints + 4 booleans

function readCpuFromBytes(data) {
    return {
        a: data[0],
        x: data[1],
        y: data[2],
        flags: data[3],
        s: data[4],
        pc: data[5] | (data[6] << 8),
        nmi: data[7],
        interrupt: data[8],
        cycles: data[9] | (data[10] << 8) | (data[11] << 16) | (data[12] << 24),
    };
}

// What a v3 snapshot with no section for a VIA holds for it.
const MissingBemVia = Object.freeze({
    ora: 0,
    orb: 0,
    ira: 0,
    irb: 0,
    ddra: 0,
    ddrb: 0,
    sr: 0,
    acr: 0,
    pcr: 0,
    ifr: 0,
    ier: 0,
    t1l: 0x1fffe,
    t2l: 0x1fffe,
    t1c: 0x1fffe,
    t2c: 0x1fffe,
    t1hit: 1,
    t2hit: 1,
    ca1: 0,
    ca2: 0,
});

const BemSoundSize = 55;

/** b-em's SN76489 block: latches, counts, states, volumes, noise register and LFSR, each per b-em channel. */
function readBemSound(data, offset) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const registers = new Uint16Array(4);
    const counter = new Float32Array(4);
    const outputBit = [false, false, false, false];
    const volume = new Float32Array(4);
    for (let i = 0; i < 4; ++i) {
        const snChannel = 3 - i;
        let period = view.getUint32(snChannel * 4, true) >> 6;
        let count = view.getUint32(16 + snChannel * 4, true) >> 6;
        if (i === 3) {
            period >>= 1;
            count >>= 1;
        }
        registers[i] = period;
        counter[i] = count;
        outputBit[i] = view.getUint32(32 + snChannel * 4, true) < 16;
        volume[i] = volumeTable[view.getUint8(48 + snChannel) & 0x0f];
    }
    registers[3] = view.getUint8(52) & 0x07;
    return importedSoundState({ registers, counter, outputBit, volume }, view.getUint16(53, true));
}

/** What a v3 snapshot with no sound section holds: silence, with the noise LFSR at its reset value. */
function missingBemSound() {
    const bytes = new Uint8Array(BemSoundSize);
    new DataView(bytes.buffer).setUint16(53, 1 << 14, true);
    return bytes;
}

// ── V1 parser (BEMSNAP1, fixed struct) ──────────────────────────────

function parseBemV1(buffer) {
    if (buffer.byteLength !== BemV1Size) {
        throw new Error(`Invalid BEM v1 snapshot size: expected ${BemV1Size}, got ${buffer.byteLength}`);
    }
    const bytes = new Uint8Array(buffer);

    const bemModel = bytes[V1Off.model];
    const modelName = BemV1Models[bemModel];
    if (!modelName) {
        throw new Error(`Unsupported BEM v1 model: ${bemModel} (only the BBC B and the OS 0.1 models are supported)`);
    }

    const cpuState = {
        ...readCpuFromBytes(bytes.slice(V1Off.a)),
        fe30: bytes[V1Off.fe30],
        fe34: bytes[V1Off.fe34],
    };

    const ram = new Uint8Array(BaseRamBytes);
    ram.set(bytes.slice(V1Off.ram, V1Off.ram + 65536));
    const roms = bytes.slice(V1Off.rom, V1Off.rom + 262144);

    const sysVia = readViaFromBytes(bytes, V1Off.sysvia);
    const sysViaIC32 = bytes[V1Off.sysvia + ViaDataSize];
    const userVia = readViaFromBytes(bytes, V1Off.sysvia + ViaDataSize + 1);

    const ulaOff = V1Off.sysvia + ViaDataSize + 1 + ViaDataSize;
    const ulaControl = bytes[ulaOff];
    const ulaPalette = bytes.slice(ulaOff + 1, ulaOff + 17);
    const crtcOff = ulaOff + 17;
    const crtcRegs = bytes.slice(crtcOff, crtcOff + 18);

    const soundOff = crtcOff + 18 + 7 + 4 + 1 + 4;

    return buildSnapshot(
        "b-em",
        modelName,
        cpuState,
        ram,
        roms,
        importedViaState(sysVia, sysViaIC32),
        importedViaState(userVia, undefined),
        buildVideoState(ulaControl, ulaPalette, crtcRegs),
        readBemSound(bytes, soundOff),
    );
}

// ── V3 parser (BEMSNAP3, section-based) ─────────────────────────────

// Variable-length integer encoding used by b-em v3
function readVar(data, pos) {
    let value = 0;
    let shift = 0;
    while (pos.offset < data.length) {
        const byte = data[pos.offset++];
        value |= (byte & 0x7f) << shift;
        if (byte & 0x80) break;
        shift += 7;
    }
    return value;
}

function readString(data, pos) {
    const len = readVar(data, pos);
    const str = String.fromCharCode(...data.slice(pos.offset, pos.offset + len));
    pos.offset += len;
    return str;
}

// b-em writes the tube ULA as a raw struct dump. Version 2 is all single-byte fields, so it has
// no padding and can be read directly; version 1 used native ints and is not supported here.
const BemTubeUlaVersion = 2;
const BemTubeUlaOffsets = {
    ph1: 0,
    ph2: 24,
    ph3: 25,
    ph4: 27,
    hp1: 29, // phl (byte 28) is a latch jsbeeb does not model
    hp2: 30,
    hp3: 31,
    hp4: 33,
    hstat: 35, // hpl (byte 34) likewise unmodelled
    pstat: 39,
    r1stat: 43,
    ph1head: 45, // ph1tail (byte 44) matters only to b-em, which appends there
    ph1count: 46,
    ph3pos: 47,
    hp3pos: 48,
};
const BemTubeUlaSize = 49;
const BemPh1Size = 24;
// 9 bytes of registers, then RAM, then ROM.
const BemTubeRegisterBytes = 9;
const BemTubeRamSize = 65536;
// b-em's other co-processors are different CPUs, and its "6502 Turbo" has 16MB of RAM.
const BemSupportedTubes = ["6502 Internal", "6502 External"];

/**
 * Convert b-em's tube sections into jsbeeb tube state.
 * @param {object} sections - parsed v3 sections
 * @param {string|null} tubeName - co-processor name from the model section
 * @returns {object|null} jsbeeb tube state, or null if no usable co-processor
 */
function parseBemTube(sections, tubeName) {
    // b-em names the model's co-processor even when it failed to start one, so naming a tube but
    // carrying no state for it is valid. Carrying only one of the two sections is not.
    if (!sections["T"] && !sections["P"]) return null;
    if (!sections["T"] || !sections["P"]) {
        throw new Error("Truncated b-em snapshot: it holds only one of the two co-processor sections");
    }
    // b-em only writes these sections for a co-processor it started, which it always names.
    if (!tubeName) {
        throw new Error("Corrupt b-em snapshot: it holds co-processor state but names no co-processor");
    }
    if (!BemSupportedTubes.includes(tubeName)) {
        throw new Error(
            `Unsupported b-em co-processor "${tubeName}": jsbeeb only emulates the 64K 65C02 second processor`,
        );
    }

    const ulaSection = sections["T"].data;
    if (ulaSection[0] !== BemTubeUlaVersion) {
        throw new Error(`Unsupported b-em tube ULA state version ${ulaSection[0]}`);
    }
    if (ulaSection.length < 2 + BemTubeUlaSize) {
        throw new Error(
            `Truncated b-em tube ULA state: expected ${2 + BemTubeUlaSize} bytes, got ${ulaSection.length}`,
        );
    }
    const romPaged = !!ulaSection[1];
    const ula = ulaSection.slice(2, 2 + BemTubeUlaSize);
    const at = (field) => ula[BemTubeUlaOffsets[field]];

    // b-em keeps the R1 FIFO as a circular buffer; jsbeeb shifts its contents down on read, so
    // the bytes have to be linearised into the order jsbeeb expects to read them.
    const ph1Count = at("ph1count");
    const ph1Head = at("ph1head");
    // Out-of-range counts would restore a FIFO jsbeeb's own reads could never have produced.
    if (ph1Count > BemPh1Size || ph1Head >= BemPh1Size || at("ph3pos") > 2 || at("hp3pos") > 2) {
        throw new Error("Corrupt b-em tube ULA state: FIFO counts out of range");
    }
    const ph1 = new Uint8Array(BemPh1Size);
    for (let i = 0; i < ph1Count; i++) {
        ph1[i] = ula[BemTubeUlaOffsets.ph1 + ((ph1Head + i) % BemPh1Size)];
    }

    // Those names come from a config file, so size is the real check. It cannot be exact: the
    // trailing ROM's size comes from that same config, and b-em records it as zero if unset.
    const parasite = inflate(sections["P"].data);
    const romBytes = parasite.length - BemTubeRegisterBytes - BemTubeRamSize;
    if (romBytes < 0 || romBytes > BemTubeRamSize) {
        throw new Error(
            `Unsupported b-em co-processor: expected ${BemTubeRamSize} bytes of parasite RAM, ` +
                `but the state section holds ${parasite.length - BemTubeRegisterBytes}`,
        );
    }

    return {
        a: parasite[2],
        x: parasite[3],
        y: parasite[4],
        p: parasite[5] | 0x30,
        s: parasite[6],
        pc: parasite[7] | (parasite[8] << 8),
        // b-em's oldnmi is the NMI level as of the parasite's last instruction, so it may lag the
        // line its ULA state implies. b-em's skipint has no jsbeeb equivalent and is dropped.
        nmiLevel: !!parasite[1],
        nmiEdge: false,
        takeInt: false,
        cycles: 0,
        romPaged,
        memory: parasite.slice(BemTubeRegisterBytes, BemTubeRegisterBytes + BemTubeRamSize),
        // The parasite ROM is loaded from file at boot, so b-em's copy is not needed.
        ula: {
            internalStatusRegister: at("r1stat"),
            hostStatus: ula.slice(BemTubeUlaOffsets.hstat, BemTubeUlaOffsets.hstat + 4),
            parasiteStatus: ula.slice(BemTubeUlaOffsets.pstat, BemTubeUlaOffsets.pstat + 4),
            parasiteToHostData: [
                ph1,
                Uint8Array.of(at("ph2")),
                ula.slice(BemTubeUlaOffsets.ph3, BemTubeUlaOffsets.ph3 + 2),
                Uint8Array.of(at("ph4")),
            ],
            hostToParasiteData: [
                Uint8Array.of(at("hp1")),
                Uint8Array.of(at("hp2")),
                ula.slice(BemTubeUlaOffsets.hp3, BemTubeUlaOffsets.hp3 + 2),
                Uint8Array.of(at("hp4")),
            ],
            parasiteToHostFifoByteCount1: ph1Count,
            parasiteToHostFifoByteCount3: at("ph3pos"),
            hostToParasiteFifoByteCount3: at("hp3pos"),
        },
    };
}

/**
 * Read the co-processor name from b-em's model section, if one was fitted.
 * @returns {string|null}
 */
function readBemTubeName(data, pos) {
    for (let i = 0; i < 4; i++) readString(data, pos); // os, cmos, rom setup, fdc names
    pos.offset += 6; // model flag bytes
    const fitted = data[pos.offset++];
    return fitted ? readString(data, pos) : null;
}

function parseBemV3(buffer) {
    const bytes = new Uint8Array(buffer);
    let offset = 8; // Skip "BEMSNAP3" signature

    const sections = {};
    while (offset < bytes.length) {
        let key = bytes[offset];
        let size = bytes[offset + 1] | (bytes[offset + 2] << 8);
        let headerSize = 3;

        if (key & 0x80) {
            // Extended size (4 bytes) for compressed sections
            key &= 0x7f;
            size |= (bytes[offset + 3] << 16) | (bytes[offset + 4] << 24);
            headerSize = 5;
        }

        const sectionData = bytes.slice(offset + headerSize, offset + headerSize + size);
        const keyChar = String.fromCharCode(key);
        sections[keyChar] = { data: sectionData, compressed: headerSize === 5 };
        offset += headerSize + size;
    }

    // Parse model section to determine jsbeeb model name.
    // Use jsbeeb synonyms (from models.js) so findModel() resolves them.
    let modelName = "B";
    let tubeName = null;
    if (sections["m"]) {
        const pos = { offset: 0 };
        const data = sections["m"].data;
        readVar(data, pos); // curmodel index (skip)
        const name = readString(data, pos);
        tubeName = readBemTubeName(data, pos);
        if (name.includes("OS 0.1")) {
            modelName = "B-MOS0.10";
        } else if (name.includes("Master")) {
            if (name.includes("ADFS")) modelName = "MasterADFS";
            else if (name.includes("ANFS")) modelName = "MasterANFS";
            else modelName = "Master";
        } else if (name.includes("1770")) {
            if (name.includes("ADFS")) modelName = "B1770A";
            else modelName = "B1770";
        } else {
            modelName = "B";
        }
    }

    // Parse CPU
    let cpuState = { a: 0, x: 0, y: 0, flags: 0x30, s: 0xff, pc: 0, nmi: 0, interrupt: 0, cycles: 0 };
    if (sections["6"]) {
        cpuState = readCpuFromBytes(sections["6"].data);
    }

    // Parse memory (zlib-compressed in v3)
    const ram = new Uint8Array(BaseRamBytes);
    let roms = null;
    const memSection = sections["M"];
    if (memSection) {
        // Decompressed layout: 2 bytes (fe30, fe34) + 64KB RAM + 256KB ROM
        const memData = inflate(memSection.data);
        cpuState.fe30 = memData[0];
        cpuState.fe34 = memData[1];
        const ramStart = 2;
        const ramSize = 64 * 1024;
        ram.set(memData.slice(ramStart, ramStart + ramSize));
        const romStart = ramStart + ramSize;
        if (memData.length > romStart) {
            roms = memData.slice(romStart, romStart + 262144);
        }
    }

    const tube = parseBemTube(sections, tubeName);

    let sysvia = importedViaState(MissingBemVia, 0);
    if (sections["S"]) {
        const data = sections["S"].data;
        const via = readViaFromBytes(data, 0);
        const ic32 = data.length > ViaDataSize ? data[ViaDataSize] : 0;
        sysvia = importedViaState(via, ic32);
    }

    let uservia = importedViaState(MissingBemVia, undefined);
    if (sections["U"]) {
        uservia = importedViaState(readViaFromBytes(sections["U"].data, 0), undefined);
    }

    // Parse Video ULA
    // v3 section layout (97 bytes):
    //   1: ula_ctrl
    //  16: ula_palbak[16] (raw palette register values)
    //  64: nula_collook[16] (4 bytes each: R, G, B, A in Allegro RGBA format)
    //   1: nula_pal_write_flag
    //   1: nula_pal_first_byte
    //   8: nula_flash[8]
    //   1: nula_palette_mode
    //   ... (more NULA state follows)
    let ulaControl = 0;
    let ulaPalette = new Uint8Array(16);
    let nulaCollook = null;
    if (sections["V"]) {
        const data = sections["V"].data;
        ulaControl = data[0];
        ulaPalette = data.slice(1, 17);
        // Parse NULA collook if section is large enough (v3 has 97 bytes)
        if (data.length >= 81) {
            nulaCollook = new Int32Array(16);
            for (let c = 0; c < 16; c++) {
                const off = 17 + c * 4;
                // b-em stores as R, G, B, A (Allegro format)
                // jsbeeb uses ABGR format (Uint32 on little-endian = canvas RGBA)
                const r = data[off];
                const g = data[off + 1];
                const b = data[off + 2];
                const a = data[off + 3];
                nulaCollook[c] = (a << 24) | (b << 16) | (g << 8) | r;
            }
        }
    }

    // Parse CRTC (18 regs + optional 7 counter bytes: vc, sc, hc, ma_lo, ma_hi, maback_lo, maback_hi)
    let crtcRegs = new Uint8Array(18);
    let crtcCounters = null;
    if (sections["C"]) {
        const data = sections["C"].data;
        crtcRegs = data.slice(0, 18);
        if (data.length >= 25) {
            crtcCounters = {
                vc: data[18],
                sc: data[19],
                hc: data[20],
                ma: data[21] | (data[22] << 8),
                maback: data[23] | (data[24] << 8),
            };
        }
    }

    const soundChip = readBemSound(sections["s"]?.data ?? missingBemSound(), 0);

    return buildSnapshot(
        "b-em",
        modelName,
        cpuState,
        ram,
        roms,
        sysvia,
        uservia,
        buildVideoState(ulaControl, ulaPalette, crtcRegs, nulaCollook, crtcCounters),
        soundChip,
        tube,
    );
}
