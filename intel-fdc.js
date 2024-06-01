// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502";
import { IbmDiscFormat } from "./disc";
// eslint-disable-next-line no-unused-vars
import { DiscDrive } from "./disc_drive";
import { hexbyte } from "./utils";

const Registers = {
    internalPointer: 0x00,
    internalCountMsbCopy: 0x00,
    internalParamCount: 0x01,
    internalSeekRetryCount: 0x01,
    internalParamDataMarker: 0x02,
    internalParam_5: 0x03,
    internalParam_4: 0x04,
    internalParam_3: 0x05,
    currentSector: 0x06,
    internalParam_2: 0x06,
    internalParam_1: 0x07,
    internalHeaderPointer: 0x08,
    internalMsCountHi: 0x08,
    internalMsCountLo: 0x09,
    internalSeekCount: 0x0a,
    internalIdSector: 0x0a,
    internalSeekTarget_1: 0x0b,
    internalDynamicDispatch: 0x0b,
    internalSeekTarget_2: 0x0c,
    internalIdTrack: 0x0c,
    headStepRate: 0x0d,
    headSettleTime: 0x0e,
    headLoadUnload: 0x0f,
    badTrack_1Drive_0: 0x10,
    badTrack_2Drive_0: 0x11,
    trackDrive_0: 0x12,
    internalCountLsb: 0x13,
    internalCountMsb: 0x14,
    internalDriveInCopy: 0x15,
    internalWriteRunData: 0x15,
    internalGap2Skip: 0x15,
    internalResult: 0x16,
    mode: 0x17,
    internalStatus: 0x17,
    badTrack_1Drive_1: 0x18,
    badTrack_2Drive_1: 0x19,
    trackDrive_1: 0x1a,
    internalDriveInLatched: 0x1b,
    internalIndexPulseCount: 0x1c,
    internalData: 0x1d,
    internalParameter: 0x1e,
    internalCommand: 0x1f,

    mmioDriveIn: 0x22,
    mmioDriveOut: 0x23,
    mmioClocks: 0x24,
    mmioData: 0x25,
};

const DriveOut = {
    select_1: 0x80,
    select_0: 0x40,
    side: 0x20,
    lowHeadCurrent: 0x10,
    loadHead: 0x08,
    direction: 0x04,
    step: 0x02,
    writeEnable: 0x01,
};

export class IntelFdc {
    static get NumRegisters() {
        return 32;
    }

    /**
     * @param {Cpu6502} cpu
     * @param {*} timing
     * @param {*} options
     */
    constructor(cpu, timing, options) {
        this._cpu = cpu;
        this._timing = timing;
        this._options = options;
        /** @type {DiscDrive[]} */
        this._drives = [];
        /** @type {DiscDrive} */
        this._currentDrive = null;

        this._paramCallback = 0;
        this._indexPulseCallback = 0;
        this._timerState = 0;
        this._callContext = 0;
        this._didSeekStop = false;

        this._regs = new Uint8Array(IntelFdc.NumRegisters);
        this._isResultReady = false;
        // Derived from one of the regs plus is_result_ready.
        this._status = 0;
        this._mmioData = 0;
        this._mmioClocks = 0;
        this._driveOut = 0;

        this._shiftRegister = 0;
        this._numShifts = 0;

        this._state = 0;
        this._stateCount = 0;
        this._stateIsIndexPulse = false;
        this._crc = 0;
        this._onDiscCrc = 0;
    }

    /**
     * @param {DiscDrive} drive0
     * @param {DiscDrive} drive1
     */
    setDrives(drive0, drive1) {
        this._drives = [drive0, drive1];
        const callback = (pulses, count) => this._pulsesCallback(pulses, count);
        drive0.setPulsesCallback(callback);
        drive1.setPulsesCallback(callback);
    }

    powerOnReset() {
        // The reset line does most things.
        this.reset();
        this._regs.fill(0);
        this._isResultReady = false;
        this._mmioData = 0;
        this._mmioClocks = 0;
        this._stateCount = 0;
        this._stateIsIndexPulse = false;
    }

    reset() {
        // Abort any in-progress command.
        this._commandAbort();
        this._clearCallbacks();
        // Deselect any drive; ensures spin-down.
        this._setDriveOut(0);
        // On a real machine, status appears to be cleared but result and data not.
        this._statusLower(this.internalStatus);
    }

    get internalStatus() {
        return this._regs[Registers.internalStatus];
    }

    /**
     * @param {Number} addr hardware address
     * @returns {Number} byte at the given hardware address
     */
    read(addr) {
        return addr & 0xff;
    }

    /**
     * @param {Number} addr hardware address
     * @param {Number} val byte to write
     */
    write(addr, val) {
        throw new Error(`Not supported: ${addr}=${val}`);
    }

    _pulsesCallback(pulses, count) {
        if (count !== 32) throw new Error("Expected FM pulses only");
        this._checkIndexPulse();

        // All writing occurs here.
        // NOTE: a nice 8271 quirk: if the write gate is open outside a command, it
        // still writes to disc, often effectively creating weak bits.
        if (this._driveOut & DriveOut.writeEnable) {
            const clocks = this._mmioClocks;
            const data = this._mmioData;
            const pulses = IbmDiscFormat.fmTo2usPulses(clocks, data);
            if (clocks !== 0xff && clocks !== IbmDiscFormat.markClockPattern)
                console.log(`8271: writing unusual clocks=${hexbyte(clocks)} data=${hexbyte(data)}`);
            this._currentDrive.writePulses(pulses);
        }
    }
}
