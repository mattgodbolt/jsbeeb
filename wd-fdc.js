// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502.js";
import { DiscDrive } from "./disc-drive.js";
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
     * @param {DiscDrive[] | undefined} drives
     * @param {*} debugFlags
     */
    constructor(cpu, scheduler, drives, debugFlags) {
        this._cpu = cpu;
        if (drives) this._drives = drives;
        else this._drives = [new DiscDrive(0, scheduler), new DiscDrive(1, scheduler)];

        this._isMaster = cpu.model.isMaster;
        this._is1772 = false; // TODO
        this._isOpus = false; // TODO

        this._controlRegister = 0;
        /** @type {Status|Number} */
        this._statusRegister = 0;
        this._trackRegister = 0;
        this._sectorRegister = 0;
        this._dataRegister = 0;
        this._isIntRq = false;
        this._isDrq = false;
        this._doRaiseIntRq = false;

        /** @type {DiscDrive|null} */
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
        this._markDetector = 0;
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
        const newLevel = this._isDrq | (this._isOpus ? this._isIntRq : false);
        // TODO: the cpu handling of NMIs is bad here. Should update to handle multiple
        // NMI/interrupt sources. And when we do go back and implement the checks in the beebjit
        // source here too.
        this._cpu.nmi(newLevel);
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
            if (this._statusRegister & Status.typeIIorIIIDrq) this._statusRegister |= Status.typeIIorIIILostByte;
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

    /**
     * @param {Number} addr hardware address
     * @returns {Number} byte at the given hardware address
     */
    read(addr) {
        const regAddr = this._isOpus ? this._opusRemapAddr(addr & 0x07) : addr & 0x07;
        switch (regAddr) {
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
        addr &= 0x07;
        if (this._isMaster) {
            val = this._masterRemapVal(addr, val);
        } else if (this._isOpus) {
            addr = this._opusRemapAddr(addr);
            val = this._opusRemapVal(addr, val);
        }
        switch (addr) {
            case 0:
            case 1:
            case 2:
            case 3:
                this._logCommand(`control register now ${utils.hexbyte(val)};`);
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
                this._trackRegister = val;
                break;
            case 6:
                // Ignore sector reg changes in reset; note that track/data registers will still be accepted.
                if (!this._isReset(this._controlRegister)) this._sectorRegister = val;
                break;
            case 7:
                if (this._commandType === 2 || this._commandType === 3) this._setDrq(false);
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
        const command = val & 0x80;

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
            this._command == Command.writeSectorMulti ||
            this._command == Command.writeTrack
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
        this._statusRegister &= ~Status.motorOn;
        this._statusRegister |= Status.busy;

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
        //////////////
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

            this._markDetector = 0;
            this._dataShifter = 0;
            this._dataShiftCount = 0;
            this._isIndexPulse = false;
            this._lastMfmBit = false;
            this._deliverData = 0;
            this._deliverIsMarker = false;
        }
    }
}
