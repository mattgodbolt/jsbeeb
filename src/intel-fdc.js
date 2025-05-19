// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502.js";
// eslint-disable-next-line no-unused-vars
import { Disc, IbmDiscFormat } from "./disc.js";

// eslint-disable-next-line no-unused-vars
import { BaseDiscDrive, DiscDrive } from "./disc-drive.js";
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
import * as utils from "./utils.js";

// TODOs remaining for intel-fdc and related functionality
// - support loading other disc formats
// - support "writeback" to SSD (at least); tested with
//   - google drive - broken currently :'()
//   - download disc image DONE
// - ideally support "writeback" to high fidelity output formats
// - UI elements for visualisation

/**
 * Register indices.
 *
 * @readonly
 * @enum {Number}
 */
const Registers = Object.freeze({
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
});

/**
 * Drive output bitmask.
 *
 * @readonly
 * @enum {Number}
 */
const DriveOut = Object.freeze({
    select_1: 0x80,
    select_0: 0x40,
    side: 0x20,
    lowHeadCurrent: 0x10,
    loadHead: 0x08,
    direction: 0x04,
    step: 0x02,
    writeEnable: 0x01,
    selectFlags: 0xc0,
});

/**
 * Floppy disc controller mode.
 *
 * @readonly
 * @enum {Number}
 */
const FdcMode = Object.freeze({
    singleActuator: 0x02,
    noDma: 0x01,
});

/**
 * Register address.
 *
 * @readonly
 * @enum {Number}
 */
const Address = Object.freeze({
    // Read.
    status: 0,
    result: 1,
    unknown_read_2: 2,
    unknown_read_3: 3,

    // Write.
    command: 0,
    parameter: 1,
    reset: 2,

    // Read / write.
    data: 4,
});

/**
 * Result bitmask.
 *
 * @readonly
 * @enum {Number}
 */
const Result = Object.freeze({
    ok: 0x00,
    clockError: 0x08,
    lateDma: 0x0a,
    idCrcError: 0x0c,
    dataCrcError: 0x0e,
    driveNotReady: 0x10,
    writeProtected: 0x12,
    sectorNotFound: 0x18,
    flagDeletedData: 0x20,
});

/**
 * Command number.
 *
 * @readonly
 * @enum {Number}
 */
const Command = Object.freeze({
    scanData: 0,
    scanDataAndDeleted: 1,
    writeData: 2,
    writeDeletedData: 3,
    readData: 4,
    readDataAndDeleted: 5,
    readId: 6,
    verify: 7,
    format: 8,
    unused_9: 9,
    seek: 10,
    readDriveStatus: 11,
    unused_12: 12,
    specify: 13,
    writeSpecialRegister: 14,
    readSpecialRegister: 15,
});

/**
 * Status flags
 *
 * @readonly
 * @enum {Number}
 */
const StatusFlag = Object.freeze({
    busy: 0x80,
    commandFull: 0x40,
    paramFull: 0x20,
    resultReady: 0x10,
    nmi: 0x08,
    needData: 0x04,
});

/**
 * Parameter acceptance state machine.
 *
 * @readonly
 * @enum {Number}
 */
const ParamAccept = Object.freeze({
    none: 0,
    command: 1,
    specify: 2,
});

/**
 * Index pulse state machine.
 *
 * @readonly
 * @enum {Number}
 */
const IndexPulse = Object.freeze({
    none: 1,
    timeout: 2,
    spindown: 3,
    startReadId: 4,
    startFormat: 5,
    stopFormat: 6,
});

/**
 * Timer state machine.
 *
 * @readonly
 * @enum {Number}
 */
const TimerState = Object.freeze({
    none: 0,
    seekStep: 1,
    postSeek: 2,
});

/**
 * Overall state machine.
 *
 * @readonly
 * @enum {Number}
 */
const State = Object.freeze({
    null: 0,
    idle: 1,
    syncingForIdWait: 2,
    syncingForId: 3,
    checkIdMarker: 4,
    inId: 5,
    inIdCrc: 6,
    syncingForData: 7,
    checkDataMarker: 8,
    inData: 9,
    inDataCrc: 10,
    skipGap_2: 11,
    writeRun: 12,
    writeDataMark: 13,
    writeSectorData: 14,
    writeCrc_2: 15,
    writeCrc_3: 16,
    dynamicDispatch: 17,
    formatWriteIdMarker: 18,
    formatIdCrc_2: 19,
    formatIdCrc_3: 20,
    formatWriteDataMarker: 21,
    formatDataCrc_2: 22,
    formatDataCrc_3: 23,
    formatGap_4: 24,
});

/**
 * Callback state machine.
 *
 * @readonly
 * @enum {Number}
 */
const Call = Object.freeze({
    uninitialised: 0,
    unchanged: 1,
    seek: 2,
    readId: 3,
    read: 4,
    write: 5,
    format: 6,
    formatGap1OrGap3FFs: 7,
    formatGap1orGap300s: 8,
    formatGap2_FFs: 9,
    formatGap2_00s: 10,
    formatData: 11,
});

export class IntelFdc {
    static get NumRegisters() {
        return 32;
    }

    /**
     * @param {Cpu6502} cpu
     * @param {Scheduler} scheduler
     * @param {BaseDiscDrive[] | undefined} drives
     * @param {*} debugFlags
     */
    constructor(cpu, scheduler, drives, debugFlags) {
        this._cpu = cpu;
        if (drives) this._drives = drives;
        else this._drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];
        /** @type {BaseDiscDrive} */
        this._currentDrive = null;

        this._paramCallback = ParamAccept.none;
        this._indexPulseCallback = IndexPulse.none;
        this._timerState = TimerState.none;
        this._callContext = Call.uninitialised;
        this._didSeekStep = false;

        this._regs = new Uint8Array(IntelFdc.NumRegisters);
        this._isResultReady = false;
        // Derived from one of the regs plus _isResultReady.
        this._status = 0;
        this._mmioData = 0;
        this._mmioClocks = 0;
        this._driveOut = 0;

        this._shiftRegister = 0;
        this._numShifts = 0;

        this._state = State.null;
        this._stateCount = 0;
        this._stateIsIndexPulse = false;
        this._crc = 0;
        this._onDiscCrc = 0;

        this._logCommands = debugFlags ? !!debugFlags.logFdcCommands : false;
        this._logStateChanges = debugFlags ? !!debugFlags.logFdcStateChanges : false;

        this._timerTask = scheduler.newTask(() => this._timerFired());

        const callback = (pulses, count) => this._pulsesCallback(pulses, count);
        for (const drive of this._drives) drive.setPulsesCallback(callback);

        this.powerOnReset();
    }

    _commandAbort() {
        // If we're aborting a command in the middle of writing data, it usually
        // doesn't leave a clean byte end on the disc. This is not particularly
        // important to emulate at all, but it does help create new copy protection
        // schemes under emulation.
        if (this._driveOut & DriveOut.writeEnable) {
            this._currentDrive.writePulses(IbmDiscFormat.fmTo2usPulses(0xff, 0xff));
        }

        // Lower any NMI assertion. This is particularly important for error $0A,
        // aka. late DMA, which will abort the command while NMI is asserted. We
        // therefore need to de-assert NMI so that the NMI for command completion
        // isn't lost.
        // TODO(matt) - we don't model NMIs properly here, each device should have its own nmi line
        this._cpu.NMI(false);
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
        switch (addr & 0x07) {
            case Address.status:
                return this._status;
            case Address.result: {
                const result = this._result;
                this._resultConsumed();
                this._statusLower(StatusFlag.nmi);
                return result;
            }
            case Address.data:
            case Address.data + 1:
            case Address.data + 2:
            case Address.data + 3:
                this._statusLower(StatusFlag.needData | StatusFlag.nmi);
                return this._regs[Registers.internalData];
            // Register address 2 and 3 are not documented as having anything
            // wired up for reading, BUT on a model B, they appear to give the MSB and
            // LSB of the sector byte counter in internal registers 19 ($13) and 20 ($14).
            case Address.unknown_read_2:
                return this._regs[Registers.internalCountMsb];
            case Address.unknown_read_3:
                return this._regs[Registers.internalCountLsb];
            default:
                throw new Error(`"Unexpected read of addr ${utils.hexword(addr)}"`);
        }
    }

    _log(message) {
        console.log(`8271: ${message}`);
    }

    _logCommand(message) {
        if (this._logCommands) this._log(message);
    }

    /**
     * @param {Number} addr hardware address
     * @param {Number} val byte to write
     */
    write(addr, val) {
        switch (addr & 7) {
            case Address.command:
                this._commandWritten(val);
                break;
            case Address.parameter:
                this._paramWritten(val);
                break;
            case Address.data:
            case Address.data + 1:
            case Address.data + 2:
            case Address.data + 3:
                this._statusLower(StatusFlag.needData | StatusFlag.nmi);
                this._regs[Registers.internalData] = val;
                break;
            case Address.reset:
                //On a real 8271, crazy things happen if you write 2 or especially 4 to this register.
                if (val !== 0 && val !== 1) {
                    this._log("funky reset");
                }
                if (val === 1) {
                    this._logCommand("reset");
                    this.reset();
                }
                break;
            case 3:
            default:
                this._log(`Not supported: ${utils.hexword(addr)}=${utils.hexbyte(val)}`);
        }
    }

    _checkIndexPulse() {
        const wasIndexPulse = this._stateIsIndexPulse;
        this._stateIsIndexPulse = this._index;

        // Looking for pulse going high
        if (!this._stateIsIndexPulse || wasIndexPulse) return;

        switch (this._indexPulseCallback) {
            case IndexPulse.none:
                break;
            case IndexPulse.timeout:
                // If we see too many index pulses without the progress of a sector, the command times out with 0x18.
                // Interestingly enough, something like an e.g. 8192 byte sector read /times out because such a crazy
                // read hits the default 3 index pulse limit.
                if (--this._regs[Registers.internalIndexPulseCount] === 0) {
                    this._finishCommand(Result.sectorNotFound);
                }
                break;
            case IndexPulse.spindown:
                if (--this._regs[Registers.internalIndexPulseCount] === 0) {
                    this._logCommand("automatic head unload");
                    this._spinDown();
                    this._indexPulseCallback = IndexPulse.none;
                }
                break;
            case IndexPulse.startFormat:
                // Note that format doesn't set an index pulse timeout. No matter how
                // large the format sector size request, even 16384, the command never
                // exits due to 2 index pulses counted. This differs from read _and_
                // write. Format will exit on the next index pulse after all the sectors
                // have been written.
                // Disc Duplicator III needs this to work correctly when deformatting
                // tracks.
                if (this._regs[Registers.internalParam_4] !== 0) {
                    throw new Error("format GAP5 not supported");
                }
                // Decrement GAP3 as the CRC generator emits a third byte as 0xff.
                this._regs[Registers.internalParam_2]--;
                this._regs[Registers.internalDynamicDispatch] = 4;
                // This will start writing immediately because we check index pulse callbacks
                // before we process read/write state.
                this._indexPulseCallback = IndexPulse.none;
                // param_5 is GAP1.
                this._writeFFsAnd00s(Call.formatGap1OrGap3FFs, this._regs[Registers.internalParam_5]);
                break;
            case IndexPulse.stopFormat:
                this._checkCompletion();
                break;
            case IndexPulse.startReadId:
                this._startIndexPulseTimeout();
                this._startSyncingForHeader();
                break;
            default:
                throw new Error(`Unexpected index pulse callback ${this._indexPulseCallback}`);
        }
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
                this._log(`writing unusual clocks=${utils.hexbyte(clocks)} data=${utils.hexbyte(data)}`);
            this._currentDrive.writePulses(pulses);
        }

        // The external data register is always copied across to the bit processor's
        // MMIO data register. If a write command is in a state where it needed to
        // provide a data byte internally (i.e. a GAP byte, marker, etc.), it
        // overrides by re-writing the MMIO data register in the state machine below.
        this._mmioData = this._regs[Registers.internalData];

        switch (this._state) {
            case State.idle:
                break;
            case State.syncingForIdWait:
            case State.syncingForId:
            case State.checkIdMarker:
            case State.inId:
            case State.inIdCrc:
            case State.skipGap_2:
            case State.syncingForData:
            case State.checkDataMarker:
            case State.inData:
            case State.inDataCrc: {
                for (let i = 0; i < 16; ++i) {
                    const bit = !!(pulses & 0xc0000000);
                    pulses = (pulses << 2) & 0xffffffff;
                    this._shiftDataBit(bit);
                }
                break;
            }
            case State.writeRun:
            case State.writeDataMark:
            case State.dynamicDispatch:
            case State.writeSectorData:
            case State.writeCrc_2:
            case State.writeCrc_3:
            case State.formatWriteIdMarker:
            case State.formatIdCrc_2:
            case State.formatIdCrc_3:
            case State.formatWriteDataMarker:
            case State.formatDataCrc_2:
            case State.formatDataCrc_3:
            case State.formatGap_4:
                this._byteCallbackWriting();
                break;
            default:
                throw new Error(`Unknown state ${this._state}`);
        }
    }

    _shiftDataBit(bit) {
        const state = this._state;
        switch (state) {
            case State.syncingForIdWait:
                this._stateCount++;
                // THe controller seems to need recovery time after a sector header before
                // it can sync to another one. Measuring the "read sector IDs" command, 0x1b,
                // it needs 4 bytes to recover prior to the 2 byte sync.
                if (this._stateCount === 4 * 8 * 2) {
                    this._startSyncingForHeader();
                }
                break;
            case State.syncingForId:
            case State.syncingForData: {
                const stateCount = this._stateCount;
                // Need to see bit pattern of 1010101010... to gather sync. This
                // represents a string of 1 clock bits followed by 0 data bits.
                if (bit === !(stateCount & 1)) {
                    this._stateCount++;
                } else if (stateCount >= 32 && stateCount & 1) {
                    // Here we hit a 1 data bit while in sync, so it's the start of a marker byte.
                    if (!bit) {
                        throw new Error("Assertion failed; was expecting a one bit");
                    }
                    this._setState(state === State.syncingForId ? State.checkIdMarker : State.checkDataMarker);
                    this._shiftRegister = 3;
                    this._numShifts = 2;
                } else {
                    // Restart sync.
                    this._stateCount = bit ? 1 : 0;
                }
                break;
            }
            case State.checkIdMarker:
            case State.inId:
            case State.inIdCrc:
            case State.checkDataMarker:
            case State.inData:
            case State.inDataCrc:
            case State.skipGap_2: {
                const shiftRegister = ((this._shiftRegister << 1) & 0xffffffff) | (bit ? 1 : 0);
                this._shiftRegister = shiftRegister;
                this._numShifts++;
                if (this._numShifts !== 16) break;
                const clockByte = IntelFdc.extractBits(shiftRegister);
                const dataByte = IntelFdc.extractBits(shiftRegister << 1);
                if (
                    clockByte !== 0xff &&
                    state !== State.checkIdMarker &&
                    state !== State.checkDataMarker &&
                    state !== State.skipGap_2
                ) {
                    // Nothing. From testing the 8271 doesn't deliver bytes with missing
                    // clock bits in the middle of a synced byte stream.
                } else {
                    this._byteCallbackReading(dataByte, clockByte);
                }
                this._shiftRegister = 0;
                this._numShifts = 0;
                break;
            }
            case State.idle:
            case State.writeRun:
                break;
            default:
                throw new Error(`"Unexpected state ${state}"`);
        }
    }

    static extractBits(bits) {
        let byte = 0;
        if (bits & 0x8000) byte |= 0x80;
        if (bits & 0x2000) byte |= 0x40;
        if (bits & 0x0800) byte |= 0x20;
        if (bits & 0x0200) byte |= 0x10;
        if (bits & 0x0080) byte |= 0x08;
        if (bits & 0x0020) byte |= 0x04;
        if (bits & 0x0008) byte |= 0x02;
        if (bits & 0x0002) byte |= 0x01;
        return byte;
    }

    _checkDataLossOk() {
        let ok = true;

        // Abort if DMA transfer is selected. This is not supported in a BBC.
        if (!(this._regs[Registers.mode] & FdcMode.noDma)) ok = false;

        // Abort command if it's any type of scan. The 8271 requires DMA to be wired
        // up for scan commands, which is not done in the BBC application.
        const command = this._internalCommand;
        if (command === Command.scanData || command === Command.scanDataAndDeleted) ok = false;

        // Abort command if previous data byte wasn't picked up.
        if (this.internalStatus & StatusFlag.needData) ok = false;

        if (ok) return true;

        this._commandAbort();
        this._finishCommand(Result.lateDma);
        return false;
    }

    _byteCallbackReading(dataByte, clockByte) {
        const command = this._internalCommand;
        if (this._irqCallbacks) {
            if (!this._checkDataLossOk()) return;
            this._regs[Registers.internalData] = dataByte;
            this._statusRaise(StatusFlag.nmi | StatusFlag.needData);
        }

        switch (this._state) {
            case State.skipGap_2:
                // The controller requires a minimum byte count of 12 before sync then
                // sector data. 2 bytes of sync are needed, so absolute minimum gap here is
                // 14. The controller formats to 17 (not user controllable).

                // The controller enforced gap skip is 11 bytes of read, as per the
                // ROM. The practical count of 12 is likely because the controller takes
                // some number of microseconds to start the sync detector after this
                // counter expires.
                if (--this._regs[Registers.internalGap2Skip]) break;
                if (this._callContext === Call.read) this._setState(State.syncingForData);
                else if (this._callContext === Call.write) this._doWriteRun(Call.write, 0x00);
                else throw new Error(`Unexpected call context ${this._callContext}`);
                break;
            case State.checkIdMarker:
                if (clockByte === IbmDiscFormat.markClockPattern && dataByte === IbmDiscFormat.idMarkDataPattern) {
                    this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), dataByte);
                    if (command === Command.readId) this._startIrqCallbacks();
                    this._setState(State.inId);
                } else {
                    this._startSyncingForHeader();
                }
                break;
            case State.inId:
                this._crc = IbmDiscFormat.crcAddByte(this._crc, dataByte);
                this._writeRegister(this._regs[Registers.internalHeaderPointer], dataByte);
                this._regs[Registers.internalHeaderPointer]--;
                if ((this._regs[Registers.internalHeaderPointer] & 0x07) === 0) {
                    this._onDiscCrc = 0;
                    this._stopIrqCallbacks();
                    this._setState(State.inIdCrc);
                }
                break;
            case State.inIdCrc:
                this._onDiscCrc = ((this._onDiscCrc << 8) | dataByte) & 0xffffffff;
                if (++this._stateCount === 2) {
                    // On a real 8271, an ID CRC error seems to end things decisively
                    // even if a subsequent ok ID would match.
                    if (!this._checkCrc(Result.idCrcError)) {
                        break;
                    }
                    // This is a test for the READ ID command.
                    if (this._regs[Registers.internalCommand] === 0x18) {
                        this._checkCompletion();
                    } else if (this._regs[Registers.internalIdTrack] !== this._regs[Registers.internalParam_1]) {
                        // Upon any mismatch of found track vs. expected track, the drive will try
                        // twice more on the next two tracks.
                        if (++this._regs[Registers.internalSeekRetryCount] === 3) {
                            this._finishCommand(Result.sectorNotFound);
                        } else {
                            this._logCommand("stepping due to track mismatch");
                            this._doSeek(Call.unchanged);
                        }
                    } else if (this._regs[Registers.internalIdSector] === this._regs[Registers.internalParam_2]) {
                        this._regs[Registers.internalGap2Skip] = 11;
                        if (this._callContext === Call.write) {
                            // Set up for the first 5 bytes of the 0x00 sync.
                            this._regs[Registers.internalCountMsb] = 0;
                            this._regs[Registers.internalCountLsb] = 5;
                        }
                        this._setState(State.skipGap_2);
                    } else {
                        this._setState(State.syncingForIdWait);
                    }
                }
                break;
            case State.checkDataMarker:
                if (
                    clockByte === IbmDiscFormat.markClockPattern &&
                    (dataByte === IbmDiscFormat.dataMarkDataPattern ||
                        dataByte === IbmDiscFormat.deletedDataMarkDataPattern)
                ) {
                    let doIrqs = true;
                    if (dataByte === IbmDiscFormat.deletedDataMarkDataPattern) {
                        if ((this._regs[Registers.internalCommand] & 0x0f) === 0) doIrqs = false;
                        this._setResult(Result.flagDeletedData);
                    }
                    // No IRQ callbacks if 'verify'.
                    if (this._regs[Registers.internalCommand] === 0x1c) doIrqs = false;
                    if (doIrqs) this._startIrqCallbacks();
                    this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), dataByte);
                    this._setState(State.inData);
                } else {
                    this._finishCommand(Result.clockError);
                }
                break;
            case State.inData: {
                this._crc = IbmDiscFormat.crcAddByte(this._crc, dataByte);
                if (this._decrementCounter()) {
                    this._onDiscCrc = 0;
                    this._setState(State.inDataCrc);
                }
                break;
            }
            case State.inDataCrc:
                this._onDiscCrc = ((this._onDiscCrc << 8) | dataByte) & 0xffffffff;
                if (++this._stateCount === 2) {
                    if (!this._checkCrc(Result.dataCrcError)) break;
                    this._checkCompletion();
                }
                break;
            default:
                throw new Error(`Unexpected state ${this._state}`);
        }
    }

    _callbackWriteRun() {
        if (!this._decrementCounter()) {
            this._mmioData = this._regs[Registers.internalWriteRunData];
            this._crc = IbmDiscFormat.crcAddByte(this._crc, this._mmioData);
            return;
        }
        switch (this._callContext) {
            case Call.write:
                this._mmioData = 0;
                this._startIrqCallbacks();
                this._setState(State.writeDataMark);
                break;
            case Call.formatGap1OrGap3FFs:
                // Flip from writing ffs to 00s.
                this._regs[Registers.internalCountLsb] = 5;
                this._doWriteRun(Call.formatGap1orGap300s, 0x00);
                break;
            case Call.formatGap1orGap300s:
                this._mmioData = 0x00;
                this._startIrqCallbacks();
                this._setState(State.formatWriteIdMarker);
                break;
            case Call.formatGap2_FFs:
                // Flip from writing ffs to 00s.
                this._regs[Registers.internalCountLsb] = 5;
                this._doWriteRun(Call.formatGap2_00s, 0x00);
                break;
            case Call.formatGap2_00s:
                this._mmioData = 0;
                this._setState(State.formatWriteDataMarker);
                break;
            case Call.formatData:
                this._mmioData = (this._crc >>> 8) & 0xff;
                this._setState(State.formatDataCrc_2);
                break;
            default:
                throw new Error(`Unexpected call context ${this._callContext}`);
        }
    }

    _callbackDynamicDispatch() {
        const routine = this._regs[Registers.internalDynamicDispatch]++;
        switch (routine) {
            // Routines 0 - 2 used for write sector.
            case 0:
                this._crc = IbmDiscFormat.crcAddByte(this._crc, this._mmioData);
                break;
            case 1:
                this._mmioData = (this._crc >>> 8) & 0xff;
                this._setState(State.writeCrc_2);
                break;
            case 2:
                this._checkCompletion();
                break;
            // Routines 4 - 11 used for format.
            // 4 - 7 write the 4 user-supplied sector header bytes.
            case 4:
                this._mmioClocks = 0xff;
            // fallthrough
            case 5:
            case 6:
            case 7:
                if (routine === 6) this._stopIrqCallbacks();
                this._crc = IbmDiscFormat.crcAddByte(this._crc, this._mmioData);
                break;
            // write the sector header CRC
            case 8:
                this._mmioData = (this._crc >>> 8) & 0xff;
                this._setState(State.formatIdCrc_2);
                break;
            // write GAP2
            case 9:
                // This value 10 is GAP2 0xff length minus 1. The CRC generator emits a third
                // byte of 0xff.
                // The other -1 here is because we will we set the count registers ourselves. In the ROM,
                // LSB is written here but not MSB.
                this._regs[Registers.internalCountLsb] = 10;
                this._writeFFsAnd00s(Call.formatGap2_FFs, -1);
                break;
            case 10:
                this._resetSectorByteCount();
                this._doWriteRun(Call.formatData, 0xe5);
                break;
            // 11 is after the sector data CRC is written.
            case 11:
                this._mmioData = 0xff;
                if ((--this._regs[Registers.internalParam_3] & 0x1f) === 0) {
                    // Format sectors done. Write GAP4 until end of track.
                    // Reset param 3 to 1, to ensure immediate exit in the command exit
                    // path in intel_fdc_check_completion().
                    this._regs[Registers.internalParam_3] = 1;
                    this._indexPulseCallback = IndexPulse.stopFormat;
                    this._setState(State.formatGap_4);
                } else {
                    // Format sectors not done. Next one. Reset state machine index, param2 is GAP3.
                    this._regs[Registers.internalDynamicDispatch] = 4;
                    this._writeFFsAnd00s(Call.formatGap1OrGap3FFs, this._regs[Registers.internalParam_2]);
                }
                break;
            default:
                throw new Error(`Dodgy routine number ${routine}`);
        }
    }

    _byteCallbackWriting() {
        if (this._irqCallbacks) {
            if (!this._checkDataLossOk()) return;
            this._statusRaise(StatusFlag.nmi | StatusFlag.needData);
        }

        switch (this._state) {
            case State.writeRun:
                this._callbackWriteRun();
                break;
            case State.writeDataMark:
                this._mmioData = this._regs[Registers.internalParamDataMarker];
                this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), this._mmioData);
                this._mmioClocks = IbmDiscFormat.markClockPattern;
                this._resetSectorByteCount(); /////
                // This strange decrement is how the ROM does it.
                this._regs[Registers.internalCountLsb]--;
                this._setState(State.writeSectorData);
                break;
            case State.writeSectorData:
                this._mmioClocks = 0xff;
                this._crc = IbmDiscFormat.crcAddByte(this._crc, this._mmioData);
                if (this._decrementCounter()) {
                    this._regs[Registers.internalDynamicDispatch] = 0;
                    this._setState(State.dynamicDispatch);
                }
                break;
            case State.writeCrc_2:
                this._mmioData = this._crc & 0xff;
                this._setState(State.writeCrc_3);
                break;
            case State.writeCrc_3:
                this._mmioData = 0xff;
                this._setState(State.dynamicDispatch);
                break;
            case State.dynamicDispatch:
                this._callbackDynamicDispatch();
                break;
            case State.formatWriteIdMarker:
                this._mmioData = IbmDiscFormat.idMarkDataPattern;
                this._mmioClocks = IbmDiscFormat.markClockPattern;
                this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), this._mmioData);
                this._setState(State.dynamicDispatch);
                break;
            case State.formatIdCrc_2:
                this._mmioData = this._crc & 0xff;
                this._setState(State.formatIdCrc_3);
                break;
            case State.formatIdCrc_3:
                this._mmioData = 0xff;
                this._setState(State.dynamicDispatch);
                break;
            case State.formatWriteDataMarker:
                this._mmioData = IbmDiscFormat.dataMarkDataPattern;
                this._mmioClocks = IbmDiscFormat.markClockPattern;
                this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), this._mmioData);
                this._setState(State.dynamicDispatch);
                break;
            case State.formatDataCrc_2:
                this._mmioData = this._crc & 0xff;
                this._setState(State.formatDataCrc_3);
                break;
            case State.formatDataCrc_3:
                this._mmioData = 0xff;
                this._setState(State.dynamicDispatch);
                break;
            case State.formatGap_4:
                // GAP 4 writes until the index pulse, handled in the callback there.
                this._mmioData = 0xff;
                break;
            default:
                throw new Error(`Bad write state ${this._state}`);
        }
    }

    _resetSectorByteCount() {
        this._regs[Registers.internalCountMsb] = this._regs[Registers.internalCountMsbCopy];
        this._regs[Registers.internalCountLsb] = 0x80;
    }

    _checkCompletion() {
        if (!this._checkDriveReady()) return;

        // Lower write enable.
        this._driveOutLower(DriveOut.writeEnable);
        this._clearCallbacks();

        // One less sector to go. Specifying 0 sectors seems to result in 32 read, due
        // to underflow of the 5-bit counter. On commands other than read id, any underflow
        // has other side effects such as modifying the sector size.
        if ((--this._regs[Registers.internalParam_3] & 0x1f) === 0) {
            this._finishCommand(Result.ok);
        } else {
            // This looks strange as it is set up to be just an increment (R4==1 in sector
            // operations). but it's what the 8271 ROM does.
            this._regs[Registers.internalParam_2] += this._regs[Registers.internalParam_4] & 0x3f;
            // This is also what the 8271 ROM does, just re-dispatches the current command.
            this._doCommandDispatch();
        }
    }

    /**
     * @param {Result|Number} error error if invalid
     */
    _checkCrc(error) {
        if (this._crc === this._onDiscCrc) return true;
        this._finishCommand(error);
        return false;
    }

    _statusRaise(statusFlags) {
        this._regs[Registers.internalStatus] |= statusFlags;
        if (statusFlags & StatusFlag.nmi) {
            this._updateNmi();
        }
        this._updateExternalStatus();
    }

    _statusLower(statusFlags) {
        this._regs[Registers.internalStatus] &= ~statusFlags;
        if (statusFlags & StatusFlag.nmi) {
            this._updateNmi();
        }
        this._updateExternalStatus();
    }

    _setResult(result) {
        this._regs[Registers.internalResult] = result;
        this._isResultReady = true;
        this._updateExternalStatus();
    }

    get _result() {
        return this._regs[Registers.internalResult];
    }

    _updateNmi() {
        const status = this.internalStatus;
        const level = !!(status & StatusFlag.nmi);
        if (this._cpu.nmi && level) {
            this._log("edge triggered NMI already high");
        }
        this._cpu.NMI(level);
    }

    _updateExternalStatus() {
        // EMU NOTE: currently, the emulation responds instantly to getting commands
        // started, accepting parameters, transitioning between states, etc.
        // This is inaccurate.
        // The real 8271 is an asynchronously running general purpose microcontroller,
        // where each instruction takes 2us+ and processing between states uses a
        // large and variable number of instructions.
        // Some food for though, latency timings on a BBC + 8271, including setup:
        // WRITE SPECIAL REGISTER:                   211us
        // WRITE SPECIAL REGISTER (0 param version): 157us
        // READ DRIVE STATUS:                        188us
        // write $35 to parameter register:           31us
        // write 3rd SPECIFY parameter:               27us
        let status = this.internalStatus;
        // The internal status register appears to be shared with some mode bits that
        // must be masked out.
        status &= ~0x03;
        // Current best thinking is that the internal register uses bit value 0x10 for
        // something different, and that "result ready" is maintained by the external
        // register logic.
        status &= ~StatusFlag.resultReady;
        if (this._isResultReady) {
            status |= StatusFlag.resultReady;
        }

        // TODO: "command register full", bit value 0x40, isn't understood. In
        // particular, the mode register (shared with the status register we
        // believe) is set to 0xC1 in typical operation. This would seem to raise
        // 0x40 after it has been lowered at command register acceptance. However,
        // the bit is not returned.
        // Don't return it, ever, for now.
        // Also avoid "parameter register full".
        status &= ~0x60;

        this._status = status;
    }

    _commandWritten(command) {
        const status = this.internalStatus;
        if (status & StatusFlag.busy) {
            this._log(
                `command ${utils.hexbyte(command)} while busy with ${utils.hexbyte(this._regs[Registers.internalCommand])}`,
            );
        }

        // Set command.
        this._regs[Registers.internalCommand] = command;

        // Set busy, lower command full in status, result to 0.
        this._statusRaise(StatusFlag.busy);
        this._statusLower(StatusFlag.commandFull);
        this._setResult(0);

        // Default parameters. This supports the 1x128 byte sector commands.
        this._regs[Registers.internalParam_3] = 1;
        this._regs[Registers.internalParam_4] = 1;

        // Calculate parameters expected. Taken from the logic in the 8271 ROM.
        const numParams = command & 0x18 ? command & 0x3 : 5;
        this._regs[Registers.internalParamCount] = numParams;

        // Are we waiting for parameters?
        if (numParams) {
            // Parameters write from R7 downwards.
            this._regs[Registers.internalPointer] = Registers.internalParam_1;
            this._paramCallback = ParamAccept.command;
        } else {
            this._startCommand();
        }
    }

    _resultConsumed() {
        this._isResultReady = false;
        this._updateExternalStatus();
    }

    _paramWritten(param) {
        this._regs[Registers.internalParameter] = param;
        this._resultConsumed();

        switch (this._paramCallback) {
            case ParamAccept.none:
                break;
            case ParamAccept.command: {
                this._writeRegister(this._regs[Registers.internalPointer], param);
                --this._regs[Registers.internalPointer];
                if (--this._regs[Registers.internalParamCount] === 0) {
                    this._startCommand();
                }
                break;
            }
            case ParamAccept.specify: {
                this._logCommand(`specify param ${utils.hexbyte(param)}`);
                this._writeRegister(this._regs[Registers.internalPointer], param);
                ++this._regs[Registers.internalPointer];
                if (--this._regs[Registers.internalParamCount] === 0) {
                    this._finishSimpleCommand();
                }
                break;
            }
            default:
                throw new Error(`Unexpected param callback ${this._paramCallback}`);
        }
    }

    _readRegister(reg) {
        reg &= 0x3f;
        if (reg < IntelFdc.NumRegisters) {
            return this._regs[reg];
        }
        reg &= 0x07;
        switch (reg) {
            case Registers.mmioDriveIn & 0x07:
                return this._driveIn;
            case Registers.mmioDriveOut & 0x07:
                // DFS-1.2 reads drive out in normal operation.
                return this._driveOut;
            case Registers.mmioClocks & 0x07:
                return this._mmioClocks;
            case Registers.mmioData & 0x07:
                return this._mmioData;
            default:
                this._log(`direct read from MMIO register ${utils.hexbyte(reg)}`);
                break;
        }
        return 0;
    }

    _writeRegister(reg, val) {
        reg &= 0x3f;
        if (reg < IntelFdc.NumRegisters) {
            this._regs[reg] = val;
            return;
        }
        reg &= 0x07;
        switch (reg) {
            case Registers.mmioDriveOut & 0x07:
                // Bit 0x20 is important as it's used to select the side of the disc for
                // double-sided discs.
                // Bit 0x08 is important as it provides manual head load / unload control,
                // which includes motor spin up / down.
                // The parameter also includes drive select bits which override those in
                // the command.
                this._setDriveOut(val);
                break;
            case Registers.mmioClocks & 0x07:
                this._mmioClocks = val;
                break;
            case Registers.mmioData & 0x07:
                this._mmioData = val;
                break;
            default:
                this._log(`direct write to MMIO register ${utils.hexbyte(reg)}`);
                break;
        }
    }

    _driveOutRaise(bits) {
        this._setDriveOut(bits | this._driveOut);
    }

    _driveOutLower(bits) {
        this._setDriveOut(this._driveOut & ~bits);
    }

    /**
     * @param {DriveOut|Number} driveOut
     */
    _setDriveOut(driveOut) {
        if (this._currentDrive) this._currentDrive.stopSpinning();
        this._currentDrive = null;

        // Note: unclear what to do if both drives are selected. We select no drive
        // for now, to avoid shenanigans.
        const selectBits = driveOut & DriveOut.selectFlags;
        if (selectBits === DriveOut.select_0) this._currentDrive = this._drives[0];
        else if (selectBits === DriveOut.select_1) this._currentDrive = this._drives[1];

        if (this._currentDrive) {
            if (driveOut & DriveOut.loadHead) this._currentDrive.startSpinning();
            this._currentDrive.selectSide(!!(driveOut & DriveOut.side));
        }
        this._driveOut = driveOut;
    }

    /**
     * @param {State|Number} state
     */
    _setState(state) {
        if (this._state !== state && this._logStateChanges) {
            this._log(`State ${this._state} -> ${state}`);
        }
        this._state = state;
        this._stateCount = 0;
        if (state === State.syncingForId || state === State.syncingForData) {
            this._shiftRegister = 0;
            this._numShifts = 0;
        }
    }

    /**
     * @param {Call|Number} callContext
     */
    _doSeek(callContext) {
        if (callContext !== Call.unchanged) this._callContext = callContext;
        let newTrack = this._regs[Registers.internalParam_1] + this._regs[Registers.internalSeekRetryCount];
        const trackRegOffset =
            this._driveOut & DriveOut.select_1 ? Registers.badTrack_1Drive_1 : Registers.badTrack_1Drive_0;
        // Add one to requested track for each bad track covered. */
        // EMU NOTE: this is based on a disassembly of the real 8271 ROM and yes,
        // integer overflow does occur!
        if (newTrack > 0) {
            if (this._regs[trackRegOffset + 0] <= newTrack) {
                newTrack = (newTrack + 1) & 0xff;
            }
            if (this._regs[trackRegOffset + 1] <= newTrack) {
                newTrack = (newTrack + 1) & 0xff;
            }
        }
        this._regs[Registers.internalSeekTarget_1] = newTrack;
        this._regs[Registers.internalSeekTarget_2] = newTrack;
        // Set low head current in drive output depending on track.
        if (newTrack >= 43) this._driveOut |= DriveOut.lowHeadCurrent;
        else this._driveOut &= ~DriveOut.lowHeadCurrent;
        // Work out seek direction and total number of steps. Pretend current track is 255 if a seek to 0.
        const curTrack = newTrack === 0 ? 255 : this._regs[trackRegOffset + 2];
        this._didSeekStep = false;

        // Skip to head load if there's no seek.
        if (newTrack === curTrack) {
            this._doLoadHead();
            return;
        }

        if (newTrack > curTrack) {
            this._regs[Registers.internalSeekCount] = newTrack - curTrack;
            this._driveOut |= DriveOut.direction;
        } else {
            this._regs[Registers.internalSeekCount] = curTrack - newTrack;
            this._driveOut &= ~DriveOut.direction;
        }
        if (this._currentDrive) this._currentDrive.notifySeek(newTrack);

        // Seek pulses on the 8271 are about 10us, so let's just lower the output bit and make them unobservable
        // as we suspect they are on a real machine.
        this._driveOut &= ~DriveOut.step;
        // Current track registers are updated here before the actual step sequence.
        this._regs[trackRegOffset + 2] = this._regs[Registers.internalSeekTarget_2];
        // Update both track registers if "single actuator" flag is set.
        if (this._regs[Registers.mode] & FdcMode.singleActuator) {
            this._regs[Registers.trackDrive_0] = this._regs[Registers.internalSeekTarget_2];
            this._regs[Registers.trackDrive_1] = this._regs[Registers.internalSeekTarget_2];
        }
        this._doSeekStep();
    }

    _doSeekStep() {
        if (
            (this._trk0 && this._regs[Registers.internalSeekTarget_2] === 0) || // Seek to 0 done, TRK0 detected
            this._regs[Registers.internalSeekCount] === 0
        ) {
            this._doLoadHead();
            return;
        }
        //  We're going to actually step, so we'll need settle if the head is already loaded.
        this._didSeekStep = true;
        this._regs[Registers.internalSeekCount]--;

        if (this._currentDrive) this._currentDrive.seekOneTrack(this._driveOut & DriveOut.direction ? 1 : -1);

        let stepRate = this._regs[Registers.headStepRate];
        if (stepRate === 0) {
            // Step rate is up to the drive. Let's say 3ms.
            stepRate = 3;
        } else {
            // The datasheet is ambiguous about whether the units are 1ms or 2ms for 5.25" drives. 1ms might
            // be your best guess from the datasheet, but timing on a real machine, it appears to be 2ms.
            stepRate *= 2;
        }
        this._setTimerMs(TimerState.seekStep, stepRate);
    }

    _doLoadHead() {
        let postSeekTimeMs = 0;
        // The head load time replaces the settle time if there is both.
        if (!(this._driveOut & DriveOut.loadHead)) {
            this._driveOutRaise(DriveOut.loadHead);
            // Head load units are 4ms.
            postSeekTimeMs = 4 * (this._regs[Registers.headLoadUnload] & 0xf);
        } else if (this._didSeekStep) {
            // All references state the units are 2ms for 5.25" drives.
            postSeekTimeMs = 2 * this._regs[Registers.headSettleTime];
        }
        if (postSeekTimeMs) {
            this._setTimerMs(TimerState.postSeek, postSeekTimeMs);
        } else {
            this._postSeekDispatch();
        }
    }

    _postSeekDispatch() {
        this._timerState = TimerState.none;
        if (!this._checkDriveReady()) return;
        switch (this._callContext) {
            case Call.seek:
                this._finishCommand(Result.ok);
                break;
            case Call.readId:
                this._indexPulseCallback = IndexPulse.startReadId;
                break;
            case Call.format:
                this._setupSectorSize();
                this._indexPulseCallback = IndexPulse.startFormat;
                this._checkWriteProtect();
                break;
            case Call.read:
            case Call.write:
                this._setupSectorSize();
                this._startIndexPulseTimeout();
                this._startSyncingForHeader();
                if (this._callContext === Call.write) this._checkWriteProtect();
                break;
            default:
                throw new Error(`Surprising call context post seek ${this._callContext}`);
        }
    }

    get _sectorSize() {
        const size = this._regs[Registers.internalParam_3] >>> 5;
        return 128 << size;
    }

    _setupSectorSize() {
        const msb = (this._sectorSize >>> 7) - 1;
        this._regs[Registers.internalCountLsb] = 0x80;
        this._regs[Registers.internalCountMsb] = msb;
        // Note the is R0, i.e. R0 is trashed here.
        this._regs[Registers.internalCountMsbCopy] = msb;
    }

    _setTimerMs(state, timerMs) {
        this._timerTask.cancel();
        this._timerState = state;
        this._timerTask.schedule(timerMs * 2000);
    }

    _startIndexPulseTimeout() {
        this._regs[Registers.internalIndexPulseCount] = 3;
        this._indexPulseCallback = IndexPulse.timeout;
    }

    _startSyncingForHeader() {
        this._regs[Registers.internalHeaderPointer] = 0x0c;
        this._setState(State.syncingForId);
    }

    _checkDriveReady() {
        this._doReadDriveStatus();
        const mask = this._driveOut & DriveOut.select_1 ? 0x40 : 0x04;
        if (!(this._regs[Registers.internalDriveInLatched] & mask)) {
            this._finishCommand(Result.driveNotReady);
            return false;
        }
        return true;
    }

    _checkWriteProtect() {
        if (this._regs[Registers.internalDriveInLatched] & 0x08) {
            this._finishCommand(Result.writeProtected);
        }
    }

    _startCommand() {
        let commandReg = this._regs[Registers.internalCommand];
        const origCommand = commandReg;

        // This update R21 and R27. R27 is later referenced for checking the write protect bit.
        this._doReadDriveStatus();

        this._paramCallback = ParamAccept.none;

        // Select the drive before logging so that head position is reported.
        // The MMIO clocks register really is used as a temporary storage for this.
        const selectBits = commandReg & DriveOut.selectFlags;
        this._mmioClocks = selectBits;
        if (selectBits !== (this._driveOut & DriveOut.selectFlags)) {
            // A change of drive select bits clears all drive out bits other than side select.
            // For example, the newly selected drive won't have the load head signal
            // active. This spins down any previously selected drive.
            const newSelectBits = selectBits | (this._driveOut & DriveOut.side);
            this._setDriveOut(newSelectBits);
        }

        // Mask out drive select bits from the command register, and parameter count.
        commandReg &= ~(DriveOut.selectFlags | 0x03);
        this._regs[Registers.internalCommand] = commandReg;
        this._logCommand(
            `command ${utils.hexbyte(origCommand & 0x3f)} ` +
                `sel ${utils.hexbyte(selectBits)} ` +
                `params ${utils.hexbyte(this._regs[Registers.internalParam_1])} ` +
                `${utils.hexbyte(this._regs[Registers.internalParam_2])} ` +
                `${utils.hexbyte(this._regs[Registers.internalParam_3])} ` +
                `${utils.hexbyte(this._regs[Registers.internalParam_4])} ` +
                `${utils.hexbyte(this._regs[Registers.internalParam_5])} ` +
                `ptrk ${this._currentDrive ? this._currentDrive.track : -1} ` +
                `hpos ${this._currentDrive ? this._currentDrive.headPosition : -1}`,
        );

        const command = this._internalCommand;
        if (command === Command.scanData || command === Command.scanDataAndDeleted) {
            this._log("scan sectors doesn't work in a beeb");
        }
        this._doCommandDispatch();
    }

    get _internalCommand() {
        return (this._regs[Registers.internalCommand] & ~(DriveOut.selectFlags | 0x03)) >>> 2;
    }

    get _currentDiscIsSpinning() {
        return this._currentDrive ? this._currentDrive.spinning : false;
    }

    get _trk0() {
        return this._currentDrive ? this._currentDrive.track === 0 : false;
    }

    get _index() {
        return this._currentDrive ? this._currentDrive.indexPulse : false;
    }

    get _wrProt() {
        // A real drive would likely return `true` if no disc was inserted.
        return this._currentDrive ? this._currentDrive.writeProtect : false;
    }

    get _driveIn() {
        // Note: on @scarybeasts machine, bit 7 and bit 0 appear to be always set.
        let driveIn = 0x81;
        if (this._currentDiscIsSpinning) {
            // TRK0
            if (this._trk0) driveIn |= 0x02;
            // RDY0
            if (this._driveOut & DriveOut.select_0) driveIn |= 0x04;
            // RDY1
            if (this._driveOut & DriveOut.select_1) driveIn |= 0x40;
            // WR PROT
            if (this._wrProt) driveIn |= 0x08;
            // INDEX
            if (this._index) driveIn |= 0x10;
        }

        return driveIn;
    }

    _doReadDriveStatus() {
        let driveIn = this._driveIn;
        this._regs[Registers.internalDriveInCopy] = driveIn;
        this._regs[Registers.internalDriveInLatched] |= 0xbb;
        driveIn &= this._regs[Registers.internalDriveInLatched];
        this._regs[Registers.internalDriveInLatched] = driveIn;
        return driveIn;
    }

    _doCommandDispatch() {
        const command = this._internalCommand;

        switch (command) {
            case Command.unused_9:
            case Command.unused_12:
                throw new Error("Unused 8271 command");
            case Command.readDriveStatus: {
                const status = this._doReadDriveStatus();
                this._setResult(status);
                this._regs[Registers.internalDriveInLatched] = this._regs[Registers.internalDriveInCopy];
                this._finishSimpleCommand();
                break;
            }
            case Command.specify:
                this._regs[Registers.internalPointer] = this._regs[Registers.internalParam_1];
                this._regs[Registers.internalParamCount] = 3;
                this._paramCallback = ParamAccept.specify;
                break;
            case Command.writeSpecialRegister:
                this._writeRegister(this._regs[Registers.internalParam_1], this._regs[Registers.internalParam_2]);
                // WRITE_SPECIAL_REGISTER tidies up in a much simpler way than other commands.
                this._lowerBusyAndLog();
                break;
            case Command.readSpecialRegister:
                this._setResult(this._readRegister(this._regs[Registers.internalParam_1]));
                this._finishSimpleCommand();
                break;
            case Command.readId:
                // First dispatch for the command, we go through the seek / wait for index /
                // etc. rigamarole. The command is re-dispatched for the second and further
                // headers, where we just straight to searching for header sync.
                // This can also be used as an undocumented mode of READ_ID where a
                // non-zero value to the second parameter will skip syncing to the index
                // pulse.
                if (this._regs[Registers.internalParam_2] === 0) {
                    this._doSeek(Call.readId);
                } else {
                    this._startSyncingForHeader();
                }
                break;
            case Command.seek:
                this._doSeek(Call.seek);
                break;
            case Command.readData:
            case Command.readDataAndDeleted:
            case Command.verify:
            case Command.scanData:
            case Command.scanDataAndDeleted:
                this._doSeek(Call.read);
                break;
            case Command.writeData:
                this._regs[Registers.internalParamDataMarker] = IbmDiscFormat.dataMarkDataPattern;
                this._doSeek(Call.write);
                break;
            case Command.writeDeletedData:
                this._regs[Registers.internalParamDataMarker] = IbmDiscFormat.deletedDataMarkDataPattern;
                this._doSeek(Call.write);
                break;
            case Command.format:
                this._doSeek(Call.format);
                break;
            default:
                throw new Error(`Unexpected command ${command}`);
        }
    }

    _finishSimpleCommand() {
        this._lowerBusyAndLog();
        this._stopIrqCallbacks();
        this._clearCallbacks();

        const headUnloadCount = this._regs[Registers.headLoadUnload] >>> 4;
        if (headUnloadCount === 0) {
            // Unload immediately.
            this._spinDown();
        } else if (headUnloadCount === 0xf) {
            // Never automatically unload.
        } else {
            this._regs[Registers.internalIndexPulseCount] = headUnloadCount;
            this._indexPulseCallback = IndexPulse.spindown;
        }
    }

    _finishCommand(result) {
        if (result !== Result.ok) {
            this._driveOutLower(DriveOut.direction | DriveOut.step | DriveOut.writeEnable);
        }
        this._setResult(result | this._result);
        // Raise command completion IRQ.
        this._statusRaise(StatusFlag.nmi);
        this._finishSimpleCommand();
    }

    get _irqCallbacks() {
        return (this._regs[Registers.internalStatus] & 0x30) === 0x30;
    }

    _startIrqCallbacks() {
        // These bits don't affect the external status, so no need to re-calculate.
        this._regs[Registers.internalStatus] |= 0x30;
    }

    _stopIrqCallbacks() {
        // These bits don't affect the external status, so no need to re-calculate.
        this._regs[Registers.internalStatus] &= ~0x30;
    }

    _decrementCounter() {
        if (--this._regs[Registers.internalCountLsb]) return false;
        // Javascript's clamping for Uint8Array happens on assignment; so I can do if (--regs[x] !== 0xff) here.
        --this._regs[Registers.internalCountMsb];
        if (this._regs[Registers.internalCountMsb] !== 0xff) {
            this._regs[Registers.internalCountLsb] = 0x80;
            return false;
        }
        this._regs[Registers.internalCountMsb] = 0;
        this._stopIrqCallbacks();
        return true;
    }

    _clearCallbacks() {
        this._paramCallback = ParamAccept.none;
        this._indexPulseCallback = IndexPulse.none;
        if (this._timerState !== TimerState.none) {
            this._timerTask.cancel();
            this._timerState = TimerState.none;
        }
        // Think of this as the read/write callback from the bit processor.
        this._setState(State.idle);
    }

    _lowerBusyAndLog() {
        this._statusLower(StatusFlag.busy);
        this._logCommand(`status ${utils.hexbyte(this._status)} result ${utils.hexbyte(this._result)}`);
    }

    _spinDown() {
        this._driveOutLower(DriveOut.selectFlags | DriveOut.loadHead);
    }

    _timerFired() {
        // Counting milliseconds is done with r8 and r9, which are left at zero after a busy wait.
        this._regs[Registers.internalMsCountHi] = 0;
        this._regs[Registers.internalMsCountLo] = 0;
        switch (this._timerState) {
            case TimerState.seekStep:
                this._doSeekStep();
                break;
            case TimerState.postSeek:
                this._postSeekDispatch();
                break;
        }
    }

    _doWriteRun(callContext, byte) {
        this._mmioData = byte & 0xff;
        this._mmioClocks = 0xff;
        this._crc = IbmDiscFormat.crcAddByte(this._crc, this._mmioData);
        this._regs[Registers.internalWriteRunData] = this._mmioData;
        this._driveOutRaise(DriveOut.writeEnable);
        this._callContext = callContext;
        this._setState(State.writeRun);
    }

    _writeFFsAnd00s(callContext, numFFs) {
        if (numFFs !== -1) {
            this._regs[Registers.internalCountLsb] = numFFs;
            this._regs[Registers.internalCountMsb] = 0;
        }
        this._doWriteRun(callContext, 0xff);
    }

    /// jsbeeb compatibility stuff
    /**
     *
     * @param {Number} drive
     * @param {Disc} disc
     */
    loadDisc(drive, disc) {
        this._drives[drive].setDisc(disc);
    }

    get motorOn() {
        return [this._drives[0] ? this._drives[0].spinning : false, this._drives[0] ? this._drives[1].spinning : false];
    }

    get drives() {
        return this._drives;
    }
}

export class NoiseAwareIntelFdc extends IntelFdc {
    constructor(cpu, ddNoise, scheduler, debugFlags) {
        super(cpu, scheduler, undefined, debugFlags);
        let nextSeekTime = 0;
        let numSpinning = 0;
        // Update the spin status shortly after the drive state changes to debounce it slightly.
        const updateSpinStatus = () => {
            if (numSpinning) ddNoise.spinUp();
            else ddNoise.spinDown();
        };
        for (const drive of this.drives) {
            drive.addEventListener("startSpinning", () => {
                numSpinning++;
                setTimeout(updateSpinStatus, 2);
            });
            drive.addEventListener("stopSpinning", () => {
                --numSpinning;
                setTimeout(updateSpinStatus, 2);
            });
            drive.addEventListener("step", (evt) => {
                const now = Date.now();
                if (now > nextSeekTime) nextSeekTime = now + ddNoise.seek(evt.stepAmount) * 1000;
            });
        }
    }
}
