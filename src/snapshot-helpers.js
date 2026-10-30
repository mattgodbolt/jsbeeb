// Shared helpers for snapshot importers (bem-snapshot.js, uef-snapshot.js): the jsbeeb state each
// chip's import ends in, and the common snapshot envelope that wraps per-format parsed state.

import { EVERYTHINGENABLED, Video } from "./video.js";

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
    serialTransmitRate: 19200,
    txCompleteTaskOffset: null,
    runTapeTaskOffset: null,
    runRs423TaskOffset: null,
};

const DefaultAdc = { status: 0x40, low: 0x00, high: 0x00, taskOffset: null };

const CrtcImportedRegisters = 18;
const CrtcAddress = 0;
const CrtcData = 1;
const UlaControl = 0;
const UlaPalette = 1;

/**
 * A jsbeeb VIA state from an imported VIA's registers and lines.
 * @param {{ora: number, orb: number, ira: number, irb: number, ddra: number, ddrb: number, sr: number, acr: number,
 *     pcr: number, ifr: number, ier: number, t1l: number, t2l: number, t1c: number, t2c: number,
 *     t1hit: number|boolean, t2hit: number|boolean, ca1: number|boolean, ca2: number|boolean, cb2?: boolean}} via
 *     timers in jsbeeb's units, twice the 1MHz count
 * @param {number|undefined} ic32 the system VIA's addressable latch; undefined for the user VIA
 */
export function importedViaState(via, ic32) {
    const state = {
        ora: via.ora,
        orb: via.orb,
        ira: via.ira,
        irb: via.irb,
        ddra: via.ddra,
        ddrb: via.ddrb,
        sr: via.sr,
        acr: via.acr,
        pcr: via.pcr,
        ifr: via.ifr,
        ier: via.ier,
        t1l: via.t1l,
        t2l: via.t2l,
        t1c: via.t1c,
        t2c: via.t2c,
        // A free-running timer 1 that has already hit would never interrupt again, the 100Hz tick among them.
        t1hit: via.acr & 0x40 ? false : !!via.t1hit,
        t2hit: !!via.t2hit,
        portapins: 0xff,
        portbpins: 0xff,
        ca1: !!via.ca1,
        ca2: !!via.ca2,
        cb1: false,
        cb2: !!via.cb2,
        justhit: 0,
        t1_pb7: (via.orb >> 7) & 1,
        lastPolltime: 0,
        taskOffset: 1,
    };
    if (ic32 === undefined) return state;
    return { ...state, IC32: ic32, capsLockLight: !(ic32 & 0x40), shiftLockLight: !(ic32 & 0x80) };
}

/**
 * A jsbeeb sound chip state from an imported chip's channels, in SN76489 order with noise last.
 * @param {{registers: Uint16Array, counter: Float32Array, outputBit: boolean[], volume: Float32Array}} channels
 * @param {number} lfsr the noise shift register
 */
export function importedSoundState({ registers, counter, outputBit, volume }, lfsr) {
    return {
        registers,
        counter,
        outputBit,
        volume,
        lfsr,
        latchedRegister: 0,
        residual: 0,
        sineOn: false,
        sineStep: 0,
        sineTime: 0,
    };
}

/**
 * Build jsbeeb video state from parsed CRTC, ULA and palette data, by writing them to a Video as the
 * guest would have.
 * @param {number} ulaControl - VideoULA control register
 * @param {Uint8Array} ulaPalette - 16-entry raw ULA palette register values (lower nibble of &FE21 writes)
 * @param {Uint8Array} crtcRegs - CRTC registers (at least 18 bytes)
 * @param {Int32Array|null} [nulaCollook] - NULA colour lookup (16 ABGR entries), or null for default BBC palette
 * @param {object|null} [crtcCounters] - CRTC counter state {hc, vc, sc, ma, maback}, or null for defaults
 */
export function buildVideoState(ulaControl, ulaPalette, crtcRegs, nulaCollook, crtcCounters) {
    const video = new Video(false, 0, () => {}, { hasVideoNula: true, drainKind: "js" });
    for (let reg = 0; reg < CrtcImportedRegisters; reg++) {
        video.crtc.write(CrtcAddress, reg);
        video.crtc.write(CrtcData, crtcRegs[reg]);
    }
    video.crtc.write(CrtcAddress, 0);
    if (nulaCollook) video.ula.collook.set(nulaCollook);
    video.ula.write(UlaControl, ulaControl);
    for (let i = 0; i < 16; i++) video.ula.write(UlaPalette, (i << 4) | (ulaPalette[i] & 0x0f));

    const startAddr = (video.regs[13] | (video.regs[12] << 8)) & 0x3fff;
    video.horizCounter = crtcCounters ? crtcCounters.hc : 0;
    video.vertCounter = crtcCounters ? crtcCounters.vc : 0;
    video.scanlineCounter = crtcCounters ? crtcCounters.sc : 0;
    video.addr = crtcCounters ? crtcCounters.ma : startAddr;
    video.lineStartAddr = crtcCounters ? crtcCounters.maback : startAddr;
    video.nextLineStartAddr = video.lineStartAddr;
    video.dispEnabled = EVERYTHINGENABLED;
    return video.snapshotState();
}

/**
 * Build a jsbeeb snapshot envelope from parsed emulator components.
 * @param {string} importedFrom - source identifier (e.g. "b-em", "beebem-uef")
 * @param {string} modelName - jsbeeb model name/synonym
 * @param {object} cpuState - parsed CPU state {a, x, y, flags, s, pc, nmi, fe30, fe34}
 * @param {Uint8Array} ram - 64KB RAM array
 * @param {Uint8Array|null} roms - 256KB sideways ROM/RAM array, or null
 * @param {object} sysvia - jsbeeb sys VIA state
 * @param {object} uservia - jsbeeb user VIA state
 * @param {object} video - jsbeeb video state (from buildVideoState)
 * @param {object} soundChip - jsbeeb sound chip state
 * @param {object|null} [tube] - jsbeeb tube state, or null if no co-processor was fitted
 */
export function buildSnapshot(
    importedFrom,
    modelName,
    cpuState,
    ram,
    roms,
    sysvia,
    uservia,
    video,
    soundChip,
    tube = null,
) {
    return {
        format: "jsbeeb-snapshot",
        version: 3,
        model: modelName,
        coProcessor: !!tube,
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
            ...(tube ? { tube } : {}),
        },
    };
}
