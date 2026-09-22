// Translated from beebjit by Chris Evans.
// https://github.com/scarybeasts/beebjit
// eslint-disable-next-line no-unused-vars
import { Scheduler } from "./scheduler.js";
// eslint-disable-next-line no-unused-vars
import { Disc } from "./disc.js";
import { IbmDiscFormat } from "./disc.js";

const SpinDebounceMs = 2;
/**
 * The spindle motor of a 5.25" drive reaches speed about half a second after it starts (drive
 * sheets give 400 to 500 ms) and coasts to a stop over a second or so: time constants of the
 * exponentials below, in cycles. The disc never quite stands still here, or the pulses would.
 */
const SpinUpTicks = 150 * 2000;
const SpinDownTicks = 1000 * 2000;
const LeastSpeed = 0.02;
const AtSpeed = 0.9999;

/**
 * Plays the spin and seek noises for a set of drives.
 * @param {BaseDiscDrive[]} drives
 * @param {import("./ddnoise.js").DdNoise|import("./ddnoise.js").FakeDdNoise} ddNoise
 */
export function attachDriveNoise(drives, ddNoise) {
    let numSpinning = 0;
    const updateSpinStatus = () => {
        if (numSpinning) ddNoise.spinUp();
        else ddNoise.spinDown();
    };
    for (const drive of drives) {
        drive.addEventListener("startSpinning", () => {
            numSpinning++;
            setTimeout(updateSpinStatus, SpinDebounceMs);
        });
        drive.addEventListener("stopSpinning", () => {
            numSpinning--;
            setTimeout(updateSpinStatus, SpinDebounceMs);
        });
        drive.addEventListener("seekStart", (evt) => ddNoise.seekStart(evt.steps, evt.stepMs));
        drive.addEventListener("seekEnd", (evt) => ddNoise.seekEnd(evt.steps));
    }
}

/** The head is about to take `steps` steps, one every `stepMs`. */
class SeekEvent extends Event {
    constructor(steps, stepMs) {
        super("seekStart");
        this.steps = steps;
        this.stepMs = stepMs;
    }
}

/** The head has stopped after `steps` of the steps it was about to take. */
class SeekEndEvent extends Event {
    constructor(steps) {
        super("seekEnd");
        this.steps = steps;
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
    get isSideUpper() {
        throw new Error("Not implemented: isSideUpper getter");
    }

    /** @returns {Number} */
    get tracksPerStep() {
        throw new Error("Not implemented: tracksPerStep getter");
    }

    /** @param {Number} _tracksPerStep */
    set tracksPerStep(_tracksPerStep) {
        throw new Error("Not implemented: tracksPerStep setter");
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
    notifySeek(_newTrack, _stepMs) {
        throw new Error("Not implemented: notifySeek");
    }

    /**
     * @param {number} _delta
     */
    notifySeekAmount(_delta, _stepMs) {
        throw new Error("Not implemented: notifySeekAmount");
    }

    notifySeekEnd() {
        throw new Error("Not implemented: notifySeekEnd");
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
        // Two for a drive whose 40/80 switch is set to 40, which reaches a 48 tpi format by
        // stepping twice for each track the controller counts.
        this._tracksPerStep = 1;
        // Where the head is over the 96 tpi surface, whatever the controller believes.
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
        this._seekSteps = null;
        // Speed as a fraction of 300 rpm when the motor last started or stopped, and when.
        this._speedThen = 0;
        this._speedEpoch = 0;
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
        if (this._spinning) this._timer.reschedule(Math.round((nextTicks - thisTicks) / this.speed));
    }

    /** How fast the disc is turning, as a fraction of its rated speed. */
    get speed() {
        const elapsed = this._scheduler.epoch - this._speedEpoch;
        const speed = this._spinning
            ? 1 - (1 - this._speedThen) * Math.exp(-elapsed / SpinUpTicks)
            : this._speedThen * Math.exp(-elapsed / SpinDownTicks);
        return speed > AtSpeed ? 1 : Math.max(LeastSpeed, speed);
    }

    _noteSpeed() {
        this._speedThen = this.speed;
        this._speedEpoch = this._scheduler.epoch;
    }

    get headPosition() {
        return this._headPosition;
    }

    get track() {
        return this._track;
    }

    get isSideUpper() {
        return this._isSideUpper;
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
            this._noteSpeed();
            this._spinning = true;
            this.dispatchEvent(new Event("startSpinning"));
            this._timer.schedule(1);
        }
    }

    stopSpinning() {
        if (this._spinning) {
            this._noteSpeed();
            this._spinning = false;
            this.dispatchEvent(new Event("stopSpinning"));
        }
        this._timer.cancel();
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

    /** @returns {Number} how many of the surface's tracks the head crosses for one of the format's */
    get tracksPerStep() {
        return this._tracksPerStep;
    }

    set tracksPerStep(tracksPerStep) {
        if (tracksPerStep !== 1 && tracksPerStep !== 2)
            throw new Error(`Drives step over one or two tracks at a time, not ${tracksPerStep}`);
        this._tracksPerStep = tracksPerStep;
    }

    /** @returns {Number} the track the controller believes the head is on */
    get logicalTrack() {
        return (this._track / this._tracksPerStep) | 0;
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
        const from = this._track;
        this._selectTrack(this._track + delta * this._tracksPerStep);
        if (this._seekSteps !== null && this._track !== from) ++this._seekSteps;
    }

    /**
     * The controller is about to seek to `newTrack`, a step every `stepMs`. Purely
     * informational: the noise follows it.
     */
    notifySeek(newTrack, stepMs) {
        this.notifySeekAmount(newTrack - this.logicalTrack, stepMs);
    }

    /**
     * The controller is about to seek `delta` of its tracks, a step every `stepMs`. Purely
     * informational: the noise follows it.
     */
    notifySeekAmount(delta, stepMs) {
        // The noise counts the steps the head takes: none past either end of the surface,
        // whatever the controller asked for, and a last one onto the edge though it falls short.
        const lastTrack = IbmDiscFormat.tracksPerDisc - this._tracksPerStep;
        const target = Math.min(lastTrack, Math.max(0, this._track + delta * this._tracksPerStep));
        const steps = Math.sign(delta) * Math.ceil(Math.abs(target - this._track) / this._tracksPerStep);
        this._seekSteps = steps ? 0 : null;
        if (!steps) return;
        this.dispatchEvent(new SeekEvent(steps, stepMs));
    }

    /** The controller has finished stepping, whether or not it got as far as it said. */
    notifySeekEnd() {
        if (this._seekSteps === null) return;
        const steps = this._seekSteps;
        this._seekSteps = null;
        this.dispatchEvent(new SeekEndEvent(steps));
    }

    /**
     * @param {Number} track
     */
    _selectTrack(track) {
        this._checkTrackNeedsWrite();
        const lastTrack = IbmDiscFormat.tracksPerDisc - this._tracksPerStep;
        if (track < 0) {
            track = 0;
            console.log("Clang! disc head stopped at track 0");
        } else if (track > lastTrack) {
            track = lastTrack;
            console.log("Clang! disc head stopper at track max");
        }
        const fraction = this.positionFraction;
        this._track = track;
        this.positionFraction = fraction;
    }

    _checkTrackNeedsWrite() {
        if (!this.disc) return;
        const written = this.disc.flushWrites();
        // A 48 tpi head writes across most of its band but not as far as the neighbouring 96 tpi
        // track, which is left in the guard band with nothing readable on it.
        if (written && this._tracksPerStep === 2) this.disc.eraseTrack(written.isSideUpper, written.trackNum ^ 1);
    }

    snapshotState() {
        return {
            track: this._track,
            isSideUpper: this._isSideUpper,
            headPosition: this._headPosition,
            pulsePosition: this._pulsePosition,
            in32usMode: this._in32usMode,
            spinning: this._spinning,
            speed: this.speed,
            is40Track: this._tracksPerStep === 2,
            timerTaskOffset: this._timer.scheduled() ? this._timer.expireEpoch - this._scheduler.epoch : null,
            disc: this._disc ? this._disc.snapshotState() : null,
        };
    }

    restoreState(state) {
        this._seekSteps = null;
        this._track = state.track;
        this._isSideUpper = state.isSideUpper;
        this._headPosition = state.headPosition;
        this._pulsePosition = state.pulsePosition;
        this._in32usMode = state.in32usMode;
        this._tracksPerStep = state.is40Track ? 2 : 1;

        // Restore spinning state and timer
        this._timer.cancel();
        this._spinning = state.spinning;
        this._speedThen = state.speed ?? 1;
        this._speedEpoch = this._scheduler.epoch;
        if (state.timerTaskOffset !== null) this._timer.schedule(state.timerTaskOffset);

        // Restore disc data if present
        if (state.disc && this._disc) {
            this._disc.restoreState(state.disc);
        }
    }
}
