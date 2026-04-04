"use strict";

// Shared helpers for snapshot importers (bem-snapshot.js, uef-snapshot.js).
// Contains volume table, default peripheral state, video state builder,
// and the common snapshot envelope that wraps per-format parsed state.

// Volume lookup table matching soundchip.js
export const volumeTable = new Float32Array(16);
(() => {
    let f = 1.0;
    for (let i = 0; i < 15; ++i) {
        volumeTable[i] = f / 4;
        f *= Math.pow(10, -0.1);
    }
    volumeTable[15] = 0;
})();

export const DefaultAcia = {
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

export const DefaultAdc = { status: 0x40, low: 0x00, high: 0x00, taskOffset: null };

/**
 * Build jsbeeb video state from parsed CRTC, ULA, and palette data.
 * @param {number} ulaControl - VideoULA control register
 * @param {Uint8Array} ulaPalette - 16-entry palette (physical colour indices)
 * @param {Uint8Array} crtcRegs - CRTC registers (at least 18 bytes)
 * @param {Int32Array|null} [nulaCollook] - NULA colour lookup (16 ABGR entries), or null for default BBC palette
 * @param {object|null} [crtcCounters] - CRTC counter state {hc, vc, sc, ma, maback}, or null for defaults
 */
export function buildVideoState(ulaControl, ulaPalette, crtcRegs, nulaCollook, crtcCounters) {
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

/**
 * Build a jsbeeb snapshot envelope from parsed emulator components.
 * @param {string} importedFrom - source identifier (e.g. "b-em", "beebem-uef")
 * @param {string} modelName - jsbeeb model name/synonym
 * @param {object} cpuState - parsed CPU state {a, x, y, flags, s, pc, nmi, fe30, fe34}
 * @param {Uint8Array} ram - 128KB RAM array
 * @param {Uint8Array|null} roms - 256KB sideways ROM/RAM array, or null
 * @param {object} sysvia - jsbeeb sys VIA state
 * @param {object} uservia - jsbeeb user VIA state
 * @param {object} video - jsbeeb video state (from buildVideoState)
 * @param {object} soundChip - jsbeeb sound chip state
 */
export function buildSnapshot(importedFrom, modelName, cpuState, ram, roms, sysvia, uservia, video, soundChip) {
    return {
        format: "jsbeeb-snapshot",
        version: 2,
        model: modelName,
        timestamp: new Date().toISOString(),
        importedFrom,
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
            ...(roms instanceof Uint8Array ? { roms } : {}),
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
