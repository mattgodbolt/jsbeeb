// Between a bursty producer and an audio worklet's steady reads: an underrun
// plays silence and waits for targetFrames again; a lapping writer drops the oldest.
export class StereoRing {
    constructor(capacityFrames, { targetFrames, excessFrames, persistentExcessFrames }) {
        this.capacityFrames = capacityFrames;
        this.excessFrames = excessFrames;
        this.persistentExcessFrames = persistentExcessFrames;
        this.frames = new Float32Array(capacityFrames * 2);
        this.readFrame = 0;
        this.occupancy = 0;
        this.running = false;
        this.setTargetFrames(targetFrames);
    }

    setTargetFrames(targetFrames) {
        this.targetFrames = targetFrames;
        this.excessRunFrames = 0;
    }

    write(interleaved, scale = 1) {
        const count = interleaved.length >> 1;
        let writeFrame = (this.readFrame + this.occupancy) % this.capacityFrames;
        for (let i = 0; i < count; ++i) {
            this.frames[2 * writeFrame] = interleaved[2 * i] * scale;
            this.frames[2 * writeFrame + 1] = interleaved[2 * i + 1] * scale;
            if (++writeFrame === this.capacityFrames) writeFrame = 0;
        }
        this.occupancy += count;
        if (this.occupancy > this.capacityFrames) this._discard(this.occupancy - this.capacityFrames);
    }

    read(left, right) {
        if (!this.running) {
            if (this.occupancy >= this.targetFrames) this._restart();
        } else {
            this._skipPersistentExcess(left.length);
        }
        let played = 0;
        if (this.running) {
            played = Math.min(left.length, this.occupancy);
            for (let i = 0; i < played; ++i) {
                left[i] = this.frames[2 * this.readFrame];
                right[i] = this.frames[2 * this.readFrame + 1];
                if (++this.readFrame === this.capacityFrames) this.readFrame = 0;
            }
            this.occupancy -= played;
            if (played < left.length) this.running = false;
        }
        left.fill(0, played);
        right.fill(0, played);
    }

    // A producer catching up after an underrun refills in one burst; the
    // excess goes here, where the output is already discontinuous.
    _restart() {
        this._discard(Math.max(0, this.occupancy - this.targetFrames));
        this.excessRunFrames = 0;
        this.running = true;
    }

    _skipPersistentExcess(frames) {
        const excess = this.occupancy > this.targetFrames + this.excessFrames;
        this.excessRunFrames = excess ? this.excessRunFrames + frames : 0;
        if (this.excessRunFrames >= this.persistentExcessFrames) this._restart();
    }

    _discard(count) {
        this.readFrame = (this.readFrame + count) % this.capacityFrames;
        this.occupancy -= count;
    }
}
