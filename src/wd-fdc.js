// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502.js";
// eslint-disable-next-line no-unused-vars
import { BaseDiscDrive, DiscDrive } from "./disc-drive.js";
import { IbmDiscFormat } from "./disc.js";
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
import * as utils from "./utils.js";

/**
 * Commands.
 *
 * @readonly
 * @enum {Number}
 */
const Command = Object.freeze({
    restore: 0x00,
    seek: 0x10,
    stepInNoUpdate: 0x40,
    stepInWithUpdate: 0x50,
    stepOutNoUpdate: 0x60,
    stepOutWithUpdate: 0x70,
    readSector: 0x80,
    readSectorMulti: 0x90,
    writeSector: 0xa0,
    writeSectorMulti: 0xb0,
    readAddress: 0xc0,
    forceInterrupt: 0xd0,
    readTrack: 0xe0,
    writeTrack: 0xf0,
});

/**
 * Command bits.
 *
 * @readonly
 * @enum {Number}
 */
const CommandBits = Object.freeze({
    typeIIMulti: 0x10,
    disableSpinUp: 0x08,
    typeIVerify: 0x04,
    typeIIorIIISettle: 0x04,
    typeIIDeleted: 0x01,
});

/**
 * The drive control register is documented here:
 * https://www.cloud9.co.uk/james/BBCMicro/Documentation/wd1770.html
 *
 * @readonly
 * @enum {Number}
 */
const Control = Object.freeze({
    reset: 0x20,
    density: 0x08,
    side: 0x04,
    drive1: 0x02,
    drive0: 0x01,
});

/**
 * Status bits.
 *
 * @readonly
 * @enum {Number}
 */
const Status = Object.freeze({
    motorOn: 0x80,
    writeProtected: 0x40,
    typeISpinUpDone: 0x20,
    typeIIorIIIDeletedMark: 0x20,
    recordNotFound: 0x10,
    crcError: 0x08,
    typeITrack0: 0x04,
    typeIIorIIILostByte: 0x04,
    typeIIndex: 0x02,
    typeIIorIIIDrq: 0x02,
    busy: 0x01,
});

/**
 * Controller state.
 *
 * @readonly
 * @enum {Number}
 */
const State = Object.freeze({
    null: 0,
    idle: 1,
    timerWait: 2,
    spinUpWait: 3,
    waitIndex: 4,
    searchId: 5,
    inId: 6,
    searchData: 7,
    inData: 8,
    inReadTrack: 8,
    writeSectorDelay: 9,
    writeSectorLeadInFm: 10,
    writeSectorLeadInMfm: 11,
    writeSectorMarkerFm: 12,
    writeSectorMarkerMfm: 13,
    writeSectorBody: 14,
    writeTrackSetup: 15,
    inWriteTrack: 16,
    checkMulti: 17,
    done: 18,
});

/**
 * Timer state.
 *
 * @readonly
 * @enum {Number}
 */
const TimerState = Object.freeze({
    none: 1,
    settle: 2,
    seek: 3,
    done: 4,
});

export class WdFdc {
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

        this._isMaster = cpu.model.isMaster;
        this._is1772 = false; // TODO - if we ever support Master Compact
        this._isOpus = false; // TODO - if we ever support Opus

        this._controlRegister = 0;
        /** @type {Status|Number} */
        this._statusRegister = 0;
        this._trackRegister = 0;
        this._sectorRegister = 0;
        this._dataRegister = 0;
        this._isIntRq = false;
        this._isDrq = false;
        this._doRaiseIntRq = false;

        /** @type {BaseDiscDrive|null} */
        this._currentDrive = null;
        this._isIndexPulse = false;
        this._isInterruptOnIndexPulse = false;
        this._isWriteTrackCrcSecondByte = false;
        this._command = 0;
        this._commandType = 0;
        this._isCommandSettle = false;
        this._isCommandWrite = false;
        this._isCommandVerify = false;
        this._isCommandMulti = false;
        this._isCommandDeleted = false;

        this._commandStepRateMs = 0;
        this._state = State.idle;
        this._timerState = TimerState.none;
        this._timerTask = scheduler.newTask(() => this._timerFired());
        this._stateCount = 0;
        this._indexPulseCount = 0;
        this._markDetector = 0n;
        this._dataShifter = 0;
        this._dataShiftCount = 0;
        this._deliverData = 0;
        this._deliverIsMarker = false;
        this._crc = 0;
        this._onDiscTrack = 0;
        this._onDiscSector = 0;
        this._onDiscLength = 0;
        this._onDiscCrc = 0;
        this._lastMfmBit = false;

        this._logCommands = debugFlags ? !!debugFlags.logFdcCommands : false;
        this._logStateChanges = debugFlags ? !!debugFlags.logFdcStateChanges : false;

        const callback = (pulses, count) => this._pulsesCallback(pulses, count);
        for (const drive of this._drives) drive.setPulsesCallback(callback);

        this.powerOnReset();
    }

    reset() {
        // This will:
        // - Spin down.
        // - Raise reset, which:
        // - Clears status register.
        // - Sets other registers as per how a real machine behaves.
        // - Clears IRQs.
        this._writeControl(0);
    }

    powerOnReset() {
        this.reset();
        // The reset line doesn't seem to affect the track or data registers.
        this._trackRegister = 0;
        this._dataRegister = 0;
    }

    _updateNmi() {
        const newLevel = this._isDrq | (this._isOpus ? false : this._isIntRq);
        // TODO: the cpu handling of NMIs is bad here. Should update to handle multiple
        // NMI/interrupt sources. And when we do go back and implement the checks in the beebjit
        // source here too.
        this._cpu.NMI(newLevel);
    }

    /**
     * @param {boolean} level
     */
    _setIntRq(level) {
        this._isIntRq = level;
        this._updateNmi();
    }

    /**
     * @param {boolean} level
     */
    _setDrq(level) {
        this._isDrq = level;
        if (level) {
            if (this._statusRegister & Status.typeIIorIIIDrq) {
                this._statusRegister |= Status.typeIIorIIILostByte;
            }
            this._statusRegister |= Status.typeIIorIIIDrq;
        } else {
            this._statusRegister &= ~Status.typeIIorIIIDrq;
        }
        this._updateNmi();
    }

    _log(message) {
        console.log(`WD1770: ${message}`);
    }

    _logCommand(message) {
        if (this._logCommands) this._log(message);
    }

    _opusRemapAddr(addr) {
        return addr ^ 4;
    }

    _opusRemapVal(addr, val) {
        // Only remap control register values.
        if (addr >= 4) return val;
        let remapped = Control.reset;
        if (val & 0x01) remapped |= Control.drive0;
        else remapped |= Control.drive1;
        if (val & 0x02) remapped |= Control.side;
        if (val & 0x40) remapped |= Control.density;
        return remapped;
    }

    _masterRemapVal(addr, val) {
        // Only remap control register values.
        if (addr >= 4) return val;
        let remapped = 0;
        if (val & 0x04) remapped |= Control.reset;
        if (val & 0x01) remapped |= Control.drive0;
        if (val & 0x02) remapped |= Control.drive1;
        if (val & 0x10) remapped |= Control.side;
        if (val & 0x20) remapped |= Control.density;
        return remapped;
    }

    _remapVal(addr, val) {
        if (this._isMaster) return this._masterRemapVal(addr, val);
        if (this._isOpus) return this._opusRemapVal(addr, val);
        return val;
    }

    _remapAddr(addr) {
        addr &= 0x07;
        if (this._isMaster) return addr ^ 0x04;
        if (this._isOpus) return this._opusRemapAddr(addr);
        return addr;
    }

    /**
     * @param {Number} addr hardware address
     * @returns {Number} byte at the given hardware address
     */
    read(addr) {
        switch (this._remapAddr(addr)) {
            case 4:
                // Reading status register clears INTRQ.
                this._setIntRq(false);
                return this._statusRegister;
            case 5:
                return this._trackRegister;
            case 6:
                return this._sectorRegister;
            case 7:
                if (this._commandType === 2 || this._commandType === 3) {
                    this._setDrq(false);
                }
                return this._dataRegister;
            case 0:
            case 1:
            case 2:
            case 3:
                break;
        }
        return 0xfe;
    }

    /**
     * @param {Number} addr hardware address
     * @param {Number} val byte to write
     */
    write(addr, val) {
        addr = this._remapAddr(addr);
        val = this._remapVal(addr, val);
        switch (addr) {
            case 0:
            case 1:
            case 2:
            case 3:
                this._logCommand(`control register now ${utils.hexbyte(val)}`);
                if (this._statusRegister & Status.busy && !this._isReset(val)) {
                    throw new Error(`Control register updated while busy; without reset`);
                }
                this._writeControl(val);
                break;
            case 4:
                // Ignore commands while in reset.
                if (!this._isReset(this._controlRegister)) this._doCommand(val);
                break;
            case 5:
                this._logCommand(`track register now ${val}`);
                this._trackRegister = val;
                break;
            case 6:
                // Ignore sector reg changes in reset; note that track/data registers will still be accepted.
                if (!this._isReset(this._controlRegister)) {
                    this._logCommand(`sector register now ${val}`);
                    this._sectorRegister = val;
                } else {
                    this._logCommand(`ignoring sector write of ${val}`);
                }
                break;
            case 7:
                if (this._commandType === 2 || this._commandType === 3) {
                    this._setDrq(false);
                }
                this._dataRegister = val;
                break;
        }
    }

    _doCommand(val) {
        if (!this._currentDrive) throw new Error("Command while no selected drive");
        this._logCommand(
            `command ${utils.hexbyte(val)} tr ${this._trackRegister} sr ${this._sectorRegister} dr ${this._dataRegister} ` +
                `cr ${utils.hexbyte(this._controlRegister)} ` +
                `ptrk ${this._currentDrive.track} hpos ${this._currentDrive.headPosition}`,
        );
        const command = val & 0xf0;

        if (command === Command.forceInterrupt) {
            this._handleForceInterrupt(val);
            return;
        }
        if (this._statusRegister & Status.busy) {
            // EMU NOTE: this is a very murky area. There does not appear to be a simple
            // rule here. Whether a command will do anything when busy seems to depend on
            // the current command, the new command and also the current place in the
            // internal state machine!
            this._log(`command ${utils.hexbyte(val)} while busy with ${utils.hexbyte(this._command)} - ignoring`);
            return;
        }

        this._command = command;
        this._isCommandSettle = false;
        this._isCommandWrite = false;
        this._isCommandVerify = false;
        this._isCommandMulti = false;
        this._isCommandDeleted = false;
        this._isInterruptOnIndexPulse = false;
        this._isWriteTrackCrcSecondByte = false;

        switch (command) {
            case Command.restore:
            case Command.seek:
            case Command.stepInNoUpdate:
            case Command.stepInWithUpdate:
            case Command.stepOutNoUpdate:
            case Command.stepOutWithUpdate:
                this._commandType = 1;
                this._isCommandVerify = !!(val & CommandBits.typeIVerify);
                this._commandStepRateMs = this._stepRateMsFor(val);
                break;
            case Command.readSector:
            case Command.readSectorMulti:
            case Command.writeSector:
            case Command.writeSectorMulti:
                this._commandType = 2;
                this._isCommandMulti = !!(val & CommandBits.typeIIMulti);
                break;
            case Command.readAddress:
            case Command.readTrack:
            case Command.writeTrack:
                this._commandType = 3;
                break;
            default:
                throw new Error(`unimplemented command ${utils.hexbyte(val)}`);
        }
        if (this._commandType === 2 || (this._commandType === 3 && val & CommandBits.typeIIorIIISettle))
            this._isCommandSettle = true;
        if (
            this._command === Command.writeSector ||
            this._command === Command.writeSectorMulti ||
            this._command === Command.writeTrack
        ) {
            this._isCommandWrite = true;
            this._isCommandDeleted = !!(val & CommandBits.typeIIDeleted);
        }
        // All commands except force interrupt (handled above):
        // - Clear INTRQ and DRQ.
        // - Clear status register result bits.
        // - Set busy.
        // - Spin up if necessary and not inhibited.
        this._setDrq(false);
        this._setIntRq(false);
        this._statusRegister = (this._statusRegister & Status.motorOn) | Status.busy;

        this._indexPulseCount = 0;
        if (this._statusRegister & Status.motorOn) {
            // Short circuit spin-up if motor is on.
            this._dispatchCommand();
        } else {
            this._statusRegister |= Status.motorOn;
            this._currentDrive.startSpinning();
            // Short circuit spin-up if command requests it.
            // /* NOTE: disabling spin-up wait is a strange facility. It makes a lot of
            // sense for a seek because the disc head can usefully get moving while the
            // motor is spinning up. But other commands like a read track also seem to
            // start immediately. It is unclear whether such a command would be
            // unreliable on a drive that takes a while to come up to speed.
            if (val & CommandBits.disableSpinUp) {
                this._indexPulseCount = 6;
                this._log(`command ${utils.hexbyte(val)} spin up wait disabled, motor was off`);
                this._dispatchCommand();
            } else {
                this._setState(State.spinUpWait);
            }
        }
    }

    /**
     * @param {State|Number} state
     */
    _setState(state) {
        if (this._logStateChanges && state !== this._state) {
            this._log(
                `State ${this._state} -> ${state} @ tr ${this._trackRegister} ` +
                    `sr ${this._sectorRegister} dr ${this._dataRegister} ` +
                    `cr ${utils.hexbyte(this._controlRegister)} ` +
                    `ptrk ${this._currentDrive.track} hpos ${this._currentDrive.headPosition}`,
            );
        }
        this._state = state;
        this._stateCount = 0;
    }

    _clearTimer() {
        if (this._timerState !== TimerState.none) {
            this._timerTask.cancel();
            this._timerState = TimerState.none;
        }
    }

    _clearState() {
        this._setState(State.idle);
        this._clearTimer();
        this._indexPulseCount = 0;
    }

    _stepRateMsFor(val) {
        switch (val & 0x03) {
            case 0:
                return 6;
            case 1:
                return 12;
            case 2:
                return this._is1772 ? 2 : 20;
            case 3:
                return this._is1772 ? 3 : 30;
        }
    }

    _handleForceInterrupt(val) {
        const forceInterruptBits = val & 0x0f;
        // EMU NOTE: force interrupt is pretty unclear on the datasheet. From
        // testing on a real 1772:
        // - The command is aborted right away in all cases.
        // - The command completion INTRQ / NMI is _inhibited_ for $D0. In
        //   particular, Watford Electronics DDFS will be unhappy unless you behave
        //   correctly here.
        // - Force interrupt will spin up the motor and enter an idle state if
        //   the motor is off. The idle state behaves a little like a type 1 command
        //   insofar as index pulse appears to be reported in the status register.
        // - Interrupt on index pulse is only active for the current command.
        if (this._statusRegister & Status.busy) {
            this._commandDone(false);
        } else {
            if (this._state !== State.idle) throw new Error(`Unexpected state when force interrupt: ${this._state}`);
            this._indexPulseCount = 0;
            this._commandType = 1;
            this._statusRegister &= Status.motorOn;
            if (!(this._statusRegister & Status.motorOn)) {
                this._statusRegister |= Status.motorOn;
                this._currentDrive.startSpinning();
            }
        }
        if (forceInterruptBits === 0) {
            this._isInterruptOnIndexPulse = false;
        } else if (forceInterruptBits === 4) {
            this._isInterruptOnIndexPulse = true;
        } else {
            throw new Error(`1700 force interrupt flags not handled: ${forceInterruptBits}`);
        }
    }

    _timerFired() {
        if (!(this._statusRegister & Status.busy)) throw new Error("Should be busy");
        const timerState = this._timerState;
        this._timerState = TimerState.none;
        switch (timerState) {
            case TimerState.settle:
                this._dispatchCommand();
                break;
            case TimerState.seek:
                if (
                    this._command === Command.stepInNoUpdate ||
                    this._command === Command.stepInWithUpdate ||
                    this._command === Command.stepOutNoUpdate ||
                    this._command === Command.stepOutWithUpdate
                )
                    this._checkVerify();
                else this._doSeekStepOrVerify();
                break;
            case TimerState.done:
                this._doneTimer();
                break;
            default:
                throw new Error(`Unexpected timer state ${timerState}`);
        }
    }

    /**
     * @param {Control} value
     */
    _isSide(value) {
        return !!(value & Control.side);
    }

    /**
     * @param {Control} value
     */
    _isDoubleDensity(value) {
        // Double density (MFM) is active low.
        return !(value & Control.density);
    }

    /**
     * @param {Control} value
     */
    _isReset(value) {
        // Reset is active low.
        return !(value & Control.reset);
    }

    /**
     * @param {Control|Number} val
     */
    _writeControl(val) {
        const isMotorOn = !!(this._statusRegister & Status.motorOn);
        if (this._currentDrive && this._currentDrive.spinning) {
            if (!isMotorOn) {
                throw new Error(
                    `Unexpected motor control bit off when setting the control register to ${utils.hexbyte(val)}`,
                );
            }
            this._currentDrive.stopSpinning();
        }
        if (val & Control.drive0 || val & Control.drive1) {
            this._currentDrive = this._drives[val & Control.drive0 ? 0 : 1];
        } else {
            this._currentDrive = null;
        }
        if (this._currentDrive) {
            if (isMotorOn) this._currentDrive.startSpinning();
            this._currentDrive.selectSide(this._isSide(val));
        }

        // Set up single or double density
        for (const drive of this._drives) drive.set32usMode(this._isDoubleDensity(val));

        this._controlRegister = val;

        if (this._isReset(val)) {
            // Go idle, etc
            this._clearState();
            if (this._currentDrive && isMotorOn) this._currentDrive.stopSpinning();
            this._statusRegister = 0;

            // EMU NOTE: on a real machine, the reset condition appears to hold the
            // sector register at 1 but leave track / data alone (and permit changes
            // to them).
            this._sectorRegister = 1;
            this._isIntRq = false;
            this._isDrq = false;
            this._updateNmi();

            this._markDetector = 0n;
            this._dataShifter = 0;
            this._dataShiftCount = 0;
            this._isIndexPulse = false;
            this._lastMfmBit = false;
            this._deliverData = 0;
            this._deliverIsMarker = false;
        }
    }

    _makeSeekNoise(delta) {
        if (this._currentDrive) this._currentDrive.notifySeekAmount(delta);
    }

    _dispatchCommand() {
        if (!this._currentDrive) throw new Error("Unexpectedly dispatching a command with no drive set");
        if (this._isCommandWrite && this._currentDrive.writeProtect) {
            this._statusRegister |= Status.writeProtected;
            this._commandDone(true);
            return;
        }

        switch (this._command) {
            case Command.restore:
                this._trackRegister = 0xff;
                this._logCommand(`track register now ${this._trackRegister}`);
                this._dataRegister = 0;
            // Falls through...
            case Command.seek:
                this._doSeekStepOrVerify();
                this._makeSeekNoise(this._dataRegister - this._trackRegister);
                break;
            case Command.stepInNoUpdate:
                this._doSeekStep(1, false);
                this._makeSeekNoise(1);
                break;
            case Command.stepInWithUpdate:
                this._doSeekStep(1, true);
                this._makeSeekNoise(1);
                break;
            case Command.stepOutNoUpdate:
                this._doSeekStep(-1, false);
                this._makeSeekNoise(-1);
                break;
            case Command.stepOutWithUpdate:
                this._doSeekStep(-1, true);
                this._makeSeekNoise(-1);
                break;
            case Command.readSector:
            case Command.readSectorMulti:
            case Command.writeSector:
            case Command.writeSectorMulti:
            case Command.readAddress:
                this._setState(State.searchId);
                this._indexPulseCount = 0;
                break;
            case Command.readTrack:
                this._setState(State.waitIndex);
                this._indexPulseCount = 0;
                break;
            case Command.writeTrack:
                this._setState(State.writeTrackSetup);
                this._indexPulseCount = 0;
                break;
            default:
                throw new Error(`Invalid command ${this._command} in dispatch`);
        }
    }

    _pulsesCallback(pulses, count) {
        // This callback routine is also used for seek/settle timing which not a precise 64us basis.
        if (!this._currentDrive || !this._currentDrive.spinning || !(this._statusRegister & Status.motorOn)) {
            throw new Error("Something unfortunate happened in the 1770 pulses callback");
        }
        const wasIndexPulse = this._isIndexPulse;
        this._isIndexPulse = this._currentDrive.indexPulse;
        const isIndexPulsePositiveEdge = this._isIndexPulse && !wasIndexPulse;
        const isMfm = count === 16;

        if (this._isInterruptOnIndexPulse && isIndexPulsePositiveEdge) this._setIntRq(true);

        // EMU Note: if the chip is idle after copmletion of a type I command, this index pulse and
        // track 0 bits appear maintained. They disappear on spin-down.
        this._updateTypeIStatusBits();

        switch (this._state) {
            case State.idle:
                this._pulsesCallbackIdle();
                break;
            case State.timerWait:
                break;
            case State.spinUpWait:
                this._pulsesCallbackSpinUpWait();
                break;
            case State.waitIndex:
                if (isIndexPulsePositiveEdge) {
                    this._setState(State.inReadTrack);
                    // Need to include this byte (directly after the index pulse) in the read
                    // track data. Confirmed with a real 1772 & Gotek.
                    this._bitstreamReceived(pulses, count, false);
                }
                break;
            case State.searchId:
            case State.inId:
            case State.searchData:
            case State.inData:
            case State.readTrack:
                this._bitstreamReceived(pulses, count, isIndexPulsePositiveEdge);
                if (this._indexPulseCount >= 6) {
                    this._statusRegister |= Status.recordNotFound;
                    this._commandDone(true);
                }
                break;
            case State.writeSectorDelay:
                this._pulsesCallbackSectorDelay(isMfm);
                break;
            case State.writeSectorLeadInFm:
                this._writeByte(isMfm, 0x00, false);
                if (++this._stateCount === 6) this._setState(State.writeSectorMarkerFm);
                break;
            case State.writeSectorLeadInMfm:
                if (this._stateCount >= 11) this._writeByte(isMfm, 0x00, false);
                if (++this._stateCount === 23) this._setState(State.writeSectorMarkerMfm);
                break;
            case State.writeSectorMarkerFm: {
                const dataByte = this._isCommandDeleted
                    ? IbmDiscFormat.deletedDataMarkDataPattern
                    : IbmDiscFormat.dataMarkDataPattern;
                this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(false), dataByte);
                this._writeByte(false, dataByte, true);
                this._setState(State.writeSectorBody);
                break;
            }
            case State.writeSectorMarkerMfm:
                this._pulsesCallbackWriteSectorMarkerMfm();
                break;
            case State.writeSectorBody:
                this._pulsesCallbackWriteSectorBody(isMfm);
                break;
            case State.checkMulti:
                if (this._isCommandMulti) {
                    this._sectorRegister++;
                    this._indexPulseCount = 0;
                    this._setState(State.searchId);
                } else {
                    this._commandDone(true);
                }
                break;
            case State.writeTrackSetup:
                this._pulsesCallbackWriteTrackSetup();
                break;
            case State.inWriteTrack:
                this._pulsesCallbackInWriteTrack(isMfm, isIndexPulsePositiveEdge);
                break;
            case State.done:
                this._commandDone(true);
                break;
            default:
                throw new Error(`Unexpected state ${this._state}`);
        }

        if (isIndexPulsePositiveEdge) this._indexPulseCount++;
    }

    _pulsesCallbackIdle() {
        if (this._statusRegister & Status.busy) throw new Error("Unexpectedly busy in idle state");
        // different sources disagree on 10 vs 9 index pulses for spin down.
        if (this._indexPulseCount < 9) return;
        this._logCommand("automatic motor off");
        this._currentDrive.stopSpinning();
        this._statusRegister &= ~Status.motorOn;
        // In @scarybeasts's testing on a 1772 the polled type 1 status bits get cleared on spin down.
        if (this._commandType === 1) {
            this._statusRegister &= ~(Status.typeITrack0 | Status.typeIIndex);
        }
    }

    _pulsesCallbackSpinUpWait() {
        if (this._indexPulseCount < 6) return;
        if (this._commandType === 1) this._statusRegister |= Status.typeISpinUpDone;
        if (this._isCommandSettle) {
            const settleMs = this._is1772 ? 15 : 30;
            this._startTimer(TimerState.settle, settleMs * 1000);
        } else {
            this._dispatchCommand();
        }
    }

    _pulsesCallbackSectorDelay(isMfm) {
        // Following the data sheet here for byte-for-byte behaviour.
        if (this._stateCount === 0) {
            this._indexPulseCount = 0;
        } else if (this._stateCount === 1) {
            this._setDrq(true);
        } else if (this._stateCount === 10 && this._statusRegister & Status.typeIIorIIIDrq) {
            this._statusRegister |= Status.typeIIorIIILostByte;
            this._commandDone(true);
        }
        this._stateCount++;
        if (this._stateCount === 12) this._setState(isMfm ? State.writeSectorLeadInMfm : State.writeSectorLeadInFm);
    }

    _pulsesCallbackWriteSectorMarkerMfm() {
        if (this._stateCount < 3) this._writeByte(true, 0xa1, true);
        if (++this._stateCount === 4) {
            const dataByte = this._isCommandDeleted
                ? IbmDiscFormat.deletedDataMarkDataPattern
                : IbmDiscFormat.dataMarkDataPattern;
            this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(true), dataByte);
            this._writeByte(true, dataByte, false);
            this._setState(State.writeSectorBody);
        }
    }

    _pulsesCallbackWriteSectorBody(isMfm) {
        if (this._stateCount < this._onDiscLength) {
            let dataByte = this._dataRegister;
            if (this._statusRegister & Status.typeIIorIIIDrq) {
                dataByte = 0;
                this._statusRegister |= Status.typeIIorIIILostByte;
            }
            this._crc = IbmDiscFormat.crcAddByte(this._crc, dataByte);
            this._writeByte(isMfm, dataByte, false);
            if (this._stateCount !== this._onDiscLength - 1) this._setDrq(true);
        } else if (this._stateCount < this._onDiscLength + 2) {
            this._writeByte(isMfm, (this._crc >>> 8) & 0xff, false);
            this._crc = (this._crc << 8) & 0xffff;
        } else {
            this._writeByte(isMfm, 0xff, false);
            this._setState(State.checkMulti);
        }
        this._stateCount++;
    }

    _pulsesCallbackWriteTrackSetup() {
        if (this._stateCount === 0) {
            this._indexPulseCount = 0;
            this._setDrq(true);
        } else if (this._stateCount === 3) {
            if (this._statusRegister & Status.typeIIorIIIDrq) {
                this._statusRegister |= Status.typeIIorIIILostByte;
                this._commandDone(true);
            } else {
                this._setState(State.inWriteTrack);
                return;
            }
        }
        this._stateCount++;
    }

    _pulsesCallbackInWriteTrack(isMfm, isIndexPulsePositiveEdge) {
        if (this._stateCount === 0 && !isIndexPulsePositiveEdge) return;
        if (this._stateCount > 0 && isIndexPulsePositiveEdge) {
            this._commandDone(true);
            return;
        }
        if (this._isWriteTrackCrcSecondByte) {
            this._writeByte(isMfm, this._crc & 0xff, false);
            this._isWriteTrackCrcSecondByte = false;
            this._setDrq(true);
            return;
        }
        let dataByte = this._dataRegister;
        if (this._statusRegister & Status.typeIIorIIIDrq) {
            dataByte = 0;
            this._statusRegister |= Status.typeIIorIIILostByte;
        }
        let isMarker = false;
        let isPresetCrc = false;
        switch (dataByte) {
            // 0xF5 and 0xF6 are documented as "not allowed" in FM mode. They
            // actually write 0xA1 / 0xC2 respectively, as per MFM, but it's not
            // known whether any clock bits are omitted, or whether CRC is preset,
            // so bailing for now rather than guessing.
            case 0xf5:
                if (!isMfm) throw new Error("Unhandled 0xf5 in FM");
                isMarker = true;
                isPresetCrc = true;
                dataByte = 0xa1;
                break;
            case 0xf6:
                if (!isMfm) throw new Error("Unhandled 0xf6 in FM");
                isMarker = true;
                dataByte = 0xc2;
                break;
            case 0xf8:
            case 0xf9:
            case 0xfa:
            case 0xfb:
            case 0xfe:
                if (!isMfm) {
                    isMarker = true;
                    isPresetCrc = true;
                }
                break;
            case 0xfc:
                if (!isMfm) isMarker = true;
                break;
            default:
                break;
        }
        if (isPresetCrc) {
            this._crc = IbmDiscFormat.crcInit(isMfm);
        }
        if (dataByte === 0xf7) {
            this._writeByte(isMfm, (this._crc >>> 8) & 0xff, false);
            this._isWriteTrackCrcSecondByte = true;
        } else {
            this._writeByte(isMfm, dataByte, isMarker);
            if (isMfm && isPresetCrc) {
                // Nothing.
            } else {
                this._crc = IbmDiscFormat.crcAddByte(this._crc, dataByte);
            }
            this._setDrq(true);
        }
        this._stateCount++;
    }

    _markDetectorTriggered() {
        if (this._isDoubleDensity(this._controlRegister)) {
            // EMU NOTE: unsure as to exactly when MFM sync bytes are spotted. Here we look for MFM 0x00 then MFM 0xa1 (sync).
            // The documented sequence is 12 0x00, 3x 0xa1 (sync).
            if ((this._markDetector & 0xffffffffn) === 0xaaaa4489n) {
                this._deliverData = 0xa1;
                return true;
            }
            // TODO: sync to c2 (5224).
            // Note than an early, naive attempt had it triggered in in the middle of the sector data,
            // so we'll need to study how it actually works in detail.
            // Tag the byte after 3 sync bytes as a marker.
            if ((this._markDetector & 0xffffffffffff0000n) === 0x4489448944890000n) {
                this._deliverIsMarker = true;
            }
        } else {
            // The FM mark detector appears to need 4 data bits' worth of zeros, with clock bits set to 1, to be able to trigger.
            // Tried on @scarybeasts's real 1772-based machine.
            if ((this._markDetector & 0x0000ffff00000000n) === 0x0000888800000000n) {
                const { clocks, data, iffyPulses } = IbmDiscFormat._2usPulsesToFm(
                    Number(this._markDetector & 0xffffffffn),
                );
                if (!iffyPulses && clocks === 0xc7) {
                    // TODO: see http://info-coach.fr/atari/documents/_mydoc/WD1772-JLG.pdf
                    // This suggests that a wider ranges of byte values will function as markers. It may also differ FM vs. MFM.
                    if (data === 0xf8 || data === 0xfb || data === 0xfe) {
                        // Resync to marker.
                        this._deliverData = data;
                        this._deliverIsMarker = true;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * @param {boolean} bit
     */
    _bitReceived(bit) {
        // Always run the mark detector. For a command like "read track", the 1770
        // will re-sync in the middle of the command as appropriate.
        this._markDetector = ((this._markDetector << 1n) & 0xffffffffffffffffn) | (bit ? 1n : 0n);
        if (this._markDetectorTriggered()) {
            this._dataShifter = 0;
            this._dataShiftCount = 0;
            return;
        }

        this._dataShifter = ((this._dataShifter << 1) | (bit ? 1 : 0)) & 0xffffffff;
        this._dataShiftCount++;
        if (this._isDoubleDensity(this._controlRegister)) {
            if (this._dataShiftCount === 16) {
                this._deliverData = IbmDiscFormat._2usPulsesToMfm(this._dataShifter);
                this._dataShifter = 0;
                this._dataShiftCount = 0;
            }
        } else {
            if (this._dataShiftCount === 32) {
                const { data, iffyPulses } = IbmDiscFormat._2usPulsesToFm(this._dataShifter);
                // If we're reading MFM as FM, the pulses won't all fall on 4us boundaries. This is fuzzy bits;
                // we'll return a non-stable read.
                if (iffyPulses) {
                    const { data: unstableBits } = IbmDiscFormat._2usPulsesToFm(
                        this._currentDrive.getQuasiRandomPulses(),
                    );
                    this._deliverData = unstableBits;
                } else {
                    this._deliverData = data;
                }
                this._dataShifter = 0;
                this._dataShiftCount = 0;
            }
        }
    }

    _bitstreamReceived(pulses, pulsesCount, isIndexPulsePositiveEdge) {
        pulses = (pulses << (32 - pulsesCount)) & 0xffffffff;
        for (let i = 0; i < pulsesCount; ++i) {
            this._bitReceived(!!(pulses & 0x80000000));
            pulses = (pulses << 1) & 0xffffffff;
        }
        this._byteReceived(isIndexPulsePositiveEdge);
    }

    /**
     * @param {boolean} isMfm
     * @param {Number} byte
     * @param {boolean} isMarker
     */
    _writeByte(isMfm, byte, isMarker) {
        let pulses;
        if (isMfm) {
            if (isMarker) pulses = this._mfmMarkerFor(byte);
            else {
                const result = IbmDiscFormat.mfmTo2usPulses(this._lastMfmBit, byte);
                this._lastMfmBit = result.lastBit;
                pulses = result.pulses;
            }
        } else {
            const clocks = isMarker ? this._fmMarkerClocksFor(byte) : 0xff;
            pulses = IbmDiscFormat.fmTo2usPulses(clocks, byte);
        }
        this._currentDrive.writePulses(pulses);
    }

    _fmMarkerClocksFor(byte) {
        switch (byte) {
            case 0xfc:
                return 0xd7;
            case 0xf8:
            case 0xf9:
            case 0xfa:
            case 0xfb:
            case 0xfe:
                return IbmDiscFormat.markClockPattern;
        }
    }

    _mfmMarkerFor(byte) {
        switch (byte) {
            case 0xa1:
                return IbmDiscFormat.mfmA1Sync;
            case 0xc2:
                return IbmDiscFormat.mfmC2Sync;
            default:
                throw new Error(`Bad marker byte ${utils.hexbyte(byte)}`);
        }
    }

    _updateTypeIStatusBits() {
        if (this._commandType !== 1) return;
        this._statusRegister &= ~(Status.typeITrack0 | Status.typeIIndex);
        if (this._currentDrive.track === 0) this._statusRegister |= Status.typeITrack0;
        if (this._currentDrive.indexPulse) this._statusRegister |= Status.typeIIndex;
    }

    _startTimer(timerState, waitUs) {
        if (!(this._statusRegister & Status.busy)) throw new Error("Should be busy");
        if (this._timerState !== TimerState.none) throw new Error("Timer started but still running");
        this._timerTask.cancel();
        this._timerState = timerState;
        this._setState(State.timerWait);
        this._timerTask.schedule(waitUs * 2);
    }

    _commandDone(doRaiseIntRq) {
        if (!(this._statusRegister & Status.busy)) throw new Error("Should be busy");
        this._doRaiseIntRq = doRaiseIntRq;
        this._startTimer(TimerState.done, 32);
    }

    _doneTimer() {
        this._statusRegister &= ~Status.busy;
        this._clearState();
        // Make sure the status are up to date.
        this._updateTypeIStatusBits();

        // EMU NOTE: leave DRQ alone, if it is raised, leave it raised.
        if (this._doRaiseIntRq) this._setIntRq(true);

        this._logCommand(`result status ${utils.hexbyte(this._statusRegister)}`);
    }

    _checkVerify() {
        if (this._isCommandVerify) {
            this._indexPulseCount = 0;
            this._setState(State.searchId);
        } else {
            this._commandDone(true);
        }
    }

    _doSeekStep(stepDirection, doUpdateTr) {
        this._currentDrive.seekOneTrack(stepDirection);
        if (doUpdateTr) this._trackRegister += stepDirection;
        // TRK0 signal may have been raised or lowered.
        this._updateTypeIStatusBits();
        this._startTimer(TimerState.seek, this._commandStepRateMs * 1000);
    }

    _doSeekStepOrVerify() {
        if (this._trackRegister === this._dataRegister) {
            this._checkVerify();
            return;
        }
        const stepDirection = this._trackRegister > this._dataRegister ? -1 : 1;
        if (this._currentDrive.track === 0 && stepDirection === -1) {
            this._trackRegister = 0;
            this._checkVerify();
            return;
        }
        this._doSeekStep(stepDirection, true);
    }

    _byteReceived(isIndexPulsePositiveEdge) {
        const isMfm = this._isDoubleDensity(this._controlRegister);
        const isMarker = this._deliverIsMarker;
        const data = this._deliverData;
        this._deliverIsMarker = false;

        switch (this._state) {
            case State.searchId:
                if (!isMarker || data !== IbmDiscFormat.idMarkDataPattern) break;
                this._setState(State.inId);
                this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(isMfm), IbmDiscFormat.idMarkDataPattern);
                break;
            case State.inId:
                this._byteReceivedInId(data);
                break;
            case State.searchData:
                this._byteReceivedSearchData(data, isMarker);
                break;
            case State.inData:
                this._byteReceivedInData(data);
                break;
            case State.inReadTrack:
                if (!isIndexPulsePositiveEdge) {
                    this._sendDataToHost(data);
                } else {
                    this._commandDone(true);
                }
                break;
            default:
                throw new Error(`Bad state ${this._state}`);
        }
    }

    _byteReceivedInId(data) {
        const isReadAddress = this._command === Command.readAddress;
        switch (this._stateCount) {
            case 0:
                this._onDiscTrack = data;
                if (isReadAddress) {
                    // The datasheet says "The Track Address of the ID field is written into the sector register"
                    this._sectorRegister = data;
                }
                break;
            case 2:
                this._onDiscSector = data;
                break;
            case 3:
                // From http://info-coach.fr/atari/documents/_mydoc/WD1772-JLG.pdf, only the lower two bits affect anything.
                this._onDiscLength = 128 << (data & 0x03);
                break;
        }
        if (isReadAddress) {
            // Note that unlike the 8271, the CRC bytes are sent along too.
            this._sendDataToHost(data);
        }
        if (this._stateCount < 4) {
            this._crc = IbmDiscFormat.crcAddByte(this._crc, data);
        } else {
            this._onDiscCrc = ((this._onDiscCrc << 8) & 0xffff) | data;
        }
        if (++this._stateCount !== 6) return;

        const isCrcError = this._crc !== this._onDiscCrc;

        if (isReadAddress) {
            if (isCrcError) this._statusRegister |= Status.crcError;
            // Unlike the 8271, read address returns just a single record. It is also not synchronized
            // to the index pulse.
            // EMU TODO: it's likely that timing is generally off for most states,
            // i.e. the 1770 takes various numbers of internal clock cycles before it
            // delivers the CRC error, before it goes not busy, etc.
            // EMU NOTE: must not clear busy flag right away. The 1770 delivers the
            // last header byte DRQ separately from lowering the busy flag.
            this._setState(State.done);
            return;
        }

        // The data sheet specifies no CRC error unless the fields match so check those first.
        if (this._trackRegister !== this._onDiscTrack) {
            this._setState(State.searchId);
            return;
        }
        if (this._commandType === 2 && this._sectorRegister !== this._onDiscSector) {
            this._setState(State.searchId);
            return;
        }
        if (isCrcError) {
            this._statusRegister |= Status.crcError;
            // Unlike the 8271, the 1770 keeps going.
            this._setState(State.searchId);
            return;
        }
        if (this._commandType === 1) this._commandDone(true);
        else if (this._isCommandWrite) this._setState(State.writeSectorDelay);
        else this._setState(State.searchData);
    }

    _byteReceivedSearchData(data, isMarker) {
        this._stateCount++;
        const isMfm = this._isDoubleDensity(this._controlRegister);
        const multiplier = isMfm ? 2 : 1;
        // Like the 8271 the data mark is only recognized if 14 bytes have passed.
        // Unlike the 8271, it gives up after a while longer.
        if (this._stateCount < 14 * multiplier) return;
        if (this._stateCount > 31 * multiplier) {
            this._setState(State.searchId);
            return;
        }
        if (!isMarker) return;
        if (data === IbmDiscFormat.dataMarkDataPattern) {
            // Nothing...
        } else if (data === IbmDiscFormat.deletedDataMarkDataPattern) {
            // EMU NOTE: the datasheet is ambiguous on whether the deleted mark is
            // visible in the status register immediately, or at the end of a read.
            // The state machine diagram says "DAM in time" -> "Set Record Type in
            // Status Bit 5". But later on it says "At the end of the Read... is
            // recorded...".
            // Testing on @scarybeasts's 1772, the state machine diagram is correct: the bit is
            // visible in the status register immediately during the read.
            // EMU NOTE: on a multi-sector read, the deleted mark bit is set, and left
            // set, if _any_ deleted data sector was encountered. The datasheet would
            // seem to imply that only the most recent sector type is reflected in
            // the bit, but testing on @scarybeasts's 1772, the bit is set and left set even if
            // a non-deleted sector is encountered subsequently.
            this._statusRegister |= Status.typeIIorIIIDeletedMark;
        } else return;
        this._setState(State.inData);
        // CRC error is reset here. It's possible to hit a CRC error in a sector header and then find
        // an OK matching sector header.
        this._statusRegister &= ~Status.crcError;
        this._crc = IbmDiscFormat.crcAddByte(IbmDiscFormat.crcInit(isMfm), data);
    }

    _byteReceivedInData(data) {
        this._stateCount++;
        if (this._stateCount <= this._onDiscLength) {
            this._crc = IbmDiscFormat.crcAddByte(this._crc, data);
            this._sendDataToHost(data);
            return;
        } else if (this._stateCount <= this._onDiscLength + 2) {
            this._onDiscCrc = ((this._onDiscCrc << 8) & 0xffff) | data;
            return;
        }
        if (this._crc !== this._onDiscCrc) {
            this._statusRegister |= Status.crcError;
            // Sector data CRC error is terminal, even for a multi-sector read.
            this._commandDone(true);
            return;
        }
        this._setState(State.checkMulti);
    }

    _sendDataToHost(data) {
        if (this._commandType !== 2 && this._commandType !== 3) throw new Error("Bad command type");
        this._setDrq(true);
        this._dataRegister = data;
    }

    /// jsbeeb compatibility stuff TODO combine with the noise aware stuff?
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

export class NoiseAwareWdFdc extends WdFdc {
    // TODO: consider deduplicating with the IntelFdc equivalent.
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
