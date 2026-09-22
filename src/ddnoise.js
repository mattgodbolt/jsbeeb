import { SamplePlayer } from "./sample-player.js";

const Idle = 0;
const SpinUp = 1;
const Spinning = 2;
const Volume = 0.25;
/** Up to this many tracks of the surface is one click of the head; more is a run. */
const ClickTracks = 2;
/**
 * seek3.wav is a drive stepping at the 8271's 24 ms a track. Where its first click begins and
 * how far apart they come were fitted across the file's clicks, so a grain cut on that grid
 * holds one click; a run is such grains at the controller's own step rate.
 */
const RunFirstClickSeconds = 0.0085;
const RunClickSeconds = 0.024209;
const RunClicks = 74;
const GrainLeadSeconds = 0.002;
const GrainFadeSeconds = 0.002;
/** Where step.wav's burst gives way to its ring: what a run's last click leaves behind. */
const SettleOffsetSeconds = 0.024;

export class DdNoise extends SamplePlayer {
    constructor(context, destination) {
        super(context, destination, Volume);
        this.state = Idle;
        this.motor = null;
        this.run = null;
    }

    async initialise() {
        await this.loadSounds({
            motorOn: "sounds/disc525/motoron.wav",
            motorOff: "sounds/disc525/motoroff.wav",
            motor: "sounds/disc525/motor.wav",
            step: "sounds/disc525/step.wav",
            seek3: "sounds/disc525/seek3.wav",
        });
    }

    spinUp() {
        if (this.state === Spinning || this.state === SpinUp) return;
        this.state = SpinUp;
        this.play(this.sounds.motorOn).then(
            () => {
                // Handle race: we may have had spinDown() called on us before the
                // spinUp() initial sound finished playing.
                if (this.state === Idle) return;
                this.play(this.sounds.motor, true).then((source) => {
                    this.motor = source;
                    this.state = Spinning;
                });
            },
            () => {},
        );
    }

    spinDown() {
        if (this.state === Idle) return;
        this.state = Idle;
        if (this.motor) {
            this.motor.stop();
            this.motor = null;
            this.oneShot(this.sounds.motorOff);
        }
    }

    /**
     * The head is about to cross `tracks` tracks, one every `stepMs`: a click for a step or
     * two, otherwise a run of clicks scheduled on the audio clock at that rate, with the
     * click's ring as the settle after the last. Nothing here waits to see what arrives.
     */
    seekStart(tracks, stepMs) {
        if (tracks < 0) tracks = -tracks;
        if (tracks === 0) return;
        this.cancelRun();
        if (tracks <= ClickTracks) {
            this.oneShot(this.sounds.step);
            return;
        }
        const now = this.context.currentTime;
        const stepSeconds = stepMs / 1000;
        const grains = [];
        for (let track = 0; track < tracks; ++track) {
            const at = now + track * stepSeconds;
            const click = Math.floor(Math.random() * RunClicks);
            const source = this.startSound(this.sounds.seek3, {
                when: at,
                offset: RunFirstClickSeconds + click * RunClickSeconds - GrainLeadSeconds,
                duration: RunClickSeconds,
                fadeSeconds: GrainFadeSeconds,
            });
            if (source) grains.push({ source, at });
        }
        const settle = this.startSound(this.sounds.step, {
            when: now + tracks * stepSeconds,
            offset: SettleOffsetSeconds,
        });
        this.run = { grains, settle };
    }

    /** The head has stopped, early if the controller found track 0 or the surface's end first. */
    seekEnd() {
        if (this.cancelRun()) this.startSound(this.sounds.step, { offset: SettleOffsetSeconds });
    }

    /** Stops the grains of a run that have not yet sounded; true if there were any. */
    cancelRun() {
        if (!this.run) return false;
        const { grains, settle } = this.run;
        this.run = null;
        const now = this.context.currentTime;
        const unstarted = grains.filter((grain) => grain.at > now);
        if (unstarted.length === 0) return false;
        for (const grain of unstarted) grain.source.stop();
        settle?.stop();
        return true;
    }
}

export class FakeDdNoise {
    seekStart() {}
    seekEnd() {}
    initialise() {
        return Promise.resolve();
    }
    spinUp() {}
    spinDown() {}
    mute() {}
    unmute() {}
}
