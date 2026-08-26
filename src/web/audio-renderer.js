/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */

const lowPassFilterFreq = sampleRate / 2;
const RC = 1 / (2 * Math.PI * lowPassFilterFreq);

const InputSampleRate = 4000000.0 / 8;
const MaxQueuedMs = 250;

const samplesFor = (ms) => (InputSampleRate * ms) / 1000;

// Smoothing rejects the producer's per-frame bursts; proportional only, as
// occupancy already integrates rate error; 0.05% authority covers clock skew
// without audibly bending pitch.
const OccupancySmoothingTau = 0.5;
const ProportionalGain = 0.2;
const MaxAdjust = InputSampleRate * 0.0005;

class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(...args) {
        super(...args);

        this.inputSampleRate = InputSampleRate;
        this._lastSample = 0;
        this._lastFilteredOutput = 0;
        this._phase = 0;
        this._source = new Float32Array(0);
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
        let dropped = 0;
        while (this._queueSizeSamples > this.maxQueueSizeSamples || this._queueAge() > maxLatency) {
            this._shift();
            dropped++;
        }
        if (dropped) {
            this.dropped += dropped;
            this._notify("dropped", dropped);
        }
    }

    _notify(event, count) {
        this.port.postMessage({
            event,
            count,
            time: currentTime,
            occupancyMs: 1000 * (this._occupancySamples() / this.inputSampleRate),
        });
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
        if (this.queue.length === 0) return true;

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
        for (let i = 1; i <= numInputSamples; ++i) {
            prevSample += filterAlpha * (this.nextSample() - prevSample);
            source[i] = prevSample;
        }
        this._lastFilteredOutput = prevSample;
        for (let i = 0; i < channel.length; i++) {
            const pos = this._phase + i * sampleRatio;
            const loc = Math.floor(pos);
            const alpha = pos - loc;
            channel[i] = source[loc] * (1 - alpha) + source[loc + 1] * alpha;
        }
        this._phase = end - numInputSamples;
        this.stats(sampleRatio);
        return true;
    }
}

registerProcessor("sound-chip-processor", SoundChipProcessor);
