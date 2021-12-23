/*global sampleRate, currentTime*/
// TODO downsampling is atrocious
// TODO we still end up with 200ms of audio latency!
// Imports don't work here as the importScripts magic that webpack does doesn't work.
class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(...args) {
        super(...args);
        
        this.inputSampleRate = 4000000.0 / 8;
        this._lastSample = 0;
        this.queue = [];
        this._queueSizeBytes = 0;
        this.dropped = 0;
        this.underruns = 0;
        this.targetLatencyMs = 1000 * (2 / 50); // Two frames
        this.startQueueSizeBytes = (this.inputSampleRate / this.targetLatencyMs) / 2;
        this.running = false;
        this.maxQueueSizeBytes = this.inputSampleRate * 0.25;
        this.port.onmessage = (event) => {
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
        this.queue.push({offset: 0, time, buffer});
        this._queueSizeBytes += buffer.length;
        this.cleanQueue();
        if (!this.running && this._queueSizeBytes >= this.startQueueSizeBytes)
            this.running = true;
    }

    _shift() {
        const dropped = this.queue.shift();
        this._queueSizeBytes -= dropped.buffer.length;
    }

    cleanQueue() {
        const maxLatency = this.targetLatencyMs * 2
        while (this._queueSizeBytes > this.maxQueueSizeBytes || this._queueAge() > maxLatency) {
            this._shift();
            this.dropped++;
        }
    }

    nextSample() {
        if (this.running && this.queue.length) {
            const queueElement = this.queue[0];
            this._lastSample = queueElement.buffer[queueElement.offset];
            if (++queueElement.offset === queueElement.buffer.length)
                this._shift();
        } else {
            this.underruns++;
            this.running = false;
        }
        return this._lastSample;
    }

    process(inputs, outputs) {
        this.cleanQueue();
        if (this.queue.length === 0) return true;

        const outByMs = this._queueAge() - this.targetLatencyMs;
        const maxAdjust = this.inputSampleRate * 0.01;
        const adjustment = Math.min(maxAdjust, Math.max(-maxAdjust, outByMs * 100));
        const effectiveSampleRate = this.inputSampleRate + adjustment;
        const sampleRatio = effectiveSampleRate / sampleRate;

        const channel = outputs[0][0];
        let pos = 0;
        for (let i = 0; i < channel.length; i++) {
            const loc = ((i + 1) * sampleRatio) | 0;
            const num = loc - pos;
            pos += num;
            let total = 0;
            for (let j = 0; j < num; ++j)
                total += this.nextSample();
            channel[i] = total / num;
        }
        this.stats(sampleRatio);
        return true;
    }
}

registerProcessor('sound-chip-processor', SoundChipProcessor);
export default SoundChipProcessor;
