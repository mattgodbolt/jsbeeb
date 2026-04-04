"use strict";

// BeebEm UEF save state parser.
// Converts a BeebEm UEF save state file into a jsbeeb snapshot object, in the same way
// that bem-snapshot.js converts B-em snapshots.
//
// BeebEm extends the UEF (Universal Emulator Format) with save-state chunks in the
// 0x0460-0x047F range, identified by an initial 0x046C (BeebEm ID) chunk.
// Reference: stardot/beebem-windows Src/UefState.cpp

import { volumeTable, buildVideoState, buildSnapshot } from "./snapshot-helpers.js";

// Chunk IDs used in BeebEm UEF save states
const ChunkId = {
    BeebEmID: 0x046c, // presence of this chunk identifies a BeebEm save state
    EmuState: 0x046a, // machine type, FDC type, tube type
    Cpu6502: 0x0460, // 6502 CPU registers and status
    RomRegs: 0x0461, // paged ROM register (FE30) and ACCCON (FE34)
    MainRam: 0x0462, // main RAM (32 KB)
    ShadowRam: 0x0463, // shadow RAM (BBC B+/Master)
    PrivateRam: 0x0464, // private RAM (BBC B+/Master)
    SwRam: 0x0466, // sideways RAM bank (one chunk per bank)
    Via: 0x0467, // VIA state (one chunk per VIA: sys VIA first, then user VIA)
    Video: 0x0468, // video state (CRTC + ULA)
    Sound: 0x046b, // SN76489 sound chip state
};

/**
 * Check whether an ArrayBuffer looks like a BeebEm UEF save state.
 * A save state has the "UEF File!" header and its first chunk is the BeebEm ID (0x046C).
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isUefSnapshot(buffer) {
    if (buffer.byteLength < 14) return false;
    const bytes = new Uint8Array(buffer, 0, 14);
    // Bytes 0-9: "UEF File!\0"
    const header = "UEF File!";
    for (let i = 0; i < 9; i++) {
        if (bytes[i] !== header.charCodeAt(i)) return false;
    }
    if (bytes[9] !== 0) return false;
    // Bytes 12-13: first chunk ID (little-endian uint16) must be 0x046C
    const chunkId = bytes[12] | (bytes[13] << 8);
    return chunkId === ChunkId.BeebEmID;
}

/**
 * Parse all UEF chunks from the buffer into a Map<chunkId, Uint8Array[]>.
 * Starts after the 12-byte UEF header (10 bytes signature + 2 bytes version).
 */
function parseChunks(bytes, view) {
    const chunks = new Map();
    let offset = 12;
    while (offset + 6 <= bytes.length) {
        const chunkId = view.getUint16(offset, true);
        const chunkLen = view.getUint32(offset + 2, true);
        offset += 6;
        if (offset + chunkLen > bytes.length) break;
        const chunkData = bytes.slice(offset, offset + chunkLen);
        if (!chunks.has(chunkId)) chunks.set(chunkId, []);
        chunks.get(chunkId).push(chunkData);
        offset += chunkLen;
    }
    return chunks;
}

/**
 * Convert a BeebEm UEF VIA state (from chunk 0x0467) to jsbeeb VIA state.
 * The UEF chunk layout (with the leading VIAType byte) is:
 *   [0]     VIAType (0=sys, 1=user)
 *   [1]     ORB
 *   [2]     IRB
 *   [3]     ORA
 *   [4]     IRA
 *   [5]     DDRB
 *   [6]     DDRA
 *   [7-8]   timer1c / 2  (uint16 LE; BeebEm saves count/2, jsbeeb needs count*2 from file)
 *   [9-10]  timer1l      (uint16 LE; raw 16-bit latch; jsbeeb needs latch*2)
 *   [11-12] timer2c / 2  (uint16 LE)
 *   [13-14] timer2l      (uint16 LE)
 *   [15]    ACR
 *   [16]    PCR
 *   [17]    IFR
 *   [18]    IER
 *   [19]    timer1hasshot
 *   [20]    timer2hasshot
 *   [21]    IC32State    (sys VIA only, absent for user VIA)
 */
function convertViaChunk(data) {
    const view = new DataView(data.buffer, data.byteOffset);
    const viaType = data[0];

    // BeebEm saves timer counters as counter/2 and loads them as file*2.
    // jsbeeb stores timer values in 2x peripheral cycles (same as BeebEm's internal),
    // so: jsbeeb_t1c = file_t1c * 2, jsbeeb_t1l = file_t1l * 2.
    const t1c = view.getUint16(7, true) * 2;
    const t1l = view.getUint16(9, true) * 2;
    const t2c = view.getUint16(11, true) * 2;
    const t2l = view.getUint16(13, true) * 2;

    const acr = data[15];
    const pcr = data[16];
    const ifr = data[17];
    const ier = data[18];

    // Derive CA2/CB2 from PCR, matching BeebEm's LoadViaUEF
    const ca2 = (pcr & 0x0e) === 0x0e;
    const cb2 = (pcr & 0xe0) === 0xe0;
    const ic32 = viaType === 0 && data.length > 21 ? data[21] : undefined;

    const result = {
        ora: data[3],
        orb: data[1],
        ira: data[4],
        irb: data[2],
        ddra: data[6],
        ddrb: data[5],
        sr: 0,
        acr,
        pcr,
        ifr,
        ier,
        t1l,
        t2l,
        t1c,
        t2c,
        t1hit: !!data[19],
        t2hit: !!data[20],
        portapins: 0xff,
        portbpins: 0xff,
        ca1: false,
        ca2,
        cb1: false,
        cb2,
        justhit: 0,
        t1_pb7: (data[1] >> 7) & 1,
        lastPolltime: 0,
        taskOffset: 1,
    };
    if (ic32 !== undefined) {
        result.IC32 = ic32;
        result.capsLockLight = !(ic32 & 0x40);
        result.shiftLockLight = !(ic32 & 0x80);
    }
    return { viaType, state: result };
}

/**
 * Convert BeebEm UEF sound chunk (0x046B) to jsbeeb sound chip state.
 *
 * SaveSoundUEF layout (byte offsets within the chunk):
 *   [0-1]  ToneFreq[2]   (uint16 LE) → SN76489 tone channel 0 period
 *   [2-3]  ToneFreq[1]   (uint16 LE) → SN76489 tone channel 1 period
 *   [4-5]  ToneFreq[0]   (uint16 LE) → SN76489 tone channel 2 period
 *   [6]    RealVolumes[3] → tone channel 0 volume register (0=loud, 15=silent)
 *   [7]    RealVolumes[2] → tone channel 1 volume register
 *   [8]    RealVolumes[1] → tone channel 2 volume register
 *   [9]    Noise          = (Noise.Freq | (Noise.FB << 2)) → noise register bits 0-2
 *   [10]   RealVolumes[0] → noise channel volume register
 *   [11]   LastToneFreqSet (ignored)
 *   [12+]  GenIndex[0..3] (ignored)
 */
function convertSoundChunk(data) {
    const registers = new Uint16Array(4);
    const counter = new Float32Array(4);
    const outputBit = [false, false, false, false];
    const volume = new Float32Array(4);

    if (data && data.length >= 11) {
        const view = new DataView(data.buffer, data.byteOffset);
        // BeebEm's ToneFreq array is indexed in reverse relative to SN76489 channels:
        // ToneFreq[2] → SN76489 channel 0, ToneFreq[1] → channel 1, ToneFreq[0] → channel 2.
        // Similarly, RealVolumes[3,2,1,0] map to channels [0,1,2,noise].
        registers[0] = view.getUint16(0, true); // ToneFreq[2] → ch 0
        registers[1] = view.getUint16(2, true); // ToneFreq[1] → ch 1
        registers[2] = view.getUint16(4, true); // ToneFreq[0] → ch 2
        registers[3] = data[9] & 0x07; // noise register

        const vol0 = data[6] & 0x0f; // channel 0 volume
        const vol1 = data[7] & 0x0f; // channel 1 volume
        const vol2 = data[8] & 0x0f; // channel 2 volume
        const vol3 = data[10] & 0x0f; // noise volume

        volume[0] = volumeTable[vol0];
        volume[1] = volumeTable[vol1];
        volume[2] = volumeTable[vol2];
        volume[3] = volumeTable[vol3];

        // Approximate outputBit from volume: if a channel is silent (volume register = 15),
        // its output bit is off. Not cycle-accurate but produces a reasonable initial state.
        outputBit[0] = vol0 !== 15;
        outputBit[1] = vol1 !== 15;
        outputBit[2] = vol2 !== 15;
        outputBit[3] = vol3 !== 15;
    }

    return {
        registers,
        counter,
        outputBit,
        volume,
        lfsr: 1 << 14,
        latchedRegister: 0,
        residual: 0,
        sineOn: false,
        sineStep: 0,
        sineTime: 0,
    };
}

/**
 * Default jsbeeb VIA state used when no VIA chunk is present.
 * @param {number|undefined} ic32 - IC32 value (sys VIA only)
 */
function defaultViaState(ic32) {
    const result = {
        ora: 0xff,
        orb: 0xff,
        ira: 0xff,
        irb: 0xff,
        ddra: 0x00,
        ddrb: 0x00,
        sr: 0,
        acr: 0x00,
        pcr: 0x00,
        ifr: 0x00,
        ier: 0x80,
        t1l: 0x1fffe,
        t2l: 0x1fffe,
        t1c: 0x1fffe,
        t2c: 0x1fffe,
        t1hit: true,
        t2hit: true,
        portapins: 0xff,
        portbpins: 0xff,
        ca1: false,
        ca2: false,
        cb1: false,
        cb2: false,
        justhit: 0,
        t1_pb7: 1,
        lastPolltime: 0,
        taskOffset: 1,
    };
    if (ic32 !== undefined) {
        result.IC32 = ic32;
        result.capsLockLight = !(ic32 & 0x40);
        result.shiftLockLight = !(ic32 & 0x80);
    }
    return result;
}

/**
 * Parse a BeebEm UEF save state into a jsbeeb snapshot object.
 * @param {ArrayBuffer} buffer
 * @returns {object} jsbeeb snapshot
 */
export function parseUefSnapshot(buffer) {
    if (buffer.byteLength < 14) throw new Error("File too small to be a BeebEm UEF save state");
    if (!isUefSnapshot(buffer)) throw new Error("Not a BeebEm UEF save state (missing 0x046C chunk)");

    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const chunks = parseChunks(bytes, view);

    // Validate that required chunks are present
    if (!chunks.has(ChunkId.BeebEmID)) throw new Error("Truncated BeebEm UEF save state (missing BeebEmID chunk)");
    if (!chunks.has(ChunkId.Cpu6502)) throw new Error("BeebEm UEF save state missing CPU chunk (0x0460)");
    if (!chunks.has(ChunkId.MainRam)) throw new Error("BeebEm UEF save state missing main RAM chunk (0x0462)");

    // ── Model (from EmuState chunk 0x046A) ──────────────────────────────
    // BeebEm Model enum: 0=B, 1=IntegraB, 2=BPlus, 3=Master128, 4=MasterET
    let modelName = "B";
    if (chunks.has(ChunkId.EmuState)) {
        const emuData = chunks.get(ChunkId.EmuState)[0];
        const machineType = emuData[0];
        if (machineType === 3 || machineType === 4) {
            modelName = "Master";
        } else if (machineType === 2) {
            modelName = "B"; // jsbeeb has no B+ model; BBC B is the closest match
        }
        // 0=B, 1=IntegraB → both treated as "B"
    }

    // ── CPU (chunk 0x0460) ──────────────────────────────────────────────
    // Layout: uint16 PC, uint8 A, X, Y, SP, PSR, uint32 TotalCycles(ignored),
    //         uint8 intStatus, uint8 NMIStatus, uint8 NMILock(ignored), uint16 padding
    let cpuState = { a: 0, x: 0, y: 0, flags: 0x30, s: 0xff, pc: 0, nmi: 0, interrupt: 0, fe30: 0, fe34: 0 };
    if (chunks.has(ChunkId.Cpu6502)) {
        const d = chunks.get(ChunkId.Cpu6502)[0];
        const v = new DataView(d.buffer, d.byteOffset);
        cpuState.pc = v.getUint16(0, true);
        cpuState.a = d[2];
        cpuState.x = d[3];
        cpuState.y = d[4];
        cpuState.s = d[5];
        cpuState.flags = d[6];
        // bytes 7-10: TotalCycles (uint32) - ignored
        cpuState.interrupt = d[11]; // intStatus
        cpuState.nmi = d[12]; // NMIStatus
        // byte 13: NMILock - ignored
    }

    // ── ROM registers (chunk 0x0461) ────────────────────────────────────
    // Layout: uint8 PagedRomReg, uint8 ACCCON  (and more for non-B models)
    if (chunks.has(ChunkId.RomRegs)) {
        const d = chunks.get(ChunkId.RomRegs)[0];
        cpuState.fe30 = d[0] & 0x0f; // PagedRomReg: low nibble = ROM bank select
        cpuState.fe34 = d[1]; // ACCCON
    }

    // ── RAM ─────────────────────────────────────────────────────────────
    // jsbeeb snapshot.state.ram is 128 KB (ramRomOs up to romOffset).
    // Main RAM (chunk 0x0462): 32 KB at offset 0.
    const ram = new Uint8Array(128 * 1024);
    if (chunks.has(ChunkId.MainRam)) {
        const mainRam = chunks.get(ChunkId.MainRam)[0];
        // Defensive: chunk is defined as exactly 32 KB; clamp in case of a malformed file
        ram.set(mainRam.slice(0, Math.min(32768, mainRam.length)));
    }

    // ── Shadow RAM (chunk 0x0463, Master/B+) ─────────────────────────────
    // BeebEm saves 32 KB (full shadow bank). jsbeeb's LYNNE region is 20 KB
    // at ram[0xB000-0xFFFF], covering addresses 0x3000-0x7FFF when ACCCON X bit is set.
    // See 6502.js writeAcccon: memLook[i] = bitX ? 0x8000 : 0 for pages 0x30-0x7F.
    if (chunks.has(ChunkId.ShadowRam)) {
        const shadowData = chunks.get(ChunkId.ShadowRam)[0];
        if (shadowData.length >= 0x8000) {
            // Full 32 KB shadow bank - extract LYNNE region (file offsets 0x3000-0x7FFF)
            ram.set(shadowData.slice(0x3000, 0x8000), 0xb000);
        } else if (shadowData.length >= 0x5000) {
            // 20 KB LYNNE-only dump
            ram.set(shadowData.slice(0, 0x5000), 0xb000);
        }
    }

    // ── Private RAM (chunk 0x0464, Master) ──────────────────────────────
    // 12 KB: 4 KB ANDY (ram[0x8000-0x8FFF]) + 8 KB HAZEL (ram[0x9000-0xAFFF]).
    if (chunks.has(ChunkId.PrivateRam)) {
        const privData = chunks.get(ChunkId.PrivateRam)[0];
        ram.set(privData.slice(0, Math.min(0x3000, privData.length)), 0x8000);
    }

    // ── Sideways RAM (chunk 0x0466) ─────────────────────────────────────
    // Each chunk: uint8 bank_number + 16384 bytes of data.
    // Build a 256 KB roms array if any sideways RAM banks are present.
    let roms = null;
    if (chunks.has(ChunkId.SwRam)) {
        roms = new Uint8Array(16 * 16384);
        for (const d of chunks.get(ChunkId.SwRam)) {
            if (d.length >= 1 + 16384) {
                const bank = d[0] & 0x0f; // mask to 0-15 to prevent out-of-bounds writes
                roms.set(d.slice(1, 1 + 16384), bank * 16384);
            }
        }
    }

    // ── VIA (chunk 0x0467, one per VIA) ─────────────────────────────────
    // sysvia default: IC32 = 0xff (all outputs open), keyboard not scanning
    let sysvia = defaultViaState(0xff);
    let uservia = defaultViaState(undefined);
    if (chunks.has(ChunkId.Via)) {
        for (const d of chunks.get(ChunkId.Via)) {
            const { viaType, state } = convertViaChunk(d);
            if (viaType === 0) sysvia = state;
            else uservia = state;
        }
    }

    // ── Video (chunk 0x0468) ─────────────────────────────────────────────
    // Layout: 18 CRTC regs, 1 ULA ctrl, 16 ULA palette (each ^ 7 to decode)
    let ulaControl = 0x9c; // mode 7 (sensible default)
    let ulaPalette = new Uint8Array(16);
    let crtcRegs = new Uint8Array(18);
    if (chunks.has(ChunkId.Video)) {
        const d = chunks.get(ChunkId.Video)[0];
        if (d.length >= 35) {
            crtcRegs = d.slice(0, 18);
            ulaControl = d[18];
            // BeebEm stores palette as actual_value ^ 7, so read back with ^ 7
            for (let i = 0; i < 16; i++) ulaPalette[i] = d[19 + i] ^ 7;
        }
    }
    const video = buildVideoState(ulaControl, ulaPalette, crtcRegs);

    // ── Sound (chunk 0x046B) ─────────────────────────────────────────────
    const soundData = chunks.has(ChunkId.Sound) ? chunks.get(ChunkId.Sound)[0] : null;
    const soundChip = convertSoundChunk(soundData);

    return buildSnapshot("beebem-uef", modelName, cpuState, ram, roms, sysvia, uservia, video, soundChip);
}
