// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Cpu6502 } from "./6502.js";
import { DiscDrive } from "./disc-drive.js";
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";

/**
 * Controller sate.
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
 * Timer sate.
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

        this._state = State.idle;
        this._timerState = TimerState.none;
        this._timerTask = scheduler.newTask(() => this._timerFired());

        this._logCommands = debugFlags ? !!debugFlags.logFdcCommands : false;
        this._logStateChanges = debugFlags ? !!debugFlags.logFdcStateChanges : false;

        this.powerOnReset();
    }

    reset() {}
    powerOnReset() {}

    _log(message) {
        console.log(`WD1770: ${message}`);
    }

    _logCommand(message) {
        if (this._logCommands) this._log(message);
    }

    /**
     * @param {Number} addr hardware address
     * @returns {Number} byte at the given hardware address
     */
    read(addr) {}

    /**
     * @param {Number} addr hardware address
     * @param {Number} val byte to write
     */
    write(addr, val) {}

    _timerFired() {}
}
