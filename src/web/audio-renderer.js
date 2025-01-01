/*global sampleRate, currentTime */

const lowPassFilterFreq = sampleRate / 2;
const RC = 1 / (2 * Math.PI * lowPassFilterFreq);

class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(...args) {
        super(...args);

        this.inputSampleRate = 4000000.0 / 8;
        this._lastSample = 0;
        this._lastFilteredOutput = 0;
        this.queue = [];
        this._queueSizeBytes = 0;
        this.dropped = 0;
        this.underruns = 0;
        this.targetLatencyMs = 1000 * (1 / 50); // One frame
        this.startQueueSizeBytes = this.inputSampleRate / this.targetLatencyMs / 2;
        this.running = false;
        this.maxQueueSizeBytes = this.inputSampleRate * 0.25;
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

    onBuffer(time, buffer) {
        this.queue.push({ offset: 0, time, buffer });
        this._queueSizeBytes += buffer.length;
        this.cleanQueue();
        if (!this.running && this._queueSizeBytes >= this.startQueueSizeBytes) this.running = true;
    }

    _shift() {
        const dropped = this.queue.shift();
        this._queueSizeBytes -= dropped.buffer.length;
    }

    cleanQueue() {
        const maxLatency = this.targetLatencyMs * 2;
        while (this._queueSizeBytes > this.maxQueueSizeBytes || this._queueAge() > maxLatency) {
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
        const outByMs = this._queueAge() - this.targetLatencyMs;
        const maxAdjust = this.inputSampleRate * 0.01;
        const adjustment = Math.min(maxAdjust, Math.max(-maxAdjust, outByMs * 100));
        const effectiveSampleRate = this.inputSampleRate + adjustment;
        const sampleRatio = effectiveSampleRate / sampleRate;

        const channel = outputs[0][0];
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
