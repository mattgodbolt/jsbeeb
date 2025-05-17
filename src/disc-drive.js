// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
// eslint-disable-next-line no-unused-vars
import { Disc } from "./disc.js";
import { IbmDiscFormat } from "./disc.js";

class StepEvent extends Event {
    constructor(stepAmount) {
        super("step");
        this.stepAmount = stepAmount;
    }
}

/**
 * Abstract base class defining the interface for disc drives.
 * All disc drive implementations must extend this class.
 */
export class BaseDiscDrive extends EventTarget {
    /** @returns {Disc|undefined} */
    get disc() {
        throw new Error("Not implemented: disc getter");
    }

    /** @returns {number} */
    get track() {
        throw new Error("Not implemented: track getter");
    }

    /** @returns {number} */
    get headPosition() {
        throw new Error("Not implemented: headPosition getter");
    }

    /** @returns {boolean} */
    get indexPulse() {
        throw new Error("Not implemented: indexPulse getter");
    }

    /** @returns {boolean} */
    get spinning() {
        throw new Error("Not implemented: spinning getter");
    }

    /** @returns {boolean} */
    get writeProtect() {
        throw new Error("Not implemented: writeProtect getter");
    }

    /** @returns {number} */
    get trackLength() {
        throw new Error("Not implemented: trackLength getter");
    }

    /** @returns {number} */
    get positionFraction() {
        throw new Error("Not implemented: positionFraction getter");
    }

    /** @returns {number} */
    get positionTime() {
        throw new Error("Not implemented: positionTime getter");
    }

    /**
     * @param {Disc|undefined} _disc
     */
    setDisc(_disc) {
        throw new Error("Not implemented: setDisc");
    }

    /**
     * @param {function(number, number): void} _callback
     */
    setPulsesCallback(_callback) {
        throw new Error("Not implemented: setPulsesCallback");
    }

    startSpinning() {
        throw new Error("Not implemented: startSpinning");
    }

    stopSpinning() {
        throw new Error("Not implemented: stopSpinning");
    }

    /**
     * @param {boolean} _isSideUpper
     */
    selectSide(_isSideUpper) {
        throw new Error("Not implemented: selectSide");
    }

    /**
     * @param {number} _delta
     */
    seekOneTrack(_delta) {
        throw new Error("Not implemented: seekOneTrack");
    }

    /**
     * @param {number} _newTrack
     */
    notifySeek(_newTrack) {
        throw new Error("Not implemented: notifySeek");
    }

    /**
     * @param {number} _delta
     */
    notifySeekAmount(_delta) {
        throw new Error("Not implemented: notifySeekAmount");
    }

    /**
     * @param {boolean} _isDoubleDensity
     */
    set32usMode(_isDoubleDensity) {
        throw new Error("Not implemented: set32usMode");
    }

    /**
     * @param {number} _pulses
     */
    writePulses(_pulses) {
        throw new Error("Not implemented: writePulses");
    }

    /** @returns {number} */
    getQuasiRandomPulses() {
        throw new Error("Not implemented: getQuasiRandomPulses");
    }
}

export class DiscDrive extends BaseDiscDrive {
    static get TicksPerRevolution() {
        // 300 rpm
        return 400000;
    }

    // scarybeast's Chinon drive holds the index pulse low for about 4ms. */
    static get DiscIndexMs() {
        return 4;
    }

    /**
     * Create a new DiscDrive.
     *
     * @param {Number} id which drive id this is (0 or 1)
     * @param {Scheduler} scheduler scheduler to register callbacks etc
     */
    constructor(id, scheduler) {
        super();
        this._scheduler = scheduler;
        /** @type {Disc|undefined} */
        this._disc = undefined;
        this._is40Track = false;
        // Physically always 80 tracks even if we're in 40 track mode. 40 track mode essentially double steps.
        this._track = 0;
        this._isSideUpper = false;
        // In units where 3125 is a normal track length.
        this._headPosition = 0;
        // Extra precision for head position, needed for MFM.
        this._pulsePosition = 0;
        this._in32usMode = false;
        /** @type {function(number, number): void} */
        this._pulsesCallback = null;

        this._timer = this._scheduler.newTask(this._onTimer.bind(this));
        this._spinning = false;
    }

    /**
     * @returns {Disc|undefined}
     */
    get disc() {
        return this._disc;
    }

    getQuasiRandomPulses() {
        const ticks = this._scheduler.epoch;
        const fmData = (ticks ^ (ticks >>> 8) ^ (ticks >>> 16) ^ (ticks >>> 24)) & 0xff;
        return IbmDiscFormat.fmTo2usPulses(0xff, fmData);
    }

    get trackLength() {
        const disc = this.disc;
        if (!disc) return IbmDiscFormat.bytesPerTrack;
        return disc.getTrack(this._isSideUpper, this._track).length;
    }

    _onTimer() {
        let pulses = this.disc ? this.disc.readPulses(this._isSideUpper, this._track, this._headPosition) : 0;
        let numPulses = 32;
        if (this._pulsePosition === 16 || this._in32usMode) {
            numPulses = 16;
            if (this._pulsePosition === 0) pulses >>>= 16;
            pulses &= 0xffff;
        }

        // If there's an empty patch on the disc surface, the disc drive's head amplifier will typically desperately
        // seek for a signal in the noise, resulting in "weak bits". @scarybeasts verified this with an oscilloscope on
        // his Chinon F-051MD drive, which has a Motorola MC3470AP head amplifier. We need to return an inconsistent yet
        // deterministic set of weak bits.
        if (pulses === 0) pulses = this.getQuasiRandomPulses();

        if (this._pulsesCallback) {
            this._pulsesCallback(pulses, numPulses);
        }

        const thisTicks = this.positionTime;

        // Advance head position.
        if (numPulses === 16) {
            if (this._pulsePosition === 0) {
                this._pulsePosition = 16;
            } else {
                this._pulsePosition = 0;
                this._headPosition++;
            }
        } else {
            this._headPosition++;
        }

        const nextTicks = this.positionTime;

        if (this._headPosition === this.trackLength) {
            this._headPosition = 0;
            this._checkTrackNeedsWrite();
        }
        if (this._spinning) this._timer.reschedule(nextTicks - thisTicks);
    }

    get headPosition() {
        return this._headPosition;
    }

    get track() {
        return this._track;
    }

    get positionFraction() {
        return (this._headPosition + this._pulsePosition / 32) / this.trackLength;
    }

    set positionFraction(fraction) {
        this._headPosition = (this.trackLength * fraction) | 0;
        this._pulsePosition = 0;
    }

    get positionTime() {
        return (this.positionFraction * DiscDrive.TicksPerRevolution) | 0;
    }

    /**
     * @param {function(number, number): void} callback
     */
    setPulsesCallback(callback) {
        this._pulsesCallback = callback;
    }

    get spinning() {
        // beebjit uses the timer's scheduledness here, but our schedule system deschedules timers
        // during callbacks, which makes this briefly "false" and disturbs things.
        return this._spinning;
    }

    startSpinning() {
        if (!this._spinning) {
            this.dispatchEvent(new Event("startSpinning"));
            this._timer.schedule(1);
        }
        this._spinning = true;
    }

    stopSpinning() {
        if (this._spinning) {
            this.dispatchEvent(new Event("stopSpinning"));
        }
        this._timer.cancel();
        this._spinning = false;
    }

    selectSide(isSideUpper) {
        const fraction = this.positionFraction;
        this._checkTrackNeedsWrite();
        this._isSideUpper = isSideUpper;
        this.positionFraction = fraction;
    }

    /**
     * @param {Disc} disc
     */
    setDisc(disc) {
        this._disc = disc;
    }

    get indexPulse() {
        // With no disc loaded the drive asserts the index all the time.
        if (!this.disc) return true;
        // The 8271 datasheet says that the index pulse must be held for over 0.5us. Most drives are in the millisecond range.
        return this._headPosition < (this.trackLength * DiscDrive.DiscIndexMs) / 200;
    }

    writePulses(pulses) {
        if (!this.disc) return;
        // All drives seen have a write-protect failsafe on the drive itself.
        if (this.disc.writeProtected) return;
        if (this._in32usMode) {
            if (pulses & 0xffff0000) throw new Error(`Unable to write 32us pulses for ${pulses}`);
            const existingPulses = this.disc.readPulses(this._isSideUpper, this.track, this.headPosition);
            if (this._pulsePosition === 0) pulses = (existingPulses & 0x0000ffff) | (pulses << 16);
            else pulses = (existingPulses & 0xffff0000) | pulses;
        }
        this.disc.writePulses(this._isSideUpper, this.track, this.headPosition, pulses);
    }

    get writeProtect() {
        return this.disc ? this.disc.writeProtected : false;
    }

    set32usMode(isDoubleDensity) {
        this._in32usMode = isDoubleDensity;
    }

    /**
     * Seek a relative track.
     *
     * @param {Number} delta track step delta, either 1 or -1
     */
    seekOneTrack(delta) {
        if (this._is40Track) delta *= 2;
        this._selectTrack(this._track + delta);
    }

    /**
     * Notify that an overall seek is happening to a particular track. Purely informational.
     */
    notifySeek(newTrack) {
        this.notifySeekAmount(newTrack - this._track);
    }

    /**
     * Notify that an overall seek is happening by some delta smount. Purely informational.
     */
    notifySeekAmount(delta) {
        this.dispatchEvent(new StepEvent(delta));
    }

    /**
     * @param {Number} track
     */
    _selectTrack(track) {
        this._checkTrackNeedsWrite();
        if (track < 0) {
            track = 0;
            console.log("Clang! disc head stopped at track 0");
        } else if (track >= IbmDiscFormat.tracksPerDisc) {
            track = IbmDiscFormat.tracksPerDisc - 1;
            console.log("Clang! disc head stopper at track max");
        }
        const fraction = this.positionFraction;
        this._track = track;
        this.positionFraction = fraction;
    }

    _checkTrackNeedsWrite() {
        if (this.disc) this.disc.flushWrites();
    }
}
