/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */

const lowPassFilterFreq = sampleRate / 2;
const RC = 1 / (2 * Math.PI * lowPassFilterFreq);

const InputSampleRate = 4000000.0 / 8;
const MaxQueuedMs = 500;
const DefaultTargetLatencyMs = 1000 * (1 / 50); // One frame
// Leaves room above the target for the producer's catch-up bursts.
const MaxTargetLatencyMs = MaxQueuedMs / 2;

const samplesFor = (ms) => (InputSampleRate * ms) / 1000;

// Smoothing rejects the producer's per-frame bursts; proportional only, as
// occupancy already integrates rate error; 0.05% authority covers clock skew
// without audibly bending pitch.
const OccupancySmoothingTau = 0.5;
const ProportionalGain = 0.2;
const MaxAdjust = InputSampleRate * 0.0005;

// An underrun holds the last sample and fades it out; the restart fades the
// new audio in. Long enough to take the click out of the step, short enough
// to hide inside the gap.
const FadeSeconds = 0.001;
const GainStep = 1 / (sampleRate * FadeSeconds);

class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);

        this.inputSampleRate = InputSampleRate;
        this._lastSample = 0;
        this._lastFilteredOutput = 0;
        this._phase = 0;
        this._gain = 0;
        this._source = new Float32Array(0);
        this.queue = [];
        this._queueSizeSamples = 0;
        this.dropped = 0;
        this.underruns = 0;
        this.setTargetLatency(options?.processorOptions?.targetLatencyMs);
        this.minOccupancySamples = Infinity;
        this.running = false;
        this.maxQueueSizeSamples = samplesFor(MaxQueuedMs);
        this.port.onmessage = (event) => {
            if (event.data.command === "setTargetLatency") this.setTargetLatency(event.data.targetLatencyMs);
            // TODO: even better than this, send over register settings/catch up and run the audio work _here_
            else this.onBuffer(event.data.time, event.data.buffer);
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
            queueMinMs: (1000 * this.minOccupancySamples) / this.inputSampleRate,
            sampleRatio: sampleRatio,
        });
        this.minOccupancySamples = Infinity;
    }

    _queueAge() {
        if (this.queue.length === 0) return 0;
        const timeInBufferMs = 1000 * (this.queue[0].offset / this.inputSampleRate) + this.queue[0].time;
        return Date.now() - timeInBufferMs;
    }

    _occupancySamples() {
        return this._queueSizeSamples - (this.queue.length ? this.queue[0].offset : 0);
    }

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
    }

    _shift() {
        const dropped = this.queue.shift();
        this._queueSizeSamples -= dropped.buffer.length;
    }

    _drop(count) {
        for (let i = 0; i < count; ++i) this._shift();
        this.dropped += count;
        this._notify("drop", count);
    }

    cleanQueue() {
        let dropped = 0;
        for (let size = this._queueSizeSamples; size > this.maxQueueSizeSamples; ++dropped)
            size -= this.queue[dropped].buffer.length;
        if (dropped) this._drop(dropped);
    }

    // The queue refills after an underrun in one catch-up burst, which has all
    // arrived by the next quantum; the excess is trimmed here, where the output
    // is already discontinuous.
    _restart() {
        let dropped = 0;
        for (let occupancy = this._occupancySamples(); dropped < this.queue.length - 1; ++dropped) {
            const head = this.queue[dropped];
            const without = occupancy - (head.buffer.length - head.offset);
            if (without < this.startQueueSizeSamples) break;
            occupancy = without;
        }
        if (dropped) this._drop(dropped);
        this.running = true;
    }

    _notify(event, count) {
        this.port.postMessage({ event, count });
    }

    setTargetLatency(ms) {
        const valid = Number.isFinite(ms) && ms > 0;
        this.targetLatencyMs = valid ? Math.min(ms, MaxTargetLatencyMs) : DefaultTargetLatencyMs;
        this.startQueueSizeSamples = samplesFor(this.targetLatencyMs);
        this.smoothedOccupancyError = 0;
    }

    nextSample() {
        if (this.running && this.queue.length) {
            const queueElement = this.queue[0];
            this._lastSample = queueElement.buffer[queueElement.offset];
            if (++queueElement.offset === queueElement.buffer.length) this._shift();
        } else if (this.running) {
            this.running = false;
            this.underruns++;
            this._notify("underrun", 1);
        }
        return this._lastSample;
    }

    process(inputs, outputs) {
        this.cleanQueue();
        if (!this.running && this._queueSizeSamples >= this.startQueueSizeSamples) this._restart();

        // I looked into using https://www.npmjs.com/package/@alexanderolsen/libsamplerate-js or similar (the full API),
        // but we fiddle the sample rate here to catch up with the target latency, which is harder to do with that API.
        const channel = outputs[0][0];
        const effectiveSampleRate = this._effectiveSampleRate(channel.length / sampleRate);
        const sampleRatio = effectiveSampleRate / sampleRate;

        const dt = 1 / effectiveSampleRate;
        const filterAlpha = dt / (RC + dt);

        // The fractional read position carries across quanta, so consumption
        // averages exactly sampleRatio and the pitch never steps at a rounding
        // boundary. source[0] is the last input sample of the previous quantum.
        const end = this._phase + channel.length * sampleRatio;
        const numInputSamples = Math.floor(end);
        if (this._source.length <= numInputSamples) this._source = new Float32Array(numInputSamples * 2);
        const source = this._source;
        source[0] = this._lastFilteredOutput;
        let prevSample = this._lastFilteredOutput;
        // The input position from which the queue was dry, so the fade starts
        // there rather than at the top of the quantum.
        let dryFrom = this.running ? Infinity : 0;
        for (let i = 1; i <= numInputSamples; ++i) {
            prevSample += filterAlpha * (this.nextSample() - prevSample);
            source[i] = prevSample;
            if (!this.running && dryFrom === Infinity) dryFrom = i;
        }
        this._lastFilteredOutput = prevSample;
        let gain = this._gain;
        for (let i = 0; i < channel.length; i++) {
            const pos = this._phase + i * sampleRatio;
            const loc = Math.floor(pos);
            const alpha = pos - loc;
            gain = pos < dryFrom ? Math.min(1, gain + GainStep) : Math.max(0, gain - GainStep);
            channel[i] = (source[loc] * (1 - alpha) + source[loc + 1] * alpha) * gain;
        }
        this._gain = gain;
        this._phase = end - numInputSamples;
        this.minOccupancySamples = Math.min(this.minOccupancySamples, this._occupancySamples());
        this.stats(sampleRatio);
        return true;
    }
}

registerProcessor("sound-chip-processor", SoundChipProcessor);
