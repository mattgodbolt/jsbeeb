"use strict";

// BEMv2.x (BEMSNAP1) snapshot format parser.
// Reference: beebjit state.c (struct bem_v2x).
// Total size: 327,885 bytes, packed binary struct.

const BemSnapshotSize = 327885;
const BemSignature = "BEMSNAP1";

// Struct offsets (manually computed from the packed C struct)
const Off = {
    signature: 0, // 8 bytes
    model: 8, // 1 byte
    a: 9,
    x: 10,
    y: 11,
    flags: 12,
    s: 13,
    pc: 14, // 2 bytes (uint16_t, little-endian)
    nmi: 16,
    interrupt: 17,
    cycles: 18, // 4 bytes (uint32_t)
    fe30: 22,
    fe34: 23,
    ram: 24, // 64KB
    rom: 24 + 65536, // 256KB
    // System VIA starts after ROM
    sysvia: 24 + 65536 + 262144, // = 327704
};

// VIA struct within the snapshot (23 bytes per VIA in the packed struct)
// Each VIA: ora, orb, ira, irb, unused1, unused2, ddra, ddrb, sr, acr, pcr, ifr, ier,
//           t1l(4), t2l(4), t1c(4), t2c(4), t1hit, t2hit, ca1, ca2
// SysVia has IC32 at the end (1 extra byte)
function readVia(view, offset) {
    return {
        ora: view.getUint8(offset),
        orb: view.getUint8(offset + 1),
        ira: view.getUint8(offset + 2),
        irb: view.getUint8(offset + 3),
        // offset+4, offset+5 are unused
        ddra: view.getUint8(offset + 6),
        ddrb: view.getUint8(offset + 7),
        sr: view.getUint8(offset + 8),
        acr: view.getUint8(offset + 9),
        pcr: view.getUint8(offset + 10),
        ifr: view.getUint8(offset + 11),
        ier: view.getUint8(offset + 12),
        t1l: view.getInt32(offset + 13, true),
        t2l: view.getInt32(offset + 17, true),
        t1c: view.getInt32(offset + 21, true),
        t2c: view.getInt32(offset + 25, true),
        t1hit: view.getUint8(offset + 29),
        t2hit: view.getUint8(offset + 30),
        ca1: view.getUint8(offset + 31),
        ca2: view.getUint8(offset + 32),
    };
}

/**
 * Check if an ArrayBuffer contains a BEMv2.x snapshot.
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
export function isBemSnapshot(buffer) {
    if (buffer.byteLength !== BemSnapshotSize) return false;
    const sig = new Uint8Array(buffer, 0, 8);
    return String.fromCharCode(...sig) === BemSignature;
}

/**
 * Parse a BEMv2.x snapshot into a jsbeeb snapshot object.
 * @param {ArrayBuffer} buffer - the raw .snp file contents
 * @returns {object} a jsbeeb snapshot object suitable for restoreSnapshot()
 */
export function parseBemSnapshot(buffer) {
    if (buffer.byteLength !== BemSnapshotSize) {
        throw new Error(`Invalid BEM snapshot size: expected ${BemSnapshotSize}, got ${buffer.byteLength}`);
    }

    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Verify signature
    const sig = String.fromCharCode(...bytes.slice(0, 8));
    if (sig !== BemSignature) {
        throw new Error(`Invalid BEM snapshot signature: "${sig}"`);
    }

    const bemModel = view.getUint8(Off.model);
    if (bemModel !== 3 && bemModel !== 4) {
        throw new Error(`Unsupported BEM model: ${bemModel} (only BBC Model B supported)`);
    }

    // CPU state
    const a = view.getUint8(Off.a);
    const x = view.getUint8(Off.x);
    const y = view.getUint8(Off.y);
    const flags = view.getUint8(Off.flags);
    const s = view.getUint8(Off.s);
    const pc = view.getUint16(Off.pc, true);
    const nmi = view.getUint8(Off.nmi);

    // Memory
    const ram = new Uint8Array(128 * 1024); // jsbeeb uses 128KB RAM array
    ram.set(bytes.slice(Off.ram, Off.ram + 65536)); // Copy 64KB into first 64KB

    // ROM bank select
    const fe30 = view.getUint8(Off.fe30);

    // ROMs: copy 256KB (16 banks of 16KB) into the right place
    // jsbeeb RAM array is 128KB, ROMs start after that, but we'll store them
    // separately and let the caller handle ROM loading
    const roms = bytes.slice(Off.rom, Off.rom + 262144);

    // System VIA
    const sysViaOff = Off.sysvia;
    const sysVia = readVia(view, sysViaOff);
    const sysViaIC32 = view.getUint8(sysViaOff + 33);

    // User VIA follows System VIA (sysvia is 34 bytes: 33 data + IC32)
    const userViaOff = sysViaOff + 34;
    const userVia = readVia(view, userViaOff);

    // Video ULA (follows user VIA, 33 bytes)
    const ulaOff = userViaOff + 33;
    const ulaControl = view.getUint8(ulaOff);
    const ulaPalette = bytes.slice(ulaOff + 1, ulaOff + 17);

    // CRTC (follows ULA palette)
    const crtcOff = ulaOff + 17;
    const crtcRegs = bytes.slice(crtcOff, crtcOff + 18);

    // Sound (sn76489) - at the end of the struct
    // After CRTC: vc(1) + sc(1) + hc(1) + ma_low(1) + ma_high(1) + maback_low(1) + maback_high(1)
    //           + scrx_low(1) + scrx_high(1) + scry_low(1) + scry_high(1) + oddclock(1) + vidclocks(4)
    const soundOff = crtcOff + 18 + 7 + 4 + 1 + 4; // regs + video state + oddclock + vidclocks
    // sn_latch[4] (uint32_t each), sn_count[4], sn_stat[4], sn_vol[4], sn_noise(1), sn_shift(2)

    // b-em stores channels in inverse order: channel 0 = noise, channel 3 = tone 0
    const registers = new Uint16Array(4);
    const counter = new Float32Array(4);
    const outputBit = [false, false, false, false];
    const volume = new Float32Array(4);

    // Volume lookup table (matching soundchip.js)
    const volumeTable = new Float32Array(16);
    let f = 1.0;
    for (let i = 0; i < 15; ++i) {
        volumeTable[i] = f / 4;
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;

    for (let i = 0; i < 4; ++i) {
        const snChannel = 3 - i;
        let period = view.getUint32(soundOff + snChannel * 4, true) >> 6;
        let count = view.getUint32(soundOff + 16 + snChannel * 4, true) >> 6;
        const stat = view.getUint32(soundOff + 32 + snChannel * 4, true);
        const vol = view.getUint8(soundOff + 48 + snChannel);

        // b-em runs noise rng twice as fast; halve timings for noise channel
        if (i === 3) {
            period >>= 1;
            count >>= 1;
        }
        registers[i] = period;
        counter[i] = count;
        outputBit[i] = stat < 16;
        volume[i] = volumeTable[vol & 0x0f];
    }

    const snNoise = view.getUint8(soundOff + 52);
    const snShift = view.getUint16(soundOff + 53, true);

    // Build the noise register value from the BEM noise byte
    // BEM sn_noise: bit 2 = white noise flag, bits 0-1 = frequency select
    const noiseRegister = snNoise & 0x07;
    registers[3] = noiseRegister;

    // Convert BEM VIA timer values to jsbeeb format
    // BEM stores timer latches in 2MHz ticks; jsbeeb uses the same doubled format internally
    // so values can be used as-is for t1c/t2c, but latches need to stay as-is
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
            // Approximate PB7 from ORB bit 7 (BEM doesn't save it separately)
            t1_pb7: (bemVia.orb >> 7) & 1,
            lastPolltime: 0,
            taskOffset: 1, // Schedule immediately to catch up
        };
        if (ic32 !== undefined) {
            result.IC32 = ic32;
            result.capsLockLight = !(ic32 & 0x40);
            result.shiftLockLight = !(ic32 & 0x80);
        }
        return result;
    }

    // Build ULA palette in jsbeeb format
    // BEM palette bytes are written via &FE21: high nibble = logical colour, low nibble = physical colour
    const actualPal = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        actualPal[i] = ulaPalette[i] & 0x0f;
    }

    // Build CRTC state
    const regs = new Uint8Array(32);
    for (let i = 0; i < 18; i++) {
        regs[i] = crtcRegs[i];
    }

    // Determine jsbeeb model name
    const modelName = "B";

    return {
        format: "jsbeeb-snapshot",
        version: 1,
        model: modelName,
        timestamp: new Date().toISOString(),
        importedFrom: "BEMv2.x",
        state: {
            a,
            x,
            y,
            s,
            pc,
            p: flags | 0x30,
            nmiLevel: !!nmi,
            nmiEdge: false,
            halted: false,
            takeInt: false,
            romsel: fe30,
            acccon: 0,
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
            sysvia: convertViaState(sysVia, sysViaIC32),
            uservia: convertViaState(userVia),
            video: {
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
                horizCounter: 0,
                vertCounter: 0,
                scanlineCounter: 0,
                vertAdjustCounter: 0,
                addr: (regs[13] | (regs[12] << 8)) & 0x3fff,
                lineStartAddr: (regs[13] | (regs[12] << 8)) & 0x3fff,
                nextLineStartAddr: (regs[13] | (regs[12] << 8)) & 0x3fff,
                ulactrl: ulaControl,
                pixelsPerChar: ulaControl & 0x10 ? 8 : 16,
                halfClock: !(ulaControl & 0x10),
                ulaMode: (ulaControl >>> 2) & 3,
                teletextMode: !!(ulaControl & 2),
                displayEnableSkew: 0,
                // ulaPal will be rebuilt by ULA restore
                ulaPal: new Int32Array(16),
                actualPal,
                cursorOn: false,
                cursorOff: false,
                cursorOnThisFrame: false,
                cursorDrawIndex: 0,
                cursorPos: (regs[15] | (regs[14] << 8)) & 0x3fff,
                interlacedSyncAndVideo: false,
                screenSubtract: 0,
                ula: {
                    collook: new Int32Array([
                        0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
                        0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff,
                    ]),
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
            },
            soundChip: {
                registers,
                counter,
                outputBit,
                volume,
                lfsr: snShift,
                latchedRegister: 0,
                lastRunEpoch: 0,
                residual: 0,
                sineOn: false,
                sineStep: 0,
                sineTime: 0,
            },
            acia: {
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
            },
            adc: {
                status: 0x40,
                low: 0x00,
                high: 0x00,
                taskOffset: null,
            },
        },
    };
}
