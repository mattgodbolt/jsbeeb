"use strict";
import { decompress } from "./utils.js";

// B-em snapshot format parser (versions 1 and 3).
// v1 (BEMSNAP1): Fixed-size 327,885 byte packed struct. Reference: beebjit state.c
// v3 (BEMSNAP3): Section-based with key+size headers, zlib-compressed memory. Reference: b-em savestate.c

const BemV1Size = 327885;

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

function convertViaState(bemVia, ic32) {
    const result = {
        ora: bemVia.ora,
        orb: bemVia.orb,
        ira: bemVia.ira,
        irb: bemVia.irb,
        ddra: bemVia.ddra,
        ddrb: bemVia.ddrb,
        sr: bemVia.sr,
        acr: bemVia.acr,
        pcr: bemVia.pcr,
        ifr: bemVia.ifr,
        ier: bemVia.ier,
        t1l: bemVia.t1l,
        t2l: bemVia.t2l,
        t1c: bemVia.t1c,
        t2c: bemVia.t2c,
        t1hit: !!bemVia.t1hit,
        t2hit: !!bemVia.t2hit,
        portapins: 0xff,
        portbpins: 0xff,
        ca1: !!bemVia.ca1,
        ca2: !!bemVia.ca2,
        cb1: false,
        cb2: false,
        justhit: 0,
        t1_pb7: (bemVia.orb >> 7) & 1,
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

// Volume lookup table matching soundchip.js
const volumeTable = new Float32Array(16);
(() => {
    let f = 1.0;
    for (let i = 0; i < 15; ++i) {
        volumeTable[i] = f / 4;
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;
})();

function convertSoundState(snLatch, snCount, snStat, snVol, snNoise, snShift) {
    const registers = new Uint16Array(4);
    const counter = new Float32Array(4);
    const outputBit = [false, false, false, false];
    const volume = new Float32Array(4);

    for (let i = 0; i < 4; ++i) {
        const snChannel = 3 - i;
        let period = snLatch[snChannel] >> 6;
        let count = snCount[snChannel] >> 6;
        if (i === 3) {
            period >>= 1;
            count >>= 1;
        }
        registers[i] = period;
        counter[i] = count;
        outputBit[i] = snStat[snChannel] < 16;
        volume[i] = volumeTable[snVol[snChannel] & 0x0f];
    }
    registers[3] = snNoise & 0x07;

    return {
        registers,
        counter,
        outputBit,
        volume,
        lfsr: snShift,
        latchedRegister: 0,
        residual: 0,
        sineOn: false,
        sineStep: 0,
        sineTime: 0,
    };
}

function buildVideoState(ulaControl, ulaPalette, crtcRegs, nulaCollook, crtcCounters) {
    const regs = new Uint8Array(32);
    regs.set(crtcRegs.slice(0, 18));
    const actualPal = new Uint8Array(16);
    for (let i = 0; i < 16; i++) actualPal[i] = ulaPalette[i] & 0x0f;

    // Use NULA collook if provided, otherwise use default BBC palette
    const collook =
        nulaCollook ||
        new Int32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff, 0xff000000,
            0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
        ]);

    // Compute ulaPal from actualPal + collook, matching jsbeeb's Ula._recomputeUlaPal
    const flashEnabled = !!(ulaControl & 1);
    const defaultFlash = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const flash = defaultFlash;
    const ulaPal = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
        const palVal = actualPal[i];
        let colour = collook[(palVal & 0xf) ^ 7];
        if (palVal & 8 && flashEnabled && flash[(palVal & 7) ^ 7]) {
            colour = collook[palVal & 0xf];
        }
        ulaPal[i] = colour;
    }

    return {
        regs,
        bitmapX: 0,
        bitmapY: 0,
        oddClock: false,
        frameCount: 0,
        doEvenFrameLogic: false,
        isEvenRender: true,
        lastRenderWasEven: false,
        firstScanline: true,
        inHSync: false,
        inVSync: false,
        hadVSyncThisRow: false,
        checkVertAdjust: false,
        endOfMainLatched: false,
        endOfVertAdjustLatched: false,
        endOfFrameLatched: false,
        inVertAdjust: false,
        inDummyRaster: false,
        hpulseWidth: regs[3] & 0x0f,
        vpulseWidth: (regs[3] & 0xf0) >>> 4,
        hpulseCounter: 0,
        vpulseCounter: 0,
        dispEnabled: 0x3f,
        horizCounter: crtcCounters ? crtcCounters.hc : 0,
        vertCounter: crtcCounters ? crtcCounters.vc : 0,
        scanlineCounter: crtcCounters ? crtcCounters.sc : 0,
        vertAdjustCounter: 0,
        addr: crtcCounters ? crtcCounters.ma : (regs[13] | (regs[12] << 8)) & 0x3fff,
        lineStartAddr: crtcCounters ? crtcCounters.maback : (regs[13] | (regs[12] << 8)) & 0x3fff,
        nextLineStartAddr: crtcCounters ? crtcCounters.maback : (regs[13] | (regs[12] << 8)) & 0x3fff,
        ulactrl: ulaControl,
        pixelsPerChar: ulaControl & 0x10 ? 8 : 16,
        halfClock: !(ulaControl & 0x10),
        ulaMode: (ulaControl >>> 2) & 3,
        teletextMode: !!(ulaControl & 2),
        displayEnableSkew: Math.min((regs[8] & 0x30) >>> 4, 2),
        ulaPal,
        actualPal,
        cursorOn: false,
        cursorOff: false,
        cursorOnThisFrame: false,
        cursorDrawIndex: 0,
        cursorPos: (regs[15] | (regs[14] << 8)) & 0x3fff,
        interlacedSyncAndVideo: (regs[8] & 3) === 3,
        screenSubtract: 0,
        ula: {
            collook: collook.slice(),
            flash: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]),
            paletteWriteFlag: false,
            paletteFirstByte: 0,
            paletteMode: 0,
            horizontalOffset: 0,
            leftBlank: 0,
            disabled: false,
            attributeMode: 0,
            attributeText: 0,
        },
        crtc: { curReg: 0 },
        teletext: {
            prevCol: 0,
            col: 7,
            bg: 0,
            sep: false,
            dbl: false,
            oldDbl: false,
            secondHalfOfDouble: false,
            wasDbl: false,
            gfx: false,
            flash: false,
            flashOn: false,
            flashTime: 0,
            heldChar: 0,
            holdChar: false,
            dataQueue: [0, 0, 0, 0],
            scanlineCounter: 0,
            levelDEW: false,
            levelDISPTMG: false,
            levelRA0: false,
            nextGlyphs: "normal",
            curGlyphs: "normal",
            heldGlyphs: "normal",
        },
    };
}

const DefaultAcia = {
    sr: 0x02,
    cr: 0x00,
    dr: 0x00,
    rs423Selected: false,
    motorOn: false,
    tapeCarrierCount: 0,
    tapeDcdLineLevel: false,
    hadDcdHigh: false,
    serialReceiveRate: 19200,
    serialReceiveCyclesPerByte: 0,
    txCompleteTaskOffset: null,
    runTapeTaskOffset: null,
    runRs423TaskOffset: null,
};

const DefaultAdc = { status: 0x40, low: 0x00, high: 0x00, taskOffset: null };

function buildSnapshot(modelName, cpuState, ram, roms, sysvia, uservia, video, soundChip) {
    return {
        format: "jsbeeb-snapshot",
        version: 1,
        model: modelName,
        timestamp: new Date().toISOString(),
        importedFrom: "b-em",
        state: {
            a: cpuState.a,
            x: cpuState.x,
            y: cpuState.y,
            s: cpuState.s,
            pc: cpuState.pc,
            p: cpuState.flags | 0x30,
            nmiLevel: !!cpuState.nmi,
            nmiEdge: false,
            halted: false,
            takeInt: false,
            romsel: cpuState.fe30 ?? 0,
            acccon: cpuState.fe34 ?? 0,
            videoDisplayPage: 0,
            currentCycles: 0,
            targetCycles: 0,
            cycleSeconds: 0,
            peripheralCycles: 0,
            videoCycles: 0,
            music5000PageSel: 0,
            ram,
            roms,
            scheduler: { epoch: 0 },
            sysvia,
            uservia,
            video,
            soundChip,
            acia: { ...DefaultAcia },
            adc: { ...DefaultAdc },
        },
    };
}

// ── V1 parser (BEMSNAP1, fixed struct) ──────────────────────────────

function parseBemV1(buffer) {
    if (buffer.byteLength !== BemV1Size) {
        throw new Error(`Invalid BEM v1 snapshot size: expected ${BemV1Size}, got ${buffer.byteLength}`);
    }
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    const bemModel = bytes[V1Off.model];
    if (bemModel !== 3 && bemModel !== 4) {
        throw new Error(`Unsupported BEM v1 model: ${bemModel} (only BBC Model B supported)`);
    }

    const cpuState = {
        ...readCpuFromBytes(bytes.slice(V1Off.a)),
        fe30: bytes[V1Off.fe30],
        fe34: bytes[V1Off.fe34],
    };

    const ram = new Uint8Array(128 * 1024);
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
    const snLatch = [],
        snCount = [],
        snStat = [],
        snVol = [];
    for (let i = 0; i < 4; i++) {
        snLatch.push(view.getUint32(soundOff + i * 4, true));
        snCount.push(view.getUint32(soundOff + 16 + i * 4, true));
        snStat.push(view.getUint32(soundOff + 32 + i * 4, true));
        snVol.push(bytes[soundOff + 48 + i]);
    }
    const snNoise = bytes[soundOff + 52];
    const snShift = view.getUint16(soundOff + 53, true);

    return buildSnapshot(
        "B",
        cpuState,
        ram,
        roms,
        convertViaState(sysVia, sysViaIC32),
        convertViaState(userVia),
        buildVideoState(ulaControl, ulaPalette, crtcRegs),
        convertSoundState(snLatch, snCount, snStat, snVol, snNoise, snShift),
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
    if (sections["m"]) {
        const pos = { offset: 0 };
        const data = sections["m"].data;
        readVar(data, pos); // curmodel index (skip)
        const name = readString(data, pos);
        if (name.includes("Master")) {
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
    const ram = new Uint8Array(128 * 1024);
    let roms = null;
    const memSection = sections["M"];
    if (memSection) {
        // Memory is zlib-compressed; decompression is async.
        // Decompressed layout: 2 bytes (fe30, fe34) + 64KB RAM + 256KB ROM
        return decompress(memSection.data, "deflate").then((memData) => {
            cpuState.fe30 = memData[0];
            cpuState.fe34 = memData[1];
            const ramStart = 2;
            const ramSize = 64 * 1024;
            ram.set(memData.slice(ramStart, ramStart + ramSize));
            const romStart = ramStart + ramSize;
            if (memData.length > romStart) {
                roms = memData.slice(romStart, romStart + 262144);
            }
            return finishV3Parse(modelName, cpuState, ram, roms, sections);
        });
    }
    return finishV3Parse(modelName, cpuState, ram, roms, sections);
}

function finishV3Parse(modelName, cpuState, ram, roms, sections) {
    // Parse system VIA
    let sysvia = convertViaState(
        {
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
        },
        0,
    );
    if (sections["S"]) {
        const data = sections["S"].data;
        const via = readViaFromBytes(data, 0);
        const ic32 = data.length > ViaDataSize ? data[ViaDataSize] : 0;
        sysvia = convertViaState(via, ic32);
    }

    // Parse user VIA
    let uservia = convertViaState({
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
    if (sections["U"]) {
        uservia = convertViaState(readViaFromBytes(sections["U"].data, 0));
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

    // Parse sound
    let soundChip = convertSoundState([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], 0, 1 << 14);
    if (sections["s"]) {
        const data = sections["s"].data;
        const view = new DataView(data.buffer, data.byteOffset);
        const snLatch = [],
            snCount = [],
            snStat = [],
            snVol = [];
        for (let i = 0; i < 4; i++) {
            snLatch.push(view.getUint32(i * 4, true));
            snCount.push(view.getUint32(16 + i * 4, true));
            snStat.push(view.getUint32(32 + i * 4, true));
            snVol.push(data[48 + i]);
        }
        const snNoise = data[52];
        const snShift = view.getUint16(53, true);
        soundChip = convertSoundState(snLatch, snCount, snStat, snVol, snNoise, snShift);
    }

    return buildSnapshot(
        modelName,
        cpuState,
        ram,
        roms,
        sysvia,
        uservia,
        buildVideoState(ulaControl, ulaPalette, crtcRegs, nulaCollook, crtcCounters),
        soundChip,
    );
}
