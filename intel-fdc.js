// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502.js";
import { IbmDiscFormat } from "./disc.js";
// eslint-disable-next-line no-unused-vars
import { DiscDrive } from "./disc-drive.js";
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
import * as utils from "./utils.js";

/**
 * Register indices.
 *
 * @readonly
 * @enum {number}
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
 * Floopy disc controller mode.
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
    postStep: 2,
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
    gap1OrGap3FFs: 7,
    gap1orGap300s: 8,
    gap2_FFs: 9,
    gap2_00s: 10,
    formatData: 11,
});

export class IntelFdc {
    static get NumRegisters() {
        return 32;
    }

    /**
     * @param {Cpu6502} cpu
     * @param {Scheduler} scheduler
     */
    constructor(cpu, scheduler) {
        this._cpu = cpu;
        /** @type {DiscDrive[]} */
        this._drives = [];
        /** @type {DiscDrive} */
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

        this._state = 0;
        this._stateCount = 0;
        this._stateIsIndexPulse = false;
        this._crc = 0;
        this._onDiscCrc = 0;

        this._logCommands = false;

        this._timerTask = scheduler.newTask(() => this._timerFired());
    }

    /**
     * @param {DiscDrive} drive0
     * @param {DiscDrive} drive1
     */
    setDrives(drive0, drive1) {
        this._drives = [drive0, drive1];
        const callback = (pulses, count) => this._pulsesCallback(pulses, count);
        if (drive0) drive0.setPulsesCallback(callback);
        if (drive1) drive1.setPulsesCallback(callback);
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
            case Address.Reset:
                //On a real 8271, crazy crazy things happen if you write 2 or especially 4 to this register.
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
                this._log(`Not supported: ${addr}=${val}`);
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
                this._logCommand(`specify param ${param}`);
                this._writeRegister(this._regs[Registers.internalPointer], param);
                ++this._regs[Registers.internalPointer];
                if (--this._regs[Registers.internalParamCount] === 0) {
                    this._finishSimpleCommand();
                }
                break;
            }
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
                // double sided discs.
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
     * @param {DriveOut} driveOut 
     */
    _setDriveOut(driveOut) {
        if (this._currentDrive) this._currentDrive.stopSpinning();
        this._currentDrive = null;

        // Note: unclear what to do if both drives are selected. We select no drive
        // for now, to avoid shenanigans.
        const selectBits = driveOut & DriveOut.selectFlags;
        if (selectBits === DriveOut.select_0) this._currentDrive = this._drives[0];
        else if (selectBits == DriveOut.select_1) this._currentDrive = this._drives[1];

        if (this._currentDrive) {
            if (driveOut & DriveOut.loadHead) this._currentDrive.startSpinning();
            this._currentDrive.selectSide(!!(driveOut & DriveOut.side));
        }
        this._driveOut = driveOut;
    }

    /**
     * @param {State} state 
     */
    _setState(state) {
        this._state = state;
        this._stateCount = 0;
        if (state === State.syncingForId || state === State.syncingForData) {
            this._shiftRegister = 0;
            this._numShifts = 0;
        }
    }

    /**
     * @param {Call} callContext
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
            (this._trk0 && this._regs[Registers.internalParam_2] === 0) || // Seek to 0 done, TRK0 detected
            this._regs[Registers.internalSeekCount] === 0
        ) {
            this._doLoadHead();
            return;
        }
        //  We're going to actually step so we'll need settle if the head is already loaded.
        this._didSeekStep = true;
        this._regs[Registers.internalSeekCount]--;

        if (this._currentDrive) this._currentDrive.seekTrack(this._driveOut & DriveOut.direction ? 1 : -1);

        let stepRate = this._regs[Registers.headStepRate];
        if (stepRate === 0) {
            // Step rate is up to the drive. Let's say 3ms.
            stepRate = 3;
        } else {
            // The datasheet is ambiguous about whether the units are 1ms or 2ms for 5.25" drives. 1ms might be your best guess from the datasheet, but timing on a real machine, it appears to be 2ms.
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
            this._setTimerMs(TimerState.postStep, postSeekTimeMs);
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
                this._pulsesCallback = IndexPulse.startReadId;
                break;
            case Call.format:
                this._setupSectorSize();
                this._pulsesCallback = IndexPulse.startFormat;
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
            `command ${utils.hexbyte(origCommand & 0x3f)} sel ${utils.hexbyte(selectBits)} params ${utils.hexbyte(this._regs[Registers.internalParam_1])} ${utils.hexbyte(this._regs[Registers.internalParam_2])} ${utils.hexbyte(this._regs[Registers.internalParam_3])} ${utils.hexbyte(this._regs[Registers.internalParam_4])} ${utils.hexbyte(this._regs[Registers.internalParam_5])} ptrk ${this._currentDrive ? this._currentDrive.track : -1} hpos ${this._currentDrive ? this._currentDrive.headPosition : -1}`,
        );

        const command = this._internalCommand;
        if (command === Command.scanData || command === Command.scanDataAndDeleted) {
            this._log("scan sectrors doesn't work in a beeb");
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
        // Note: on @scarybeasts' machine, bit 7 and bit 0 appear to be always set.
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
                if (this._regs[Registers.internalParam_2] == 0) {
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

    _clearCallbacks() {
        this._paramCallback = ParamAccept.none;
        this._indexPulseCallback = IndexPulse.none;
        if (this._timerState !== TimerState.none) {
            this._timerTask.cancel();
            this._timerState = TimerState.none;
        }
        // Think of this as the read/write callback from the bit processor.
        this._state = State.idle;
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
}
