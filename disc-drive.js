// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
// eslint-disable-next-line no-unused-vars
import { Disc, IbmDiscFormat } from "./disc.js";

export class DiscDrive {
    static get TicksPerRevolution() {
        // 300 rpm
        return 400000;
    }

    static get MaxDiscsPerDrive() {
        return 4;
    }

    // scarybeast's Chinon drive holds the index pulse low for about 4ms. */
    static get DiscIndexMs() {
        return 4;
    }

    /**
     *
     * @param id which drive id this is (0 or 1)
     * @param {Scheduler} scheduler scheduler to register callbacks etc
     */
    constructor(id, scheduler) {
        this._id = id;
        this._discIndex = 0;
        this._scheduler = scheduler;
        this._discs = [];
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
    }

    /**
     * @returns {Disc|undefined}
     */
    get disc() {
        return this._discs[this._discIndex];
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
            // TODO this is where we'd flush writes to the disc.
        }

        this._timer.schedule(nextTicks - thisTicks);
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
        this._headPosition = (this.trackLength * fraction)|0;
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
        return this._timer.scheduled();
    }

    startSpinning() {
        this._timer.schedule(1);
    }

    stopSpinning() {
        this._timer.cancel();
    }

    selectSide(isSideUpper) {
        const fraction = this.positionFraction;
        // TODO flush writes here
        this._isSideUpper = isSideUpper;
        this.positionFraction = fraction;
    }

    /**
     * @param {Disc} disc
     */
    addDisc(disc) {
        if (this._discs.length === DiscDrive.MaxDiscsPerDrive) throw new Error("Too many discs added");
        this._discs.push(disc);
    }

    get indexPulse() {
        // With no disc loaded the drive asserts the index all the time.
        if (!this.disc) return true;
        // The 8271 datasheet says that the index pulse must be held for over 0.5us. Most drives are in the milisecond range.
        return this._headPosition < (this.trackLength * DiscDrive.DiscIndexMs) / 200;
    }

    writePulses(pulses) {
        throw new Error(`Not supported: ${pulses}`);
    }

    get writeProtect() {
        return this.disc ? this.disc.writeProtect : false;
    }
}