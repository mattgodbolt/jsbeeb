/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */

const lowPassFilterFreq = sampleRate / 2;
const RC = 1 / (2 * Math.PI * lowPassFilterFreq);

const InputSampleRate = 4000000.0 / 8;
const MaxQueuedMs = 250;

const samplesFor = (ms) => (InputSampleRate * ms) / 1000;

// Rate control: proportional control on queue occupancy, smoothed to reject
// the producer's once-per-animation-frame burst pattern (issue #864). The
// loop's time constant is seconds (gain 0.2/s, the old controller's pole), so
// half a second of smoothing costs nothing in responsiveness. Proportional
// only, deliberately: occupancy already integrates any rate offset, so adding
// an integral term makes the loop second order (overshooting into underrun
// and settling in ~40 s at plausible gains), and the offset it would remove
// costs under a millisecond of static latency error at realistic clock skew.
// The authority is small: clock skew and the resampler's per-quantum rounding
// are both under 0.04%, and a slow loop with the old 1% clamp turned queue
// disturbances (a double burst, a dropped buffer) into pitch bends of several
// cents held for seconds. Anything the clamp cannot absorb, the queue does.
const OccupancySmoothingTau = 0.5;
const ProportionalGain = 0.2;
const MaxAdjust = InputSampleRate * 0.001;

class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(...args) {
        super(...args);

        this.inputSampleRate = InputSampleRate;
        this._lastSample = 0;
        this._lastFilteredOutput = 0;
        this.queue = [];
        this._queueSizeSamples = 0;
        this.dropped = 0;
        this.underruns = 0;
        this.targetLatencyMs = 1000 * (1 / 50); // One frame
        this.startQueueSizeSamples = samplesFor(this.targetLatencyMs);
        this.smoothedOccupancyError = 0;
        this.running = false;
        this.maxQueueSizeSamples = samplesFor(MaxQueuedMs);
        this.port.onmessage = (event) => {
            // TODO: even better than this, send over register settings/catch up and run the audio work _here_
            this.onBuffer(event.data.time, event.data.buffer);
        };
        this.nextStats = 0;
    }

    stats(sampleRatio) {
        if (currentTime < this.nextStats) return;
        this.nextStats = currentTime + 0.25;
        this.port.postMessage({
            sampleRate: sampleRate,
            inputSampleRate: this.inputSampleRate,
            dropped: this.dropped,
            underruns: this.underruns,
            queueSize: this.queue.length,
            queueAge: this._queueAge(),
            sampleRatio: sampleRatio,
        });
    }

    _queueAge() {
        if (this.queue.length === 0) return 0;
        const timeInBufferMs = 1000 * (this.queue[0].offset / this.inputSampleRate) + this.queue[0].time;
        return Date.now() - timeInBufferMs;
    }

    _occupancySamples() {
        return this._queueSizeSamples - (this.queue.length ? this.queue[0].offset : 0);
    }

    // Returns the resampling rate for one process() quantum of dtSeconds.
    // Occupancy needs no clock, unlike the queue age it replaced: the age
    // measurement stamped postMessage time rather than generation time (so it
    // carried the producer's burst sawtooth at full amplitude) and used the
    // non-monotonic Date.now().
    _effectiveSampleRate(dtSeconds) {
        const error = this._occupancySamples() - this.startQueueSizeSamples;
        const alpha = Math.min(1, dtSeconds / OccupancySmoothingTau);
        this.smoothedOccupancyError += alpha * (error - this.smoothedOccupancyError);
        const adjustment = ProportionalGain * this.smoothedOccupancyError;
        return this.inputSampleRate + Math.min(MaxAdjust, Math.max(-MaxAdjust, adjustment));
    }

    onBuffer(time, buffer) {
        this.queue.push({ offset: 0, time, buffer });
        this._queueSizeSamples += buffer.length;
        this.cleanQueue();
        if (!this.running && this._queueSizeSamples >= this.startQueueSizeSamples) this.running = true;
    }

    _shift() {
        const dropped = this.queue.shift();
        this._queueSizeSamples -= dropped.buffer.length;
    }

    cleanQueue() {
        const maxLatency = this.targetLatencyMs * 2;
        while (this._queueSizeSamples > this.maxQueueSizeSamples || this._queueAge() > maxLatency) {
            this._shift();
            this.dropped++;
        }
    }

    nextSample() {
        if (this.running && this.queue.length) {
            const queueElement = this.queue[0];
            this._lastSample = queueElement.buffer[queueElement.offset];
            if (++queueElement.offset === queueElement.buffer.length) this._shift();
        } else {
            this.underruns++;
            this.running = false;
        }
        return this._lastSample;
    }

    process(inputs, outputs) {
        this.cleanQueue();
        if (this.queue.length === 0) return true;

        // I looked into using https://www.npmjs.com/package/@alexanderolsen/libsamplerate-js or similar (the full API),
        // but we fiddle the sample rate here to catch up with the target latency, which is harder to do with that API.
        const channel = outputs[0][0];
        const effectiveSampleRate = this._effectiveSampleRate(channel.length / sampleRate);
        const sampleRatio = effectiveSampleRate / sampleRate;

        const dt = 1 / effectiveSampleRate;
        const filterAlpha = dt / (RC + dt);

        const numInputSamples = Math.round(sampleRatio * channel.length);
        const source = new Float32Array(numInputSamples);
        let prevSample = this._lastFilteredOutput;
        for (let i = 0; i < numInputSamples; ++i) {
            prevSample += filterAlpha * (this.nextSample() - prevSample);
            source[i] = prevSample;
        }
        this._lastFilteredOutput = prevSample;
        for (let i = 0; i < channel.length; i++) {
            const pos = (i + 0.5) * sampleRatio;
            const loc = Math.floor(pos);
            const alpha = pos - loc;
            channel[i] = source[loc] * (1 - alpha) + source[loc + 1] * alpha;
        }
        this.stats(sampleRatio);
        return true;
    }
}

registerProcessor("sound-chip-processor", SoundChipProcessor);
