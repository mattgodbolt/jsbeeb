/*global sampleRate, currentTime*/
// TODO webpack is broken
// TODO downsampling is atrocious
// TODO we still end up with 200ms of audio latency!
class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(...args) {
        super(...args);

        this.inputSampleRate = 4000000.0 / 8;
        this._lastSample = 0;
        this.queue = [];
        this._queueSizeBytes = 0;
        this.dropped = 0;
        this.underruns = 0;
        this.startQueueSizeBytes = this.inputSampleRate * 0.05;
        this.running = false;
        this.maxQueueSizeBytes = this.inputSampleRate * 0.25;
        this.port.onmessage = (event) => {
            this.onBuffer(event.data.time, event.data.buffer);
        };
        this.nextStats = 0;
    }

    stats() {
        if (currentTime < this.nextStats) return;
        this.nextStats = currentTime + 5;
        console.log("sample ratio", this.inputSampleRate / sampleRate);
        console.log("dropped", this.dropped);
        console.log("underrun", this.underruns);
        console.log("queue size", this.queue.length);
        console.log("queue age", this.queue.length ? Date.now() - this.queue[0].time : "none");
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
        while (this._queueSizeBytes > this.maxQueueSizeBytes) {
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

        const sampleRatio = this.inputSampleRate / sampleRate;

        const channel = outputs[0][0];
        let pos = 0;
        for (let i = 0; i < channel.length; i++) {
            const loc = ((i+1) * sampleRatio)|0;
            const num = loc - pos;
            pos += num;
            let total = 0;
            for (let j = 0; j < num; ++j)
                total += this.nextSample();
            channel[i] = total / num;
        }
        this.stats();
        return true;
    }
}

registerProcessor('sound-chip-processor', SoundChipProcessor);
export default SoundChipProcessor;
